import { ROOM_ACTIONS_SCHEMA } from './roomActionsSchema.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from './postgres.js'

// The pilot holds the exclusive lock. Fenced workers share the same lock so
// even an older pilot cannot start against their database.
export async function initializePostgresRooms(failover: boolean, catalogEnabled = false): Promise<void> {
  try {
    const client = await getPostgresPool().connect()
    try {
      const lock = failover ? 'pg_try_advisory_lock_shared' : 'pg_try_advisory_lock'
      const result = await client.query<{ acquired: boolean }>(`SELECT ${lock}(17407, 115) AS acquired`)
      if (!result.rows[0]?.acquired) {
        throw new RoomProcessAlreadyRunningError()
      }
      await inPostgresTransaction(async (migration) => {
        await migration.query('SELECT pg_advisory_xact_lock(17407, 120)')
        await migration.query(`
        CREATE TABLE IF NOT EXISTS characters (
          id TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          sheet TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS characters_user_updated ON characters (user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS rooms (
          room_id TEXT PRIMARY KEY,
          owner_id BIGINT NOT NULL REFERENCES users(id),
          invite_code TEXT NOT NULL UNIQUE,
          story_id TEXT,
          story_owner_id BIGINT REFERENCES users(id),
          kind TEXT NOT NULL CHECK (kind IN ('multi', 'solo')),
          phase TEXT NOT NULL CHECK (phase IN ('lobby', 'playing', 'ended')),
          state TEXT NOT NULL,
          version BIGINT NOT NULL DEFAULT 0,
          updated_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL
        );
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS story_preparation_revision UUID;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS story_source_revision UUID;
        CREATE TABLE IF NOT EXISTS room_members (
          room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(id),
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          character_id TEXT REFERENCES characters(id),
          ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
          join_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
          PRIMARY KEY (room_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS room_members_user_room ON room_members (user_id, room_id);
        CREATE INDEX IF NOT EXISTS room_members_room_join ON room_members (room_id, join_order);
        ${ROOM_ACTIONS_SCHEMA}
      `)
        if (failover) {
          await migration.query(ROOM_WORKER_SCHEMA)
          await migration.query(`
            SELECT worker_id, worker_epoch, worker_expires_at FROM rooms LIMIT 0;
            SELECT room_id, turn_id, epoch, action_keys, outcome, first_event_seq, last_event_seq FROM room_turns LIMIT 0;
            SELECT room_id, seq, event_type, payload FROM room_events LIMIT 0;
            SELECT room_id, seq, created_at FROM room_event_outbox LIMIT 0;
          `)
        }
        await migration.query(`
        SELECT room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, version, updated_at, created_at, story_preparation_revision, story_source_revision FROM rooms LIMIT 0;
        SELECT room_id, user_id, role, character_id, ready, join_order FROM room_members LIMIT 0;
        SELECT id, user_id, name, sheet, updated_at FROM characters LIMIT 0;
        SELECT room_id, user_id, action_id, payload_hash, message_id, status FROM room_actions LIMIT 0;
      `)
        if (catalogEnabled) {
          await migration.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS story_preparation_revision_owner_scope
            ON story_preparation_revisions (revision, owner_id, story_id, source_revision);
            DO $$
            BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'rooms'::regclass AND conname = 'rooms_retained_story_revision') THEN
                ALTER TABLE rooms ADD CONSTRAINT rooms_retained_story_revision
                  FOREIGN KEY (story_preparation_revision, story_owner_id, story_id, story_source_revision)
                  REFERENCES story_preparation_revisions (revision, owner_id, story_id, source_revision);
                ALTER TABLE rooms ADD CONSTRAINT rooms_story_revision_pair CHECK (
                  (story_preparation_revision IS NULL AND story_source_revision IS NULL)
                  OR (story_preparation_revision IS NOT NULL AND story_source_revision IS NOT NULL
                    AND story_owner_id IS NOT NULL AND story_id IS NOT NULL)
                );
              END IF;
            END $$;
          `)
        }
      })
      // Losing the startup guard ends the gameplay process. A worker could
      // otherwise resume alongside an exclusive single-process pilot.
      client.on('error', () => process.exit(1))
      client.on('end', () => process.exit(1))
    } catch (error) {
      // Destroying the connection also releases any acquired session lock.
      client.release(true)
      throw error
    }
  } catch (error) {
    if (error instanceof RoomProcessAlreadyRunningError) throw error
    throw postgresError(error)
  }
}

class RoomProcessAlreadyRunningError extends Error {
  constructor() {
    super('Another gameplay process already holds the PostgreSQL room lock')
  }
}

const ROOM_WORKER_SCHEMA = `
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS worker_id UUID;
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS worker_epoch BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS worker_expires_at TIMESTAMPTZ;

  CREATE TABLE IF NOT EXISTS room_turns (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    epoch BIGINT NOT NULL,
    action_keys JSONB NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled')),
    first_event_seq BIGINT,
    last_event_seq BIGINT,
    PRIMARY KEY (room_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS room_events (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (room_id, seq)
  );
  CREATE TABLE IF NOT EXISTS room_event_outbox (
    room_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (room_id, seq),
    FOREIGN KEY (room_id, seq) REFERENCES room_events (room_id, seq) ON DELETE CASCADE
  );
`

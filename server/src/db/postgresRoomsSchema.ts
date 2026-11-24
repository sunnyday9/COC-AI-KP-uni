import { ROOM_ACTIONS_SCHEMA } from './roomActionsSchema.js'
import { getPostgresPool, postgresError } from './postgres.js'

/**
 * Hold a database-scoped session lock for the lifetime of the only gameplay
 * process. This staging guard does not authorize multi-host workers.
 */
export async function initializeSingleProcessRooms(): Promise<void> {
  try {
    const client = await getPostgresPool().connect()
    try {
      const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(17407, 115) AS acquired')
      if (!result.rows[0]?.acquired) {
        throw new RoomProcessAlreadyRunningError()
      }
      await client.query(`
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
      await client.query(`
        SELECT room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, version, updated_at, created_at FROM rooms LIMIT 0;
        SELECT room_id, user_id, role, character_id, ready, join_order FROM room_members LIMIT 0;
        SELECT id, user_id, name, sheet, updated_at FROM characters LIMIT 0;
        SELECT room_id, user_id, action_id, payload_hash, message_id, status FROM room_actions LIMIT 0;
      `)
      // Losing the guard connection ends the gameplay process. Reconnecting
      // without the in-memory registry would permit competing room writers.
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

import type { DatabaseSync } from 'node:sqlite'

interface SchemaMigration {
  version: number
  name: string
  up(database: DatabaseSync): void
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return columns.some((entry) => entry.name === column)
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  }
}

const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: 'create core tables',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          user_id INTEGER PRIMARY KEY,
          data TEXT NOT NULL
        );
        -- saves and scripts were retired with their API and are intentionally
        -- not recreated in fresh databases or migrated as dead tables.
        CREATE TABLE IF NOT EXISTS stories (
          user_id INTEGER NOT NULL,
          story_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, story_id)
        );
        -- rag_index files live outside SQLite; the retired table is not recreated.
        CREATE TABLE IF NOT EXISTS rooms (
          room_id TEXT PRIMARY KEY,
          owner_id INTEGER NOT NULL,
          invite_code TEXT NOT NULL UNIQUE,
          story_id TEXT,
          phase TEXT NOT NULL DEFAULT 'lobby',
          state TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS characters (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          sheet TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_members (
          room_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          character_id TEXT,
          PRIMARY KEY (room_id, user_id)
        );
      `)
    },
  },
  {
    version: 2,
    name: 'add stories.file_path',
    up(database) {
      addColumnIfMissing(database, 'stories', 'file_path', "file_path TEXT NOT NULL DEFAULT ''")
    },
  },
  {
    version: 3,
    name: 'add rooms.kind',
    up(database) {
      addColumnIfMissing(database, 'rooms', 'kind', "kind TEXT NOT NULL DEFAULT 'multi'")
    },
  },
  {
    version: 4,
    name: 'add room_members.ready',
    up(database) {
      addColumnIfMissing(database, 'room_members', 'ready', 'ready INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    version: 5,
    name: 'create KP wire sample table',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS kp_wire_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL,
          turn_seq INTEGER NOT NULL,
          owner_id INTEGER NOT NULL,
          story_id TEXT,
          rag_context TEXT NOT NULL DEFAULT '',
          tool_calls TEXT NOT NULL DEFAULT '[]',
          wire_messages TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 6,
    name: 'create KP wire sample indexes',
    up(database) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_kp_wire_samples_room ON kp_wire_samples (room_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kp_wire_samples_room_seq ON kp_wire_samples (room_id, turn_seq);
      `)
    },
  },
  {
    version: 7,
    name: 'persist room story source owner',
    up(database) {
      addColumnIfMissing(database, 'rooms', 'story_owner_id', 'story_owner_id INTEGER')
      // A transferred room's selected story may still belong to its former owner.
      // Infer the source only when the account/story pair is unambiguous; otherwise
      // retain the current owner as the conservative legacy fallback.
      database.exec(`
        UPDATE rooms
        SET story_owner_id = (SELECT s.user_id FROM stories s WHERE s.story_id = rooms.story_id LIMIT 1)
        WHERE story_id IS NOT NULL AND story_owner_id IS NULL
          AND (SELECT COUNT(*) FROM stories s WHERE s.story_id = rooms.story_id) = 1;
        UPDATE rooms SET story_owner_id = owner_id
        WHERE story_id IS NOT NULL AND story_owner_id IS NULL;
      `)
    },
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version

function getSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  const version = row?.user_version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`SQLite returned an invalid schema version (${String(version)}). Check the database file and restore a backup if it is damaged.`)
  }
  return version
}

/**
 * Apply every pending schema migration atomically and record progress in
 * SQLite's built-in user_version field. The additive steps also recognize
 * versionless databases that already received the old ad-hoc ALTER TABLEs.
 */
export function migrateDatabase(database: DatabaseSync): void {
  const initialVersion = getSchemaVersion(database)
  if (initialVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema version ${initialVersion} is newer than this server supports (up to ${CURRENT_SCHEMA_VERSION}). Upgrade the server or restore a database backup made for this version.`,
    )
  }
  if (initialVersion === CURRENT_SCHEMA_VERSION) return

  let activeMigration: SchemaMigration | undefined
  try {
    database.exec('BEGIN IMMEDIATE')
    for (const migration of MIGRATIONS) {
      if (migration.version <= initialVersion) continue
      activeMigration = migration
      migration.up(database)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    }
    database.exec('COMMIT')
  } catch (cause) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the migration error; rollback can itself fail if BEGIN failed.
    }
    const failedVersion = activeMigration?.version ?? initialVersion + 1
    const migrationName = activeMigration?.name ?? 'begin transaction'
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `SQLite schema migration ${failedVersion} (${migrationName}) failed: ${detail}. All pending changes were rolled back. Check database permissions/integrity, then restore a backup or fix the database before restarting.`,
      { cause },
    )
  }
}

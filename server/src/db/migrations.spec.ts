import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from './migrations.js'

const LEGACY_SCHEMA_SQL = readFileSync(new URL('../../test/fixtures/db/legacy-v0.sql', import.meta.url), 'utf8')
const VERSIONLESS_CURRENT_SQL = readFileSync(new URL('../../test/fixtures/db/versionless-current.sql', import.meta.url), 'utf8')
const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function userVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
}

function makeTempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aikp-db-migration-'))
}

function startServer(dataDir: string): Promise<{ ready: boolean; code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test', PORT: '0', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let ready = false
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 30_000)
    const capture = (chunk: Buffer): void => {
      output += chunk.toString()
      if (!ready && output.includes('COC AI KP server listening')) {
        ready = true
        child.kill('SIGTERM')
      }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`server startup timed out; output: ${output}`))
        return
      }
      resolve({ ready, code, output })
    })
  })
}

function createFixtureFile(directory: string, sql: string): void {
  const database = new DatabaseSync(path.join(directory, 'ai-kp.db'))
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
}

describe('SQLite schema migrations', () => {
  it('creates the current schema, records its version, and is idempotent on a fresh database', () => {
    const database = new DatabaseSync(':memory:')

    try {
      migrateDatabase(database)
      migrateDatabase(database)

      expect(userVersion(database)).toBe(7)
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)
      expect(tables).toEqual(['characters', 'kp_wire_samples', 'room_members', 'rooms', 'settings', 'stories', 'users'])
      expect(columns(database, 'stories')).toContain('file_path')
      expect(columns(database, 'rooms')).toContain('kind')
      expect(columns(database, 'rooms')).toContain('story_owner_id')
      expect(columns(database, 'room_members')).toContain('ready')
    } finally {
      database.close()
    }
  })

  it('upgrades representative legacy stories, rooms, and room_members tables without losing rows', () => {
    const database = new DatabaseSync(':memory:')

    try {
      database.exec(LEGACY_SCHEMA_SQL)
      // Simulate the former owner leaving a room after selecting their story.
      database.exec("UPDATE rooms SET owner_id = 12 WHERE room_id = 'room-old'")
      migrateDatabase(database)

      expect(userVersion(database)).toBe(7)
      expect(columns(database, 'stories')).toContain('file_path')
      expect(columns(database, 'rooms')).toContain('kind')
      expect(columns(database, 'rooms')).toContain('story_owner_id')
      expect(columns(database, 'room_members')).toContain('ready')
      expect(database.prepare("SELECT name, file_path FROM stories WHERE story_id = 'story-old'").get())
        .toEqual({ name: 'Old story', file_path: '' })
      expect(database.prepare("SELECT phase, kind, version FROM rooms WHERE room_id = 'room-old'").get())
        .toEqual({ phase: 'playing', kind: 'multi', version: 3 })
      expect(database.prepare("SELECT owner_id, story_owner_id FROM rooms WHERE room_id = 'room-old'").get())
        .toEqual({ owner_id: 12, story_owner_id: 11 })
      expect(database.prepare("SELECT story_owner_id FROM rooms WHERE room_id = 'room-old'").get())
        .toEqual({ story_owner_id: 11 })
      expect(database.prepare("SELECT role, ready FROM room_members WHERE room_id = 'room-old'").get())
        .toEqual({ role: 'owner', ready: 0 })
      expect(database.prepare('SELECT count(*) AS count FROM kp_wire_samples').get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it('falls back to the current owner when a legacy story id belongs to multiple accounts', () => {
    const database = new DatabaseSync(':memory:')

    try {
      database.exec(LEGACY_SCHEMA_SQL)
      database.exec(`INSERT INTO stories (user_id, story_id, name, created_at) VALUES (12, 'story-old', 'Duplicate story', 103); UPDATE rooms SET owner_id = 13 WHERE room_id = 'room-old';`)
      migrateDatabase(database)

      expect(database.prepare("SELECT story_owner_id FROM rooms WHERE room_id = 'room-old'").get()).toEqual({ story_owner_id: 13 })
    } finally {
      database.close()
    }
  })

  it('adopts a versionless database already upgraded by the old ad-hoc checks', () => {
    const database = new DatabaseSync(':memory:')

    try {
      database.exec(VERSIONLESS_CURRENT_SQL)
      migrateDatabase(database)
      migrateDatabase(database)

      expect(userVersion(database)).toBe(7)
      expect(database.prepare("SELECT file_path FROM stories WHERE story_id = 'story-current'").get())
        .toEqual({ file_path: '/legacy/story.txt' })
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_kp_wire_samples_room_seq'").get())
        .toEqual({ name: 'uq_kp_wire_samples_room_seq' })
    } finally {
      database.close()
    }
  })

  it('rolls back every pending schema change when a migration fails', () => {
    const database = new DatabaseSync(':memory:')

    try {
      database.exec(LEGACY_SCHEMA_SQL)
      database.exec(`
        CREATE TABLE kp_wire_samples (
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
        INSERT INTO kp_wire_samples (room_id, turn_seq, owner_id, wire_messages, created_at)
        VALUES ('duplicate', 1, 11, '[]', 1), ('duplicate', 1, 11, '[]', 2);
      `)

      expect(() => migrateDatabase(database)).toThrow(/migration 6.*rolled back/i)
      expect(userVersion(database)).toBe(0)
      expect(columns(database, 'stories')).not.toContain('file_path')
      expect(columns(database, 'rooms')).not.toContain('kind')
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_kp_wire_samples_room'").get()).toBeUndefined()
      expect(database.prepare("SELECT username FROM users WHERE id = 11").get()).toEqual({ username: 'legacy-user' })
    } finally {
      database.close()
    }
  })

  it('rejects a database created by a newer schema version with an actionable error', () => {
    const database = new DatabaseSync(':memory:')

    try {
      database.exec('PRAGMA user_version = 99')

      expect(() => migrateDatabase(database)).toThrow(/version 99.*newer.*7/i)
      expect(userVersion(database)).toBe(99)
    } finally {
      database.close()
    }
  })

  it('starts the server against fresh and legacy database files', async () => {
    const freshDir = makeTempDataDir()
    const legacyDir = makeTempDataDir()

    try {
      createFixtureFile(legacyDir, LEGACY_SCHEMA_SQL)

      const freshStartup = await startServer(freshDir)
      const legacyStartup = await startServer(legacyDir)

      expect(freshStartup.ready, freshStartup.output).toBe(true)
      expect(legacyStartup.ready, legacyStartup.output).toBe(true)
      for (const directory of [freshDir, legacyDir]) {
        const database = new DatabaseSync(path.join(directory, 'ai-kp.db'))
        try {
          expect(userVersion(database)).toBe(7)
        } finally {
          database.close()
        }
      }
    } finally {
      rmSync(freshDir, { recursive: true, force: true })
      rmSync(legacyDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('fails server startup for a database newer than the supported schema', async () => {
    const directory = makeTempDataDir()
    const database = new DatabaseSync(path.join(directory, 'ai-kp.db'))

    try {
      database.exec('PRAGMA user_version = 99')
      database.close()

      const startup = await startServer(directory)

      expect(startup.ready).toBe(false)
      expect(startup.code).not.toBe(0)
      expect(startup.output).toMatch(/version 99.*newer.*7/i)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

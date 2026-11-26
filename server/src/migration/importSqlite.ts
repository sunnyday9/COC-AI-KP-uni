import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PoolClient } from 'pg'
import { assertRuntimeConfig, DATA_DIR, DEPLOYMENT_MODE } from '../config.js'
import { CURRENT_SCHEMA_VERSION } from '../db/migrations.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { initializePostgresAccounts } from '../db/postgresAccountsSchema.js'
import { claimPostgresRoomGuard, installPostgresRoomSchema } from '../db/postgresRoomsSchema.js'
import { initializePostgresStories } from '../db/postgresStoriesSchema.js'
import { initializePostgresStoryPreparation } from '../db/postgresStoryPreparationSchema.js'
import type { RoomSnapshot } from '../services/roomService.js'
import { parseRoomState, serializeRoomState } from '../services/roomStateCodec.js'
import { boundTranscript } from '../services/roomTranscript.js'
import { getStoryObjectStore } from '../services/storyObjectStorage.js'
import { decryptSecret } from '../utils/crypto.js'
import { NotFoundError } from '../utils/errors.js'
import { assertPathInDir } from '../utils/pathSafety.js'
import { planStories, sha256, type MigrationObject } from './localStories.js'

interface Account {
  id: number
  username: string
  password_hash: string
  created_at: number
}

interface Settings {
  user_id: number
  data: string
}

interface LocalRoom {
  room_id: string
  owner_id: number
  invite_code: string
  story_id: string | null
  story_owner_id: number | null
  kind: string
  phase: RoomSnapshot['phase']
  state: string
  version: number
  updated_at: number
  created_at: number
}

interface ActionReceipt {
  room_id: string
  user_id: number
  action_id: string
  payload_hash: string
  message_id: string
  status: string
}

const columns = {
  users: 'id, username, password_hash, created_at',
  settings: 'user_id, data',
  characters: 'id, user_id, name, sheet, updated_at',
  story_catalog: 'owner_id, story_id, name, source_revision, source_size, extension, created_at, deleted_at, active_preparation_revision, active_prepared_at',
  story_preparation_jobs: 'job_id, owner_id, story_id, source_revision, state, stage, percent, attempt, lease_expires_at, operation_id, retry_of_job_id',
  story_preparation_revisions: 'revision, job_id, owner_id, story_id, source_revision, prepared_at, chunk_count, objects',
  rooms: 'room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, version, updated_at, created_at, story_preparation_revision, story_source_revision, event_seq, turn_pending, transcript_archived, worker_epoch, worker_expires_at, worker_id',
  room_members: 'room_id, user_id, role, character_id, ready, join_order',
  room_transcript: 'room_id, position, message_id, message',
  room_actions: 'room_id, user_id, action_id, payload_hash, message_id, status',
}

type Table = keyof typeof columns

const emptyTables = ['room_turns', 'room_events', 'room_event_outbox', 'story_preparation_dispatch'] as const

function selectRows<T>(db: DatabaseSync, query: string): T[] {
  return db.prepare(query).all() as unknown as T[]
}

async function planImport(db: DatabaseSync, staging: string) {
  const users = selectRows<Account>(db, 'SELECT id, username, password_hash, created_at FROM users ORDER BY id')
  const settings = selectRows<Settings>(db, 'SELECT user_id, data FROM settings ORDER BY user_id')
  for (const row of settings) {
    let apiKey: unknown
    try { apiKey = JSON.parse(row.data)?.ai?.apiKey } catch { /* App treats malformed settings as empty. */ }
    if (apiKey !== undefined && !decryptSecret(apiKey)) {
      throw new Error(`Cannot decrypt a settings row with the configured JWT_SECRET`)
    }
  }

  const sqliteSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get() as { seq: number } | undefined
  const nextAccountId = Math.max(users.at(-1)?.id ?? 0, sqliteSequence?.seq ?? 0) + 1
  const story = await planStories(db, users.map(account => account.id), staging)
  const characters = selectRows(db, 'SELECT id, user_id, name, sheet, updated_at FROM characters ORDER BY id')
  const roomMembers = selectRows<{ room_id: string; user_id: number; character_id: string | null; role: string; join_order: number }>(
    db, 'SELECT room_id, user_id, role, character_id, ready, rowid AS join_order FROM room_members ORDER BY rowid',
  )
  const actions = selectRows<ActionReceipt>(db, `SELECT room_id, user_id, action_id, payload_hash, message_id, status
    FROM room_actions ORDER BY room_id, user_id, action_id`)
  const pending = new Map(actions.filter(action => action.status === 'pending')
    .map(action => [JSON.stringify([action.room_id, action.user_id, action.action_id]), action]))
  const ownerMembers = new Map<string, number>()
  for (const member of roomMembers) {
    if (member.role !== 'owner') continue
    if (ownerMembers.has(member.room_id)) throw new Error('A room has multiple host memberships')
    ownerMembers.set(member.room_id, member.user_id)
  }
  const characterOwners = new Map((characters as { id: string; user_id: number }[]).map(character => [character.id, character.user_id]))
  for (const member of roomMembers) {
    if (member.character_id !== null && characterOwners.get(member.character_id) !== member.user_id) {
      throw new Error("A room has a character binding outside its member's account")
    }
  }
  const transcript: { room_id: string; position: number; message_id: string; message: RoomSnapshot['messages'][number] }[] = []
  let pausedRooms = 0
  let pendingActions = 0
  const rooms = selectRows<LocalRoom>(db, 'SELECT * FROM rooms ORDER BY room_id').map(room => {
    if (ownerMembers.get(room.room_id) !== room.owner_id) throw new Error('A room has inconsistent host membership')
    const snapshot = parseRoomState<RoomSnapshot>(room.state)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('A room has an invalid snapshot')
    }
    const phase = room.phase === 'playing' && snapshot.ending != null ? 'ended' : room.phase
    const storyOwner = room.story_id === null ? null : (room.story_owner_id ?? room.owner_id)
    const pin = phase === 'lobby' ? undefined : story.pins.get(JSON.stringify([storyOwner, room.story_id]))
    if (phase === 'playing' && !pin) throw new Error(`Playing room ${room.room_id} has no complete verified story revision`)
    const messages = snapshot.messages ?? []
    const seq = snapshot.seq ?? 0
    if (!Array.isArray(messages) || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('A room has an invalid transcript or sequence')
    }
    const messageIds = new Set<string>()
    for (const [index, message] of messages.entries()) {
      if (typeof message?.id !== 'string' || !message.id || messageIds.has(message.id)) {
        throw new Error('A room has an invalid or duplicate transcript message ID')
      }
      messageIds.add(message.id)
      transcript.push({ room_id: room.room_id, position: index + 1, message_id: message.id, message })
    }
    const queued = snapshot.pendingTurnMessages ?? []
    if (!Array.isArray(queued)) throw new Error('A room has an invalid action queue')
    for (const action of queued) {
      if (!action || typeof action.username !== 'string' || typeof action.content !== 'string'
        || !Number.isSafeInteger(action.authorUserId) || (action.characterId !== null && typeof action.characterId !== 'string')
        || (action.messageId !== undefined && !messageIds.has(action.messageId))) {
        throw new Error('A room has an invalid pending action')
      }
      if (action.actionId === undefined) continue
      const key = JSON.stringify([room.room_id, action.authorUserId, action.actionId])
      const receipt = pending.get(key)
      if (!receipt || receipt.message_id !== action.messageId || receipt.payload_hash !== sha256(JSON.stringify(['chat', action.content]))) {
        throw new Error('A room has a pending action/receipt mismatch')
      }
      pending.delete(key)
    }
    if (snapshot.pendingPlayerTurn && (typeof snapshot.pendingPlayerTurn.id !== 'string'
      || !Number.isSafeInteger(snapshot.pendingPlayerTurn.actionCount) || snapshot.pendingPlayerTurn.actionCount < 1
      || snapshot.pendingPlayerTurn.actionCount > queued.length)) {
      throw new Error('A room has an invalid turn checkpoint')
    }
    const providerPause = (snapshot as RoomSnapshot & { kpPauseReason?: string | null }).kpPauseReason
    const paused = !!snapshot.kpSetupRequired || !!providerPause
    if (paused) pausedRooms++
    pendingActions += queued.length
    snapshot.phase = phase
    snapshot.storyId = room.story_id
    snapshot.seq = seq
    snapshot.messages = messages
    boundTranscript(snapshot)
    return {
      ...room, phase, story_owner_id: storyOwner, state: serializeRoomState(snapshot),
      story_preparation_revision: pin?.preparationRevision ?? null,
      story_source_revision: pin?.sourceRevision ?? null,
      transcript_archived: true, event_seq: seq, turn_pending: phase === 'playing' && !paused && queued.length > 0,
      worker_epoch: 0, worker_expires_at: null, worker_id: null,
    }
  })
  if (pending.size) throw new Error('Pending action receipts do not have corresponding buffered actions')

  const tables: Record<Table, readonly unknown[]> = {
    users, settings, characters, story_catalog: story.catalog, story_preparation_jobs: story.jobs,
    story_preparation_revisions: story.revisions, rooms, room_members: roomMembers,
    room_transcript: transcript, room_actions: actions,
  }
  const objects = story.objects.map(({ key, size, sha256 }) => ({ key, size, sha256 }))
  const report = {
    counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
    pausedRooms, pendingActions, unpreparedStories: story.unprepared, objects,
  }
  const digest = sha256(JSON.stringify([tables, report, nextAccountId]))
  return { tables, objects: story.objects, report, digest, nextAccountId, nextJoinOrder: (roomMembers.at(-1)?.join_order ?? 0) + 1 }
}

async function requireEmpty(client: PoolClient, table: string): Promise<void> {
  const result = await client.query<{ occupied: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table}) AS occupied`)
  if (result.rows[0]?.occupied) throw new Error(`Destination table ${table} contains writes outside this import`)
}

async function reconcileTable(client: PoolClient, table: Table, rows: readonly unknown[], firstRun: boolean) {
  const fields = columns[table]
  const input = JSON.stringify(rows)
  const fromInput = `SELECT ${fields} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`
  if (firstRun) {
    await requireEmpty(client, table)
    const override = table === 'room_members' ? 'OVERRIDING SYSTEM VALUE' : ''
    await client.query(`INSERT INTO ${table} (${fields}) ${override} ${fromInput}`, [input])
  }
  const fromTarget = `SELECT ${fields} FROM ${table}`
  const result = await client.query<{ verified: boolean }>(`
    SELECT NOT EXISTS ((${fromInput}) EXCEPT ALL (${fromTarget}))
      AND NOT EXISTS ((${fromTarget}) EXCEPT ALL (${fromInput})) AS verified
  `, [input])
  if (!result.rows[0]?.verified) throw new Error(`Destination table ${table} differs from the source import`)
}

async function reconcileObject(
  store: NonNullable<ReturnType<typeof getStoryObjectStore>>, entry: MigrationObject, firstRun: boolean,
) {
  const signal = AbortSignal.timeout(120_000)
  const verify = async () => {
    const body = await store.get(entry.key, entry.size, signal)
    const bytes = Buffer.from(await body.transformToByteArray())
    if (sha256(bytes) !== entry.sha256) throw new Error(`A destination object checksum differs from the import`)
  }
  try {
    await verify()
    return
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    if (!firstRun) throw new Error('A destination object is missing from the recorded import')
  }
  const staged = fs.readFileSync(entry.file)
  if (staged.length !== entry.size || sha256(staged) !== entry.sha256) throw new Error('Staged object checksum mismatch')
  await store.putArtifact(entry.key, staged, entry.sha256, signal)
  await verify()
}

async function main() {
  assertRuntimeConfig()
  const store = getStoryObjectStore()
  if (DEPLOYMENT_MODE !== 'shared-accounts' || !store || !process.env.DATA_DIR || !process.env.UPLOADS_DIR
    || !process.env.RAG_DATA_DIR || !process.env.DOSSIER_DATA_DIR || process.argv.slice(2).join(' ') !== '--offline') {
    throw new Error('Set explicit source roots, shared account and object-store configuration, and pass --offline')
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-sqlite-import-'))
  const pool = getPostgresPool()
  let source: DatabaseSync | undefined
  try {
    source = new DatabaseSync(assertPathInDir(DATA_DIR, path.join(DATA_DIR, 'ai-kp.db'), 'SQLite backup'), { readOnly: true })
    source.exec('BEGIN')
    const version = source.prepare('PRAGMA user_version').get()?.user_version
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`Expected SQLite schema ${CURRENT_SCHEMA_VERSION} on the backup`)
    const plan = await planImport(source, staging)
    const guard = await pool.connect()
    try {
      await claimPostgresRoomGuard(guard, false)
      await inPostgresTransaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(17407, 111)')
        await initializePostgresAccounts(client)
        await initializePostgresStories(client)
        await initializePostgresStoryPreparation(client)
        await installPostgresRoomSchema(client, true, true)
        await client.query(`
          CREATE TABLE IF NOT EXISTS sqlite_import (
            singleton BOOLEAN PRIMARY KEY CHECK (singleton),
            digest TEXT NOT NULL,
            reconciliation JSONB NOT NULL
          )
        `)
        const { rows: [completed] } = await client.query<{ digest: string }>('SELECT digest FROM sqlite_import WHERE singleton')
        if (completed && completed.digest !== plan.digest) throw new Error('Source differs from the recorded import')
        const tableNames = Object.keys(plan.tables) as Table[]
        await client.query(`LOCK TABLE ${[...tableNames, ...emptyTables].join(', ')} IN SHARE ROW EXCLUSIVE MODE`)
        for (const table of emptyTables) await requireEmpty(client, table)
        for (const table of tableNames) await reconcileTable(client, table, plan.tables[table], !completed)
        for (const entry of plan.objects) await reconcileObject(store, entry, !completed)
        if (!completed) {
          await client.query(`ALTER TABLE users ALTER COLUMN id RESTART WITH ${plan.nextAccountId}`)
          await client.query(`ALTER TABLE room_members ALTER COLUMN join_order RESTART WITH ${plan.nextJoinOrder}`)
          await client.query('INSERT INTO sqlite_import (singleton, digest, reconciliation) VALUES (TRUE, $1, $2::jsonb)',
            [plan.digest, JSON.stringify(plan.report)])
        }
      })
    } finally {
      guard.release(true)
    }
    process.stdout.write(JSON.stringify({
      counts: plan.report.counts, pausedRooms: plan.report.pausedRooms, pendingActions: plan.report.pendingActions,
      unpreparedStories: plan.report.unpreparedStories.length, objects: plan.report.objects.length,
    }, null, 2) + '\n')
  } finally {
    try {
      source?.close()
      await pool.end()
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }
}

await main().catch((error: unknown) => {
  // PostgreSQL constraint details can contain user or settings data.
  let message = 'SQLite migration failed'
  if (error && typeof error === 'object' && 'severity' in error) message = postgresError(error).message
  else if (error instanceof Error && 'code' in error) {
    const code = String(error.code)
    if (/^[A-Z][A-Z0-9_]{1,32}$/.test(code)) message += ` (${code})`
  } else if (error instanceof Error) message = error.message
  process.stderr.write(message + '\n')
  process.exitCode = 1
})

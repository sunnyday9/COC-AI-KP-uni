import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { types, type PoolClient } from 'pg'
import { getDb } from '../db/index.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { ROOM_WORKER_FAILOVER_ENABLED, ROOM_WORKER_LEASE_MS, SHARED_ROOMS_ENABLED } from '../config.js'
import { CapacityError } from '../utils/errors.js'
import { parseRoomState } from './roomStateCodec.js'
import type { Message } from '../../../shared/types/game.js'
import type { RoomActionReceiptStatus, RoomPhase } from '../../../shared/types/room.js'

// The room backend is selected once per process. All room/member/character
// transactions keep the same connection and never cross account stores.
interface Statement {
  sql: string
  values: SQLInputValue[]
  requireSelectableRevision?: boolean
}

const statement = (sql: string, ...values: SQLInputValue[]): Statement => ({ sql, values })

const roomTypes = {
  getTypeParser(oid: number) {
    if (oid === types.builtins.INT8) {
      return (value: string) => {
        const integer = Number(value)
        if (!Number.isSafeInteger(integer)) throw new Error('Room storage integer exceeds safe range')
        return integer
      }
    }
    return types.getTypeParser(oid)
  },
}

function pgQuery(command: Statement) {
  let index = 0
  return { text: command.sql.replace(/\?/g, () => `$${++index}`), values: command.values, types: roomTypes }
}

type Row = Record<string, unknown>

async function readAll<T extends Row>(sql: string, ...values: SQLInputValue[]): Promise<T[]> {
  if (!SHARED_ROOMS_ENABLED) return getDb().prepare(sql).all(...values) as unknown as T[]
  try {
    return (await getPostgresPool().query<T>(pgQuery(statement(sql, ...values)))).rows
  } catch (error) {
    throw postgresError(error)
  }
}

async function readOne<T extends Row>(sql: string, ...values: SQLInputValue[]): Promise<T | undefined> {
  return (await readAll<T>(sql, ...values))[0]
}

async function executeRoomStatements(client: Pick<PoolClient, 'query'>, commands: Statement[]): Promise<void> {
  for (const command of commands) {
    const result = await client.query(pgQuery(command))
    if (command.requireSelectableRevision && result.rowCount !== 1) throw new StoryRevisionChangedError()
  }
}

async function writeAll(commands: Statement[]): Promise<void> {
  if (SHARED_ROOMS_ENABLED) {
    try {
      if (commands.length > 1) await inPostgresTransaction((client) => executeRoomStatements(client, commands))
      else await executeRoomStatements(getPostgresPool(), commands)
    } catch (error) {
      if (error instanceof StoryRevisionChangedError) throw error
      throw postgresError(error)
    }
    return
  }

  const db = getDb()
  if (commands.length === 1) {
    const command = commands[0]!
    db.prepare(command.sql).run(...command.values)
    return
  }

  // Keep the full SQLite transaction in one synchronous turn, even though
  // the public adapter contract returns promises.
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const command of commands) db.prepare(command.sql).run(...command.values)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export class StoryRevisionChangedError extends Error {}
export class RoomDisconnectSupersededError extends Error {}

export interface OwnerDisconnect { userId: number; requestId: string }

export interface StoryRevisionPin {
  revision: string
  sourceRevision: string
}

const selectableRevisionSql = `SELECT 1 FROM story_catalog
  WHERE owner_id = ? AND story_id = ? AND active_preparation_revision = ?
    AND source_revision = ? AND deleted_at IS NULL FOR SHARE`

// Epochs remain decimal strings so PostgreSQL BIGINT can grow without losing precision.
export type RoomWorkerLease = { epoch: string }
const workerId = randomUUID()
export { workerId as roomWorkerId }

export type ClaimedRoomCommand = { request_id: string; room_id: string; user_id: number; command: unknown; presence_loss: boolean }

/** Do not claim a later command while this room has an unexpired in-flight command. */
export async function claimNextRoomCommand(worker: string, active: ReadonlySet<string>): Promise<ClaimedRoomCommand | undefined> {
  return readOne<ClaimedRoomCommand>(
    'WITH command AS (' +
    ' SELECT c.sequence FROM room_commands c LEFT JOIN rooms r USING (room_id)' +
    ' WHERE (c.claimed_by IS NULL OR (c.presence_loss AND c.claim_expires_at <= clock_timestamp()))' +
    ' AND c.expires_at > clock_timestamp() AND c.request_id != ALL(?::uuid[])' +
    ' AND (r.worker_id = ? OR r.worker_expires_at IS NULL OR r.worker_expires_at <= clock_timestamp())' +
    ' AND NOT EXISTS (SELECT 1 FROM room_commands earlier WHERE earlier.room_id = c.room_id' +
    '   AND earlier.sequence < c.sequence AND earlier.result IS NULL AND earlier.expires_at > clock_timestamp())' +
    ' ORDER BY c.sequence LIMIT 1 FOR UPDATE OF c SKIP LOCKED' +
    ") UPDATE room_commands c SET claimed_by = ?, claim_expires_at = clock_timestamp() + interval '5 seconds'" +
    ' FROM command WHERE c.sequence = command.sequence' +
    ' RETURNING c.request_id, c.room_id, c.user_id, c.command, c.presence_loss', '{' + [...active].join(',') + '}', worker, worker,
  )
}

export class RoomLeaseLostError extends CapacityError {
  constructor() { super('Room worker lease lost') }
}

export class RoomWorkerBusyError extends CapacityError {
  constructor() { super('房间正由另一进程处理，请稍后重新连接。') }
}

/** Every activation claims a new epoch. Renewal of an existing epoch is separate. */
export async function claimRoomLease(roomId: string): Promise<RoomWorkerLease | undefined> {
  return readOne<RoomWorkerLease>(
    `UPDATE rooms
     SET worker_id = ?::uuid, worker_expires_at = clock_timestamp() + ? * interval '1 millisecond',
         worker_epoch = worker_epoch + 1
     WHERE room_id = ? AND (worker_id = ?::uuid OR worker_expires_at <= clock_timestamp() OR worker_id IS NULL)
     RETURNING worker_epoch::text AS epoch`,
    workerId, ROOM_WORKER_LEASE_MS, roomId, workerId,
  )
}

export async function listPendingRoomRecoveries(limit: number): Promise<{ room_id: string; owner_id: number }[]> {
  return readAll<{ room_id: string; owner_id: string }>(
    `SELECT room_id, owner_id FROM rooms
     WHERE turn_pending AND phase = 'playing'
       AND (worker_expires_at IS NULL OR worker_expires_at <= now())
     ORDER BY worker_expires_at NULLS FIRST, room_id LIMIT ?`, limit,
  ).then((rows) => rows.map((row) => ({ ...row, owner_id: Number(row.owner_id) })))
}

export async function renewRoomLease(roomId: string, lease: RoomWorkerLease): Promise<boolean> {
  return !!await readOne(
    `UPDATE rooms SET worker_expires_at = clock_timestamp() + ? * interval '1 millisecond'
     WHERE room_id = ? AND worker_id = ?::uuid AND worker_epoch = ?::bigint
       AND worker_expires_at > clock_timestamp() RETURNING 1`,
    ROOM_WORKER_LEASE_MS, roomId, workerId, lease.epoch,
  )
}

/** Return batch indexes that renewed or are still live behind a contended room lock. */
export async function renewRoomLeases(leases: readonly { roomId: string; lease: RoomWorkerLease }[]): Promise<Set<number>> {
  try {
    const { rows } = await getPostgresPool().query<{ idx: number }>(`
      WITH requested AS (
        SELECT * FROM unnest($1::text[], $2::bigint[]) WITH ORDINALITY AS batch(room_id, epoch, idx)
      ), locked AS MATERIALIZED (
        SELECT batch.idx, room.room_id, batch.epoch FROM requested batch JOIN rooms room USING (room_id)
        WHERE room.worker_id = $3 AND room.worker_epoch = batch.epoch AND room.worker_expires_at > clock_timestamp()
        FOR NO KEY UPDATE OF room SKIP LOCKED
      ), renewed AS (
        UPDATE rooms room SET worker_expires_at = clock_timestamp() + $4 * interval '1 millisecond'
        FROM locked batch WHERE room.room_id = batch.room_id AND room.worker_id = $3
          AND room.worker_epoch = batch.epoch AND room.worker_expires_at > clock_timestamp()
        RETURNING batch.idx
      )
      SELECT idx::integer FROM renewed
      UNION ALL
      SELECT batch.idx::integer FROM requested batch JOIN rooms room USING (room_id)
      WHERE NOT EXISTS (SELECT 1 FROM locked WHERE locked.idx = batch.idx)
        AND room.worker_id = $3 AND room.worker_epoch = batch.epoch AND room.worker_expires_at > clock_timestamp()
    `, [leases.map(({ roomId }) => roomId), leases.map(({ lease }) => lease.epoch), workerId, ROOM_WORKER_LEASE_MS])
    return new Set(rows.map(({ idx }) => idx - 1))
  } catch (error) {
    throw postgresError(error)
  }
}

export function releaseRoomLease(roomId: string, lease: RoomWorkerLease): Promise<void> {
  return writeAll([statement(
    'UPDATE rooms SET worker_id = NULL, worker_expires_at = NULL WHERE room_id = ? AND worker_id = ?::uuid AND worker_epoch = ?::bigint',
    roomId, workerId, lease.epoch,
  )])
}

/** Fence and write in one transaction. The same room row serializes lease claims with durable mutations. */
async function writeRoom(
  roomId: string, commands: Statement[], lease?: RoomWorkerLease, disconnect?: OwnerDisconnect,
): Promise<void> {
  if (!ROOM_WORKER_FAILOVER_ENABLED) return writeAll(commands)
  if (!lease) throw new RoomLeaseLostError()
  try {
    await inPostgresTransaction(async (client) => {
      const row = await client.query(pgQuery(statement(
        'SELECT worker_id::text AS worker, worker_epoch::text AS epoch FROM rooms WHERE room_id = ? FOR UPDATE', roomId,
      )))
      if (!row.rows[0]) throw new RoomLeaseLostError()
      // Check expiration after the row is locked. An earlier timestamp could
      // survive waiting behind a transaction that renews or replaces the lease.
      const state = (await client.query(pgQuery(statement(
        'SELECT worker_expires_at > clock_timestamp() AS live FROM rooms WHERE room_id = ?', roomId,
      )))).rows[0]
      if (!state?.live || row.rows[0].worker !== workerId || row.rows[0].epoch !== lease.epoch) throw new RoomLeaseLostError()
      if (disconnect) {
        const stillAbsent = await client.query(`
          SELECT 1 FROM room_commands WHERE room_id = $1 AND user_id = $2 AND request_id = $3::uuid
            AND presence_loss AND expires_at > clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM room_gateway_presence
              WHERE room_id = $1 AND user_id = $2 AND expires_at > clock_timestamp())
        `, [roomId, disconnect.userId, disconnect.requestId])
        if (!stillAbsent.rowCount) throw new RoomDisconnectSupersededError()
      }
      await executeRoomStatements(client, commands)
    })
  } catch (error) {
    if (error instanceof CapacityError || error instanceof StoryRevisionChangedError || error instanceof RoomDisconnectSupersededError) throw error
    throw postgresError(error)
  }
}

export interface RoomRow {
  room_id: string
  owner_id: number
  invite_code: string
  story_id: string | null
  story_owner_id: number | null
  story_preparation_revision?: string | null
  story_source_revision?: string | null
  kind: string
  phase: string
  state: string
  transcript_archived?: boolean
  created_at: number
}

export interface RoomMemberRow {
  user_id: number
  username: string
  role: string
  character_id: string | null
  ready: number
}

export interface RoomListItemRow {
  roomId: string
  inviteCode: string
  storyId: string | null
  phase: string
  updatedAt: number
}

export interface SoloRoomListItemRow {
  roomId: string
  storyId: string | null
  phase: string
  updatedAt: number
  preview: string
}

function insertRoomSql(
  roomId: string,
  ownerId: number,
  inviteCode: string,
  storyId: string | null,
  kind: 'multi' | 'solo',
  phase: RoomPhase,
  state: string,
  pin?: StoryRevisionPin,
): Statement {
  const now = Date.now()
  if (pin) return {
    ...statement(
      `INSERT INTO rooms (room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state,
           version, updated_at, created_at, story_preparation_revision, story_source_revision)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ? WHERE EXISTS (${selectableRevisionSql})`,
      roomId, ownerId, inviteCode, storyId, ownerId, kind, phase, state, now, now, pin.revision, pin.sourceRevision,
      ownerId, storyId, pin.revision, pin.sourceRevision,
    ),
    requireSelectableRevision: true,
  }
  return statement(
    `INSERT INTO rooms (room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, version, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    roomId, ownerId, inviteCode, storyId, storyId ? ownerId : null, kind, phase, state, now, now,
  )
}

export function insertRoom(
  roomId: string,
  ownerId: number,
  inviteCode: string,
  storyId: string | null,
  kind: 'multi' | 'solo' = 'multi',
): Promise<void> {
  return writeAll([insertRoomSql(roomId, ownerId, inviteCode, storyId, kind, 'lobby', '{}')])
}

function ownerMember(roomId: string, userId: number, characterId: string | null): Statement {
  return statement(
    `INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'owner', ?)`,
    roomId, userId, characterId,
  )
}

export function insertMultiplayerRoom(roomId: string, userId: number, code: string, storyId: string | null, state: string): Promise<void> {
  return writeAll([insertRoomSql(roomId, userId, code, storyId, 'multi', 'lobby', state), ownerMember(roomId, userId, null)])
}

export function insertSoloRoom(
  roomId: string, userId: number, code: string, storyId: string, state: string,
  character: { id: string; name: string; sheet: string },
  pin?: StoryRevisionPin,
): Promise<void> {
  return writeAll([
    insertCharacterSql(character.id, userId, character.name, character.sheet),
    insertRoomSql(roomId, userId, code, storyId, 'solo', 'playing', state, pin),
    ownerMember(roomId, userId, character.id),
  ])
}

export async function inviteCodeExists(code: string): Promise<boolean> {
  return !!(await readOne('SELECT 1 FROM rooms WHERE invite_code = ?', code))
}

export async function findRoomIdByInviteCode(code: string): Promise<string | null> {
  const row = await readOne<{ room_id: string }>('SELECT room_id FROM rooms WHERE invite_code = ?', code)
  return row?.room_id ?? null
}

interface ListedRoom extends Row {
  room_id: string
  invite_code: string
  story_id: string | null
  phase: string
  updated_at: number
  state: string
}

export async function listRoomsForUser(userId: number): Promise<RoomListItemRow[]> {
  const rows = await readAll<ListedRoom>(
    `SELECT r.room_id, r.invite_code, r.story_id, r.phase, r.updated_at
     FROM rooms r JOIN room_members m ON r.room_id = m.room_id
     WHERE m.user_id = ? AND r.kind != 'solo' ORDER BY r.updated_at DESC`, userId,
  )
  return rows.map((r) => ({ roomId: r.room_id, inviteCode: r.invite_code, storyId: r.story_id, phase: r.phase, updatedAt: r.updated_at }))
}

export async function listSoloRoomsForUser(userId: number): Promise<SoloRoomListItemRow[]> {
  const rows = await readAll<ListedRoom>(
    `SELECT r.room_id, r.story_id, r.phase, r.updated_at, r.state
     FROM rooms r JOIN room_members m ON r.room_id = m.room_id
     WHERE m.user_id = ? AND r.kind = 'solo' AND r.phase != 'ended' ORDER BY r.updated_at DESC`, userId,
  )
  return rows.map((r) => {
    const msgs = parseRoomState<{ messages?: { role: string; content?: unknown }[] }>(r.state)?.messages
    const last = Array.isArray(msgs) ? msgs.at(-1) : undefined
    const preview = typeof last?.content === 'string' ? last.content.slice(0, 50) : ''
    return { roomId: r.room_id, storyId: r.story_id, phase: r.phase, updatedAt: r.updated_at, preview }
  })
}

export function getRoomRow(roomId: string): Promise<RoomRow | undefined> {
  const revisionColumns = SHARED_ROOMS_ENABLED ? ', story_preparation_revision, story_source_revision' : ''
  const transcriptColumn = ROOM_WORKER_FAILOVER_ENABLED ? ', transcript_archived' : ''
  return readOne<RoomRow & Row>(
    `SELECT room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, created_at${revisionColumns}${transcriptColumn}
     FROM rooms WHERE room_id = ?`, roomId,
  )
}

/** Read authorized details and current members from one snapshot. */
export async function readRoomDetailForMember(
  roomId: string, userId: number,
): Promise<{ room: RoomRow; members: RoomMemberRow[] } | undefined> {
  if (!SHARED_ROOMS_ENABLED) {
    if (!await memberRole(roomId, userId)) return undefined
    const room = await getRoomRow(roomId)
    return room && { room, members: await listMembers(roomId) }
  }
  const transcriptColumn = ROOM_WORKER_FAILOVER_ENABLED ? ', r.transcript_archived' : ''
  const result = await readOne<RoomRow & { members: RoomMemberRow[] } & Row>(`
    SELECT r.room_id, r.owner_id, r.invite_code, r.story_id, r.story_owner_id, r.kind, r.phase, r.state,
      r.created_at, r.story_preparation_revision, r.story_source_revision${transcriptColumn},
      (SELECT jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'role', m.role, 'character_id', m.character_id, 'ready', m.ready, 'username', u.username
      ) ORDER BY m.join_order)
      FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = r.room_id) AS members
    FROM rooms r WHERE r.room_id = ?
      AND EXISTS (SELECT 1 FROM room_members caller WHERE caller.room_id = r.room_id AND caller.user_id = ?)
  `, roomId, userId)
  if (!result) return undefined
  const { members, ...room } = result
  if (members.some((member) => !Number.isSafeInteger(member.user_id))) throw new Error('Room member ID exceeds safe range')
  return { room, members }
}

/** Import the original snapshot order once, fenced against any newer room writer. */
export function archiveRoomTranscript(
  roomId: string, lease: RoomWorkerLease, legacyMessages: readonly Message[], boundedState: string,
  seq: number, turnPending: boolean,
): Promise<void> {
  return writeRoom(roomId, [
    statement(
      `INSERT INTO room_transcript (room_id, position, message_id, message)
       SELECT ?, entry.position, entry.message->>'id', entry.message
       FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS entry(message, position)
       WHERE jsonb_typeof(entry.message->'id') = 'string'
       ORDER BY entry.position
       ON CONFLICT (room_id, message_id) DO NOTHING`,
      roomId, JSON.stringify(legacyMessages),
    ),
    statement(
      'UPDATE rooms SET state = ?, transcript_archived = true, event_seq = ?, turn_pending = (? = 1) WHERE room_id = ?',
      boundedState, seq, turnPending ? 1 : 0, roomId,
    ),
  ], lease)
}

/** Continue the existing prompt scan into the archive without hydrating the transcript. */
export async function readArchivedTurnHistory(
  roomId: string, before: string | null, excludedMessageIds: Set<string>, skip: number,
  window: { scan: number; take: number; chars: number },
): Promise<Message[]> {
  const rows = await readAll<{ message: Message }>(
    `SELECT jsonb_set(eligible.message, '{content}', to_jsonb(right(eligible.message->>'content', ?))) AS message
     FROM (
       SELECT t.message, t.position FROM room_transcript t
       WHERE t.room_id = ?
         AND t.position < COALESCE(
           (SELECT position FROM room_transcript WHERE room_id = t.room_id AND message_id = ?),
           CASE WHEN ?::text IS NULL THEN 9223372036854775807 END
         )
         AND t.message_id <> ALL (SELECT jsonb_array_elements_text(?::jsonb))
       ORDER BY t.position DESC LIMIT ? OFFSET ?
     ) eligible
     WHERE (eligible.message->>'role' = 'player'
       OR (eligible.message->>'role' = 'kp' AND eligible.message->>'isStreaming' IS DISTINCT FROM 'true'))
       AND jsonb_typeof(eligible.message->'content') = 'string'
     ORDER BY eligible.position DESC LIMIT ?`,
    Math.min(window.chars + 1, 2_147_483_647), roomId, before, before, JSON.stringify([...excludedMessageIds]),
    window.scan, skip, window.take,
  )
  return rows.reverse().map(({ message }) => message)
}

/** Read only a member's own room. Storage returns one lookahead message for pagination. */
export async function readRoomHistory(
  roomId: string, userId: number, before: string | null, limit: number,
): Promise<Message[] | undefined> {
  if (ROOM_WORKER_FAILOVER_ENABLED) {
    const result = await readOne<{ legacy_state: string | null; messages: Message[] }>(
      `SELECT CASE WHEN NOT r.transcript_archived THEN r.state END AS legacy_state,
              COALESCE(history.messages, '[]'::jsonb) AS messages
       FROM rooms r JOIN room_members m USING (room_id)
       LEFT JOIN room_transcript cursor ON cursor.room_id = r.room_id AND cursor.message_id = ?
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(page.message ORDER BY page.position DESC) AS messages
         FROM (
           SELECT t.message, t.position FROM room_transcript t
           WHERE t.room_id = r.room_id AND t.position < COALESCE(cursor.position, CASE WHEN ?::text IS NULL THEN 9223372036854775807 END)
           ORDER BY t.position DESC LIMIT ?
         ) page
       ) history ON r.transcript_archived
       WHERE r.room_id = ? AND m.user_id = ?`,
      before, before, limit, roomId, userId,
    )
    if (!result) return undefined
    return result.legacy_state === null ? result.messages : readLegacyHistory(result.legacy_state, before, limit)
  }
  const result = await readOne<{ state: string }>(
    'SELECT r.state FROM rooms r JOIN room_members m USING (room_id) WHERE r.room_id = ? AND m.user_id = ?',
    roomId, userId,
  )
  return result ? readLegacyHistory(result.state, before, limit) : undefined
}

function readLegacyHistory(state: string, before: string | null, limit: number): Message[] {
  const messages = parseRoomState<{ messages?: Message[] }>(state)?.messages
  if (!Array.isArray(messages)) return []
  const end = before === null ? messages.length : messages.findIndex((message) => message?.id === before)
  return end > 0 ? messages.slice(Math.max(0, end - limit), end).reverse() : []
}

export function updateRoomStart(roomId: string, storyId: string, storyOwnerId: number, pin?: StoryRevisionPin, lease?: RoomWorkerLease): Promise<void> {
  if (pin) return writeRoom(roomId, [{
    ...statement(
      `UPDATE rooms SET story_id = ?, story_owner_id = ?, story_preparation_revision = ?,
         story_source_revision = ?, phase = 'playing', updated_at = ?
       WHERE room_id = ? AND story_preparation_revision IS NULL AND EXISTS (${selectableRevisionSql})`,
      storyId, storyOwnerId, pin.revision, pin.sourceRevision, Date.now(), roomId,
      storyOwnerId, storyId, pin.revision, pin.sourceRevision,
    ),
    requireSelectableRevision: true,
  }], lease)
  return writeRoom(roomId, [statement(
    `UPDATE rooms SET story_id = ?, story_owner_id = ?, phase = 'playing', updated_at = ? WHERE room_id = ?`,
    storyId, storyOwnerId, Date.now(), roomId,
  )], lease)
}

export function updateRoomPhase(roomId: string, phase: RoomPhase, lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [statement('UPDATE rooms SET phase = ?, updated_at = ? WHERE room_id = ?', phase, Date.now(), roomId)], lease)
}

const updateSnapshotSql = 'state = ?, version = version + 1, updated_at = ?'

export interface RoomActionKey {
  userId: number
  actionId: string
}

export type RoomActionWrite =
  | (RoomActionKey & { status: 'pending' | 'completed'; payloadHash: string; messageId: string })
  | (RoomActionKey & { status: 'completed' | 'cancelled' })

interface RoomActionReceipt extends Row {
  payload_hash: string
  message_id: string
  status: RoomActionReceiptStatus
}

export function getRoomAction(roomId: string, userId: number, actionId: string): Promise<RoomActionReceipt | undefined> {
  return readOne<RoomActionReceipt>(
    'SELECT payload_hash, message_id, status FROM room_actions WHERE room_id = ? AND user_id = ? AND action_id = ?',
    roomId, userId, actionId,
  )
}

export const ROOM_EVENT_WINDOW = 200

export interface RoomCheckpoint {
  seq: number
  turnPending: boolean
  lease: RoomWorkerLease
  events: readonly { seq: number; type: string; payload: unknown }[]
  turn?: {
    id: string
    actionKeys: RoomActionKey[]
    outcome: 'completed' | 'failed' | 'cancelled'
    firstEventSeq: number | null
    lastEventSeq: number | null
  }
}

export function updateRoomStateSnapshot(
  roomId: string, stateJson: string, phase?: 'ended', actions: readonly RoomActionWrite[] = [], checkpoint?: RoomCheckpoint,
): Promise<void> {
  if (ROOM_WORKER_FAILOVER_ENABLED && !checkpoint) throw new RoomLeaseLostError()
  return writeRoom(roomId, roomStateSnapshotStatements(roomId, stateJson, phase, actions, checkpoint), checkpoint?.lease)
}

function roomStateSnapshotStatements(
  roomId: string, stateJson: string, phase: 'ended' | undefined, actions: readonly RoomActionWrite[], checkpoint?: RoomCheckpoint,
): Statement[] {
  const phaseUpdate = phase ? "phase = 'ended', " : ''
  const watermarkUpdate = checkpoint ? ', event_seq = ?, turn_pending = (? = 1)' : ''
  const sql = `UPDATE rooms SET ${phaseUpdate}${updateSnapshotSql}${watermarkUpdate} WHERE room_id = ?`
  const commands = [
    statement(sql, stateJson, Date.now(), ...(checkpoint ? [checkpoint.seq, checkpoint.turnPending ? 1 : 0] : []), roomId),
    ...actions.map((action) => 'payloadHash' in action
      ? statement(
        'INSERT INTO room_actions (room_id, user_id, action_id, payload_hash, message_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        roomId, action.userId, action.actionId, action.payloadHash, action.messageId, action.status,
      )
      : statement(
        "UPDATE room_actions SET status = ? WHERE room_id = ? AND user_id = ? AND action_id = ? AND status = 'pending'",
        action.status, roomId, action.userId, action.actionId,
      ),
    ),
  ]
  if (checkpoint?.turn) {
    const turn = checkpoint.turn
    commands.push(statement(
      `INSERT INTO room_turns (room_id, turn_id, epoch, action_keys, outcome, first_event_seq, last_event_seq)
       VALUES (?, ?, ?::bigint, ?::jsonb, ?, ?, ?)`,
      roomId, turn.id, checkpoint.lease.epoch, JSON.stringify(turn.actionKeys), turn.outcome, turn.firstEventSeq, turn.lastEventSeq,
    ))
  }
  if (checkpoint?.events.length) {
    commands.push(statement(
      `WITH written AS (
         INSERT INTO room_events (room_id, seq, event_type, payload)
         SELECT ?, batch.seq, batch.type, batch.payload
         FROM jsonb_to_recordset(?::jsonb) AS batch(seq bigint, type text, payload jsonb)
         RETURNING room_id, seq
       )
       INSERT INTO room_event_outbox (room_id, seq) SELECT room_id, seq FROM written`,
      roomId, JSON.stringify(checkpoint.events),
    ), statement(
      'DELETE FROM room_events WHERE room_id = ? AND seq <= ?',
      roomId, checkpoint.seq - ROOM_EVENT_WINDOW,
    ))
    const messages = checkpoint.events.flatMap((event) => event.type === 'message_appended'
      ? [(event.payload as { message: Message }).message]
      : [])
    if (messages.length) commands.push(statement(
      `INSERT INTO room_transcript (room_id, position, message_id, message)
       SELECT ?, latest.position + entry.ordinal, entry.message->>'id', entry.message
       FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS entry(message, ordinal)
       CROSS JOIN (
         SELECT COALESCE((SELECT position FROM room_transcript WHERE room_id = ? ORDER BY position DESC LIMIT 1), 0) AS position
       ) latest`,
      roomId, JSON.stringify(messages), roomId,
    ))
  }
  return commands
}

type SnapshotWrite = {
  roomId: string
  capture: () => { seq: number; stateJson: string }
  committed: (seq: number) => void
  failed: (error: unknown) => void
}

const pendingSnapshots: SnapshotWrite[] = []
let snapshotFlushScheduled = false

/** Concurrent turns share a commit. Each write resolves after the database commits it. */
export function queueTurnSnapshot(roomId: string, capture: SnapshotWrite['capture']): Promise<number> {
  return new Promise((committed, failed) => {
    pendingSnapshots.push({ roomId, capture, committed, failed })
    scheduleSnapshotFlush()
  })
}

function scheduleSnapshotFlush(): void {
  if (snapshotFlushScheduled || pendingSnapshots.length === 0) return
  snapshotFlushScheduled = true
  setImmediate(async () => {
    await flushTurnSnapshots(pendingSnapshots.splice(0, 32))
    snapshotFlushScheduled = false
    scheduleSnapshotFlush()
  })
}

async function flushTurnSnapshots(batch: SnapshotWrite[]): Promise<void> {
  try {
    // Capture the latest state so writes preserve settings changed while queued.
    const writes = batch.map((write) => ({ ...write, ...write.capture() }))
    const now = Date.now()
    await writeAll(writes.map((write) => statement(`UPDATE rooms SET ${updateSnapshotSql} WHERE room_id = ?`, write.stateJson, now, write.roomId)))
    for (const write of writes) write.committed(write.seq)
  } catch (error) {
    for (const write of batch) write.failed(error)
  }
}

export function updateRoomStateSettings(roomId: string, stateJson: string, lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [statement('UPDATE rooms SET state = ?, updated_at = ? WHERE room_id = ?', stateJson, Date.now(), roomId)], lease)
}

export function deleteRoomRows(roomId: string, lease?: RoomWorkerLease, disconnect?: OwnerDisconnect): Promise<void> {
  return writeRoom(roomId, [
    statement('DELETE FROM room_members WHERE room_id = ?', roomId),
    statement('DELETE FROM rooms WHERE room_id = ?', roomId),
  ], lease, disconnect)
}

export function insertMember(roomId: string, userId: number, role: 'owner' | 'member', lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [role === 'owner' ? ownerMember(roomId, userId, null) : statement(
    `INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'member', NULL)
     ON CONFLICT (room_id, user_id) DO NOTHING`, roomId, userId,
  )], lease)
}

export async function isRoomMember(roomId: string, userId: number): Promise<boolean> {
  return !!(await readOne('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId))
}

export async function memberRole(roomId: string, userId: number): Promise<string | null> {
  const row = await readOne<{ role: string }>('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId)
  return row?.role ?? null
}

const memberSelect = `SELECT m.user_id, m.role, m.character_id, m.ready, u.username
                      FROM room_members m JOIN users u ON m.user_id = u.id WHERE m.room_id = ?`

export function getRoomMember(roomId: string, userId: number): Promise<RoomMemberRow | undefined> {
  return readOne<RoomMemberRow & Row>(memberSelect + ' AND m.user_id = ?', roomId, userId)
}

export function listMembers(roomId: string): Promise<RoomMemberRow[]> {
  return readAll<RoomMemberRow & Row>(memberSelect, roomId)
}

export async function memberCharacterId(roomId: string, userId: number): Promise<string | null> {
  const row = await readOne<{ character_id: string | null }>('SELECT character_id FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId)
  return row?.character_id ?? null
}

export function bindMemberCharacter(roomId: string, userId: number, characterId: string, lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [statement('UPDATE room_members SET character_id = ? WHERE room_id = ? AND user_id = ?', characterId, roomId, userId)], lease)
}

export async function boundMemberOf(roomId: string, characterId: string, exceptUserId: number): Promise<number | null> {
  const row = await readOne<{ user_id: number }>(
    'SELECT user_id FROM room_members WHERE room_id = ? AND character_id = ? AND user_id != ?', roomId, characterId, exceptUserId,
  )
  return row?.user_id ?? null
}

export function setMemberReady(roomId: string, userId: number, ready: boolean, lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [statement(
    `UPDATE room_members SET ready = ? WHERE room_id = ? AND user_id = ? AND role = 'member'`, ready ? 1 : 0, roomId, userId,
  )], lease)
}

export function transferRoomOwnership(
  roomId: string, oldOwnerId: number, newOwnerId: number, lease?: RoomWorkerLease,
  removeOldOwner = false, disconnect?: OwnerDisconnect, dormant?: { stateJson: string; checkpoint: RoomCheckpoint },
): Promise<void> {
  return writeRoom(roomId, [
    removeOldOwner
      ? statement('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', roomId, oldOwnerId)
      : statement(`UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?`, roomId, oldOwnerId),
    statement(`UPDATE room_members SET role = 'owner', ready = 0 WHERE room_id = ? AND user_id = ?`, roomId, newOwnerId),
    statement(`UPDATE rooms SET owner_id = ?, story_owner_id = CASE
        WHEN story_id IS NOT NULL THEN COALESCE(story_owner_id, ?) ELSE story_owner_id END
      WHERE room_id = ?`, newOwnerId, oldOwnerId, roomId),
    ...(dormant ? roomStateSnapshotStatements(roomId, dormant.stateJson, undefined, [], dormant.checkpoint) : []),
  ], lease, disconnect)
}

export function deleteMemberRow(roomId: string, userId: number, lease?: RoomWorkerLease): Promise<void> {
  return writeRoom(roomId, [statement('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId)], lease)
}

export function listMembersOrdered(roomId: string): Promise<RoomMemberRow[]> {
  const order = SHARED_ROOMS_ENABLED ? 'm.join_order' : 'm.rowid'
  return readAll<RoomMemberRow & Row>(`${memberSelect} ORDER BY ${order} ASC`, roomId)
}

export async function usernameOf(userId: number): Promise<string | null> {
  const row = await readOne<{ username: string }>('SELECT username FROM users WHERE id = ?', userId)
  return row?.username ?? null
}

export async function characterOwnerUserId(characterId: string): Promise<number | null> {
  const row = await readOne<{ user_id: number }>('SELECT user_id FROM characters WHERE id = ?', characterId)
  return row?.user_id ?? null
}

function insertCharacterSql(id: string, userId: number, name: string, sheet: string): Statement {
  return statement('INSERT INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, ?, ?, ?)', id, userId, name, sheet, Date.now())
}

export function insertCharacter(id: string, userId: number, name: string, sheet: string): Promise<void> {
  return writeAll([insertCharacterSql(id, userId, name, sheet)])
}

export interface CharacterRow extends Row {
  id: string
  name: string
  sheet: string
  updated_at: number
}

export function listCharactersForUser(userId: number): Promise<CharacterRow[]> {
  return readAll<CharacterRow>('SELECT id, name, sheet, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC', userId)
}

export async function boundCharacterSheets(roomId: string): Promise<{ characterId: string; userId: number; sheet: string }[]> {
  const rows = await readAll<{ character_id: string; user_id: number; sheet: string }>(
    `SELECT m.character_id, m.user_id, c.sheet FROM room_members m
     JOIN characters c ON c.id = m.character_id WHERE m.room_id = ? AND m.character_id IS NOT NULL`, roomId,
  )
  return rows.map((b) => ({ characterId: b.character_id, userId: b.user_id, sheet: b.sheet }))
}

type OutboxRow = {
  room_id: string
  room_exists: boolean
  event_seq: string | null
  members: string[]
  seq: string | null
  event_type: string | null
  payload: unknown
}

interface RoomOutbox {
  roomId: string
  roomExists: boolean
  highWater: number | null
  members: Set<number>
  events: { seq: number; type: string; payload: unknown }[]
}

export async function readRoomOutbox(
  cursors: readonly { roomId: string; seq: number; userIds: number[] }[], limit = 16, maxBytes: number | null = null,
): Promise<RoomOutbox[]> {
  try {
    const { rows } = await getPostgresPool().query<OutboxRow>(
      'WITH cursors AS (' +
      ' SELECT * FROM jsonb_to_recordset($1) AS c(room_id text, seq bigint, users jsonb)' +
      ') SELECT c.room_id, r.room_id IS NOT NULL AS room_exists, r.event_seq, member_ids.members, e.seq, e.event_type, e.payload' +
      ' FROM cursors c LEFT JOIN rooms r ON r.room_id = c.room_id' +
      ' CROSS JOIN LATERAL (' +
      ' SELECT ARRAY(SELECT m.user_id::text FROM room_members m' +
      ' WHERE m.room_id = c.room_id AND c.users @> to_jsonb(ARRAY[m.user_id])) AS members' +
      ' ) member_ids' +
      ' LEFT JOIN LATERAL (' +
      ' SELECT sized.seq, sized.event_type, sized.payload FROM (' +
      ' SELECT selected.*, sum(CASE WHEN $3::bigint IS NULL THEN 0' +
      ' ELSE octet_length(selected.payload::text)::bigint + 256 END) OVER (ORDER BY selected.seq) AS bytes' +
      ' FROM (' +
      ' SELECT e.seq, e.event_type, e.payload FROM room_event_outbox o JOIN room_events e USING (room_id, seq)' +
      ' WHERE o.room_id = c.room_id AND o.seq > c.seq AND cardinality(member_ids.members) > 0' +
      ' AND ($3::bigint IS NULL OR r.event_seq BETWEEN c.seq AND c.seq + $2::bigint)' +
      ' ORDER BY o.seq LIMIT $2' +
      ' ) selected' +
      ' ) sized WHERE $3::bigint IS NULL OR sized.bytes <= $3::bigint' +
      ' ) e ON true ORDER BY c.room_id, e.seq',
      [JSON.stringify(cursors.map(({ roomId, seq, userIds }) => ({ room_id: roomId, seq, users: userIds }))), limit, maxBytes],
    )
    const rooms = new Map<string, RoomOutbox>()
    for (const row of rows) {
      let room = rooms.get(row.room_id)
      if (!room) {
        room = {
          roomId: row.room_id,
          roomExists: row.room_exists,
          highWater: row.event_seq === null ? null : Number(row.event_seq),
          members: new Set(row.members.map(Number)),
          events: [],
        }
        rooms.set(row.room_id, room)
      }
      if (row.seq !== null && row.event_type !== null) {
        room.events.push({ seq: Number(row.seq), type: row.event_type, payload: row.payload })
      }
    }
    return [...rooms.values()]
  } catch (error) {
    throw postgresError(error)
  }
}

const roomPresenceTtl = "interval '15 seconds'"

export async function registerRoomPresence(roomId: string, userId: number, subscriptionId: string): Promise<boolean> {
  return inPostgresTransaction(async (client) => {
    // Serialize a new subscriber with the fenced absence check before succession.
    const room = await client.query('SELECT 1 FROM rooms WHERE room_id = $1 FOR NO KEY UPDATE', [roomId])
    if (!room.rowCount) return false
    const member = await client.query(`
      INSERT INTO room_gateway_presence (room_id, user_id, subscription_id, expires_at)
      SELECT room_id, user_id, $3, clock_timestamp() + ${roomPresenceTtl}
      FROM room_members WHERE room_id = $1 AND user_id = $2
      ON CONFLICT (room_id, user_id, subscription_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `, [roomId, userId, subscriptionId])
    if (member.rowCount) {
      await client.query('DELETE FROM room_commands WHERE room_id = $1 AND user_id = $2 AND presence_loss', [roomId, userId])
    }
    return member.rowCount === 1
  })
}

async function enqueueOwnerPresenceLoss(client: PoolClient, roomId: string, userId: number): Promise<void> {
  // The presence-loss request and deletion of the final live subscription
  // survive worker downtime together. Leave room for interactive commands.
  await client.query('SELECT pg_advisory_xact_lock(17407, 121)')
  await client.query(
    'DELETE FROM room_commands WHERE room_id = $1 AND user_id = $2 AND presence_loss AND expires_at <= clock_timestamp()',
    [roomId, userId],
  )
  const requestId = randomUUID()
  const result = await client.query(`
    INSERT INTO room_commands (request_id, room_id, user_id, command, expires_at, presence_loss)
    SELECT $1, $2, $3, $4, clock_timestamp() + interval '5 minutes', true
    WHERE (SELECT count(*) FROM room_commands WHERE presence_loss AND expires_at > clock_timestamp()) < 4096
    ON CONFLICT (room_id, user_id) WHERE presence_loss DO NOTHING
  `, [requestId, roomId, userId, JSON.stringify({ name: 'disconnected', args: [requestId] })])
  if (!result.rowCount) {
    const alreadyQueued = await client.query('SELECT 1 FROM room_commands WHERE presence_loss AND room_id = $1 AND user_id = $2', [roomId, userId])
    if (!alreadyQueued.rowCount) throw new Error('Durable room presence-loss queue is full')
  }
}

export async function removeRoomPresence(entry: RoomPresence, isOrdinary: () => boolean): Promise<void> {
  const { roomId, userId, subscriptionId } = entry
  const remove = `DELETE FROM room_gateway_presence WHERE room_id = $1 AND user_id = $2 AND subscription_id = $3
    RETURNING expires_at > clock_timestamp() AS live`
  if (!isOrdinary()) {
    await getPostgresPool().query(remove, [roomId, userId, subscriptionId])
    return
  }
  await inPostgresTransaction(async (client) => {
    const room = await client.query<{ current_owner: boolean }>(`
      SELECT owner_id = $2 AND kind = 'multi' AND phase <> 'ended' AS current_owner
      FROM rooms WHERE room_id = $1 FOR NO KEY UPDATE
    `, [roomId, userId])
    if (!room.rowCount) return
    const removed = await client.query<{ live: boolean }>(remove, [roomId, userId, subscriptionId])
    if (!removed.rows[0]?.live || !room.rows[0]?.current_owner || !isOrdinary()) return
    const others = await client.query(
      'SELECT 1 FROM room_gateway_presence WHERE room_id = $1 AND user_id = $2 AND expires_at > clock_timestamp() LIMIT 1',
      [roomId, userId],
    )
    if (!others.rowCount && isOrdinary()) await enqueueOwnerPresenceLoss(client, roomId, userId)
  })
}

export interface RoomPresence {
  roomId: string
  userId: number
  subscriptionId: string
}

export async function renewRoomPresence(entries: RoomPresence[]): Promise<Set<string>> {
  const result = await getPostgresPool().query<{ subscription_id: string }>(`
    UPDATE room_gateway_presence AS presence SET expires_at = clock_timestamp() + ${roomPresenceTtl}
    FROM unnest($1::text[], $2::bigint[], $3::uuid[]) AS local(room_id, user_id, subscription_id)
    WHERE (presence.room_id, presence.user_id, presence.subscription_id) =
      (local.room_id, local.user_id, local.subscription_id)
      AND presence.expires_at > clock_timestamp()
    RETURNING presence.subscription_id
  `, [entries.map((entry) => entry.roomId), entries.map((entry) => entry.userId), entries.map((entry) => entry.subscriptionId)])
  return new Set(result.rows.map((row) => row.subscription_id))
}

export async function reapRoomPresence(): Promise<void> {
  // Absence alone is inert. A gateway crash only leaves rows that age out.
  await getPostgresPool().query(`
    DELETE FROM room_gateway_presence WHERE (room_id, user_id, subscription_id) IN (
      SELECT room_id, user_id, subscription_id FROM room_gateway_presence
      WHERE expires_at <= clock_timestamp() - interval '15 seconds'
      ORDER BY expires_at LIMIT 4096 FOR UPDATE SKIP LOCKED
    )
  `)
}

import type { SQLInputValue } from 'node:sqlite'
import { types, type PoolClient } from 'pg'
import { getDb } from '../db/index.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { SHARED_ROOMS_ENABLED } from '../config.js'
import { parseRoomState } from './roomStateCodec.js'
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

async function writeAll(commands: Statement[]): Promise<void> {
  if (SHARED_ROOMS_ENABLED) {
    const execute = async (client: Pick<PoolClient, 'query'>) => {
      for (const command of commands) {
        const result = await client.query(pgQuery(command))
        if (command.requireSelectableRevision && result.rowCount !== 1) throw new StoryRevisionChangedError()
      }
    }
    try {
      if (commands.length > 1) await inPostgresTransaction(execute)
      else await execute(getPostgresPool())
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

export interface StoryRevisionPin {
  revision: string
  sourceRevision: string
}

const selectableRevisionSql = `SELECT 1 FROM story_catalog
  WHERE owner_id = ? AND story_id = ? AND active_preparation_revision = ?
    AND source_revision = ? AND deleted_at IS NULL FOR SHARE`

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
  return readOne<RoomRow & Row>(
    `SELECT room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, created_at${revisionColumns}
     FROM rooms WHERE room_id = ?`, roomId,
  )
}

export function updateRoomStart(roomId: string, storyId: string, storyOwnerId: number, pin?: StoryRevisionPin): Promise<void> {
  if (pin) return writeAll([{
    ...statement(
      `UPDATE rooms SET story_id = ?, story_owner_id = ?, story_preparation_revision = ?,
         story_source_revision = ?, phase = 'playing', updated_at = ?
       WHERE room_id = ? AND story_preparation_revision IS NULL AND EXISTS (${selectableRevisionSql})`,
      storyId, storyOwnerId, pin.revision, pin.sourceRevision, Date.now(), roomId,
      storyOwnerId, storyId, pin.revision, pin.sourceRevision,
    ),
    requireSelectableRevision: true,
  }])
  return writeAll([statement(
    `UPDATE rooms SET story_id = ?, story_owner_id = ?, phase = 'playing', updated_at = ? WHERE room_id = ?`,
    storyId, storyOwnerId, Date.now(), roomId,
  )])
}

export function updateRoomPhase(roomId: string, phase: RoomPhase): Promise<void> {
  return writeAll([statement('UPDATE rooms SET phase = ?, updated_at = ? WHERE room_id = ?', phase, Date.now(), roomId)])
}

const updateSnapshotSql = 'UPDATE rooms SET state = ?, version = version + 1, updated_at = ? WHERE room_id = ?'

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

export function updateRoomStateSnapshot(
  roomId: string, stateJson: string, phase?: 'ended', actions: readonly RoomActionWrite[] = [],
): Promise<void> {
  const sql = phase ? "UPDATE rooms SET phase = 'ended', state = ?, version = version + 1, updated_at = ? WHERE room_id = ?" : updateSnapshotSql
  return writeAll([
    statement(sql, stateJson, Date.now(), roomId),
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
  ])
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
    await writeAll(writes.map((write) => statement(updateSnapshotSql, write.stateJson, now, write.roomId)))
    for (const write of writes) write.committed(write.seq)
  } catch (error) {
    for (const write of batch) write.failed(error)
  }
}

export function updateRoomStateSettings(roomId: string, stateJson: string): Promise<void> {
  return writeAll([statement('UPDATE rooms SET state = ?, updated_at = ? WHERE room_id = ?', stateJson, Date.now(), roomId)])
}

export function deleteRoomRows(roomId: string): Promise<void> {
  return writeAll([
    statement('DELETE FROM room_members WHERE room_id = ?', roomId),
    statement('DELETE FROM rooms WHERE room_id = ?', roomId),
  ])
}

export function insertMember(roomId: string, userId: number, role: 'owner' | 'member'): Promise<void> {
  return writeAll([role === 'owner' ? ownerMember(roomId, userId, null) : statement(
    `INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'member', NULL)
     ON CONFLICT (room_id, user_id) DO NOTHING`, roomId, userId,
  )])
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

export function bindMemberCharacter(roomId: string, userId: number, characterId: string): Promise<void> {
  return writeAll([statement('UPDATE room_members SET character_id = ? WHERE room_id = ? AND user_id = ?', characterId, roomId, userId)])
}

export async function boundMemberOf(roomId: string, characterId: string, exceptUserId: number): Promise<number | null> {
  const row = await readOne<{ user_id: number }>(
    'SELECT user_id FROM room_members WHERE room_id = ? AND character_id = ? AND user_id != ?', roomId, characterId, exceptUserId,
  )
  return row?.user_id ?? null
}

export function setMemberReady(roomId: string, userId: number, ready: boolean): Promise<void> {
  return writeAll([statement(
    `UPDATE room_members SET ready = ? WHERE room_id = ? AND user_id = ? AND role = 'member'`, ready ? 1 : 0, roomId, userId,
  )])
}

export function transferRoomOwnership(roomId: string, oldOwnerId: number, newOwnerId: number): Promise<void> {
  return writeAll([
    statement(`UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?`, roomId, oldOwnerId),
    statement(`UPDATE room_members SET role = 'owner', ready = 0 WHERE room_id = ? AND user_id = ?`, roomId, newOwnerId),
    statement('UPDATE rooms SET owner_id = ? WHERE room_id = ?', newOwnerId, roomId),
  ])
}

export function deleteMemberRow(roomId: string, userId: number): Promise<void> {
  return writeAll([statement('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId)])
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

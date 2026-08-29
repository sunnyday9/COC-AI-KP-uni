/**
 * RoomStorage — 房间领域持久化 adapter（架构评审候选 2 / ADR-0001）。
 *
 * 拥有 rooms / room_members 两张表的**全部** SQL：RoomService 的领域方法是它的
 * 唯一调用方，REST 路由与 ws 层不接触房间表结构。users/characters 表的少量
 * 邻接读写（username 解析、角色卡归属/sheet、createSoloRoom 一体动作的角色卡
 * 落库）也在此，供领域方法组装领域对象。
 * 外部 id 只作为 DB 键进入查询（D-09 DB 映射：不落 fs 路径）。
 */
import { getDb } from '../db/index.js'

export interface RoomRow {
  room_id: string
  owner_id: number
  invite_code: string
  story_id: string | null
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
}

export interface RoomListItemRow {
  roomId: string
  inviteCode: string
  storyId: string | null
  phase: string
  updatedAt: number
}

/** solo 房间列表行（继续游戏；无 inviteCode——solo 不用邀请码入房）。 */
export interface SoloRoomListItemRow {
  roomId: string
  storyId: string | null
  phase: string
  updatedAt: number
  /** 进度摘要 = 消息流最后一条的非玩家侧内容截断（首页展示用）。 */
  preview: string
}

/* ═══════════════ rooms 表 ═══════════════ */

export function insertRoom(
  roomId: string,
  ownerId: number,
  inviteCode: string,
  storyId: string | null,
  kind: 'multi' | 'solo' = 'multi',
): void {
  const now = Date.now()
  getDb()
    .prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, version, updated_at, created_at)
              VALUES (?, ?, ?, ?, ?, 'lobby', '{}', 0, ?, ?)`)
    .run(roomId, ownerId, inviteCode, storyId, kind, now, now)
}

export function inviteCodeExists(code: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM rooms WHERE invite_code = ?`).get(code)
}

export function findRoomIdByInviteCode(inviteCode: string): string | null {
  const row = getDb().prepare(`SELECT room_id FROM rooms WHERE invite_code = ?`).get(inviteCode) as
    | { room_id: string }
    | undefined
  return row?.room_id ?? null
}

/** 房间列表（ADR-0002：solo 房间不出现在房间列表——继续游戏走 listSoloRoomsForUser）。 */
export function listRoomsForUser(userId: number): RoomListItemRow[] {
  const rows = getDb()
    .prepare(`SELECT r.room_id, r.invite_code, r.story_id, r.phase, r.updated_at
              FROM rooms r JOIN room_members m ON r.room_id = m.room_id
              WHERE m.user_id = ? AND r.kind != 'solo' ORDER BY r.updated_at DESC`)
    .all(userId) as { room_id: string; invite_code: string; story_id: string | null; phase: string; updated_at: number }[]
  return rows.map((r) => ({ roomId: r.room_id, inviteCode: r.invite_code, storyId: r.story_id, phase: r.phase, updatedAt: r.updated_at }))
}

/** 未结束 solo 房间列表（继续游戏入口，ADR-0002）。 */
export function listSoloRoomsForUser(userId: number): SoloRoomListItemRow[] {
  const rows = getDb()
    .prepare(`SELECT r.room_id, r.story_id, r.phase, r.updated_at, r.state
              FROM rooms r JOIN room_members m ON r.room_id = m.room_id
              WHERE m.user_id = ? AND r.kind = 'solo' AND r.phase != 'ended' ORDER BY r.updated_at DESC`)
    .all(userId) as { room_id: string; story_id: string | null; phase: string; updated_at: number; state: string }[]
  return rows.map((r) => {
    let preview = ''
    try {
      const msgs = (JSON.parse(r.state) as { messages?: { role: string; content?: unknown }[] }).messages
      const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined
      if (last && typeof last.content === 'string') preview = last.content.slice(0, 50)
    } catch { /* 脏 state 忽略摘要 */ }
    return { roomId: r.room_id, storyId: r.story_id, phase: r.phase, updatedAt: r.updated_at, preview }
  })
}

export function getRoomRow(roomId: string): RoomRow | undefined {
  return getDb()
    .prepare(`SELECT room_id, owner_id, invite_code, story_id, kind, phase, state, created_at FROM rooms WHERE room_id = ?`)
    .get(roomId) as RoomRow | undefined
}

export function updateRoomStart(roomId: string, storyId: string): void {
  getDb()
    .prepare(`UPDATE rooms SET story_id = ?, phase = 'playing', updated_at = ? WHERE room_id = ?`)
    .run(storyId, Date.now(), roomId)
}

/** 节流快照落库（RoomService.persistSnapshot）：bump version。 */
export function updateRoomStateSnapshot(roomId: string, stateJson: string): void {
  getDb()
    .prepare(`UPDATE rooms SET state = ?, version = version + 1, updated_at = ? WHERE room_id = ?`)
    .run(stateJson, Date.now(), roomId)
}

/** 设置类小写（setRoomTurnWindow）：不 bump version（与旧路由行为一致）。 */
export function updateRoomStateSettings(roomId: string, stateJson: string): void {
  getDb().prepare(`UPDATE rooms SET state = ?, updated_at = ? WHERE room_id = ?`).run(stateJson, Date.now(), roomId)
}

export function deleteRoomRows(roomId: string): void {
  getDb().prepare(`DELETE FROM room_members WHERE room_id = ?`).run(roomId)
  getDb().prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId)
}

/** 共享连接（事务用：BEGIN/COMMIT/ROLLBACK 包住同连接上的顺序写）。 */
export function tx(): ReturnType<typeof getDb> {
  return getDb()
}

/* ═══════════════ room_members 表 ═══════════════ */

export function insertMember(roomId: string, userId: number, role: 'owner' | 'member'): void {
  if (role === 'owner') {
    getDb().prepare(`INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'owner', NULL)`).run(roomId, userId)
  } else {
    getDb().prepare(`INSERT OR IGNORE INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'member', NULL)`).run(roomId, userId)
  }
}

export function isRoomMember(roomId: string, userId: number): boolean {
  return !!getDb().prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`).get(roomId, userId)
}

export function memberRole(roomId: string, userId: number): string | null {
  const row = getDb().prepare(`SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`).get(roomId, userId) as
    | { role: string }
    | undefined
  return row?.role ?? null
}

/** 成员列表（JOIN users；列名为 snake_case，由调用方映射 camelCase）。 */
export function listMembers(roomId: string): RoomMemberRow[] {
  return getDb()
    .prepare(`SELECT m.user_id, m.role, m.character_id, u.username
              FROM room_members m JOIN users u ON m.user_id = u.id WHERE m.room_id = ?`)
    .all(roomId) as unknown as RoomMemberRow[]
}

export function memberCharacterId(roomId: string, userId: number): string | null {
  const rows = getDb()
    .prepare(`SELECT character_id FROM room_members WHERE room_id = ? AND user_id = ?`)
    .all(roomId, userId) as unknown as { character_id: string | null }[]
  return rows[0]?.character_id ?? null
}

export function bindMemberCharacter(roomId: string, userId: number, characterId: string): void {
  getDb().prepare(`UPDATE room_members SET character_id = ? WHERE room_id = ? AND user_id = ?`).run(characterId, roomId, userId)
}

/** 一人一卡校验：该角色卡在本房间内已被其他成员绑定 → 返回其 userId。 */
export function boundMemberOf(roomId: string, characterId: string, exceptUserId: number): number | null {
  const rows = getDb()
    .prepare(`SELECT user_id FROM room_members WHERE room_id = ? AND character_id = ? AND user_id != ?`)
    .all(roomId, characterId, exceptUserId) as unknown as { user_id: number }[]
  return rows[0]?.user_id ?? null
}

/* ═══════════════ 邻接只读（users / characters；供领域方法组装领域对象） ═══════════════ */

/** username 解析（chat 领域方法用）。 */
export function usernameOf(userId: number): string | null {
  const row = getDb().prepare(`SELECT username FROM users WHERE id = ?`).get(userId) as { username: string } | undefined
  return row?.username ?? null
}

/** 角色卡归属（bind 校验：仅本人）。 */
export function characterOwnerUserId(characterId: string): number | null {
  const rows = getDb().prepare(`SELECT user_id FROM characters WHERE id = ?`).all(characterId) as unknown as { user_id: number }[]
  return rows[0]?.user_id ?? null
}

/** 角色卡落库（createSoloRoom 一体动作；id 由领域方法生成）。 */
export function insertCharacter(characterId: string, userId: number, name: string, sheetJson: string): void {
  getDb().prepare(`INSERT INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, ?, ?, ?)`).run(characterId, userId, name, sheetJson, Date.now())
}

/** 单张角色卡 sheet（bind 后同步活跃实例用）。 */
export function characterSheetJson(characterId: string): string | null {
  const rows = getDb().prepare(`SELECT sheet FROM characters WHERE id = ?`).all(characterId) as unknown as { sheet: string }[]
  return rows[0]?.sheet ?? null
}

/** 房间角色组绑定（sheet 从 characters 表加载——syncFromDb 用）。 */
export function boundCharacterSheets(roomId: string): { characterId: string; userId: number; sheet: string }[] {
  const rows = getDb()
    .prepare(`SELECT m.character_id, m.user_id, c.sheet FROM room_members m
              JOIN characters c ON c.id = m.character_id WHERE m.room_id = ? AND m.character_id IS NOT NULL`)
    .all(roomId) as unknown as { character_id: string; user_id: number; sheet: string }[]
  return rows.map((b) => ({ characterId: b.character_id, userId: b.user_id, sheet: b.sheet }))
}

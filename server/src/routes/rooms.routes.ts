/**
 * Room routes (Phase B1, 架构方案 v2.0 FR-M1/M2/M11) — 房间生命周期。
 *  - POST   /api/rooms           创建房间（owner，返回 inviteCode）
 *  - GET    /api/rooms           我的房间列表（owner 或 member）
 *  - GET    /api/rooms/:id       房间详情（成员/阶段/剧本）
 *  - POST   /api/rooms/join      邀请码加入
 *  - POST   /api/rooms/:id/start 房主开始游戏（绑定剧本）
 *  - DELETE /api/rooms/:id       房主解散
 */
import { Router } from 'express'
import crypto from 'node:crypto'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'
import { getDb } from '../db/index.js'

const router = Router()

router.use(requireAuth)

/** 6 位随机邀请码（字母数字，去易混字符）。 */
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i]! % chars.length]
  }
  return code
}

function ensureUniqueInviteCode(): string {
  const db = getDb()
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateInviteCode()
    const hit = db.prepare(`SELECT 1 FROM rooms WHERE invite_code = ?`).get(code)
    if (!hit) return code
  }
  throw new Error('failed to generate unique invite code')
}

interface RoomRow {
  room_id: string
  owner_id: number
  invite_code: string
  story_id: string | null
  phase: string
  state: string
  created_at: number
}

/** POST /api/rooms — 创建房间（单人模式 = 隐式建房，FR-M9）。 */
router.post('/', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const username = (req as AuthRequest & { user?: { username?: string } }).user?.username ?? `user_${userId}`
  const storyId = (req.body as { storyId?: unknown } | undefined)?.storyId
  const roomId = `room_${crypto.randomUUID().slice(0, 8)}`
  const inviteCode = ensureUniqueInviteCode()
  const db = getDb()
  db.prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, phase, state, version, updated_at, created_at)
              VALUES (?, ?, ?, ?, 'lobby', '{}', 0, ?, ?)`)
    .run(roomId, userId, inviteCode, typeof storyId === 'string' ? storyId : null, Date.now(), Date.now())
  db.prepare(`INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'owner', NULL)`)
    .run(roomId, userId)
  res.json({ ok: true, roomId, inviteCode, ownerId: userId, ownerName: username })
})

/** GET /api/rooms — 我的房间列表。 */
router.get('/', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const rows = getDb()
    .prepare(`SELECT r.room_id, r.invite_code, r.story_id, r.phase, r.updated_at
              FROM rooms r JOIN room_members m ON r.room_id = m.room_id
              WHERE m.user_id = ? ORDER BY r.updated_at DESC`)
    .all(userId) as { room_id: string; invite_code: string; story_id: string | null; phase: string; updated_at: number }[]
  res.json(rows.map((r) => ({ roomId: r.room_id, inviteCode: r.invite_code, storyId: r.story_id, phase: r.phase, updatedAt: r.updated_at })))
})

/** POST /api/rooms/join — 邀请码加入。 */
router.post('/join', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const inviteCode = String((req.body as { inviteCode?: unknown } | undefined)?.inviteCode ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(inviteCode)) {
    sendError(res, new BadRequestError('invalid invite code'))
    return
  }
  const db = getDb()
  const room = db.prepare(`SELECT room_id FROM rooms WHERE invite_code = ?`).get(inviteCode) as { room_id: string } | undefined
  if (!room) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  db.prepare(`INSERT OR IGNORE INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'member', NULL)`)
    .run(room.room_id, userId)
  res.json({ ok: true, roomId: room.room_id })
})

/** GET /api/rooms/:id — 房间详情（成员/阶段/剧本）。 */
router.get('/:id', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const db = getDb()
  const member = db.prepare(`SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`).get(roomId, userId) as { role: string } | undefined
  if (!member) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  const room = db.prepare(`SELECT room_id, owner_id, invite_code, story_id, phase, state, created_at FROM rooms WHERE room_id = ?`)
    .get(roomId) as RoomRow | undefined
  if (!room) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  const members = db.prepare(`SELECT m.user_id, m.role, m.character_id, u.username
                              FROM room_members m JOIN users u ON m.user_id = u.id WHERE m.room_id = ?`)
    .all(roomId) as { user_id: number; role: string; character_id: string | null; username: string }[]
  let state: unknown = {}
  try { state = JSON.parse(room.state) } catch { state = {} }
  res.json({
    roomId: room.room_id,
    inviteCode: room.invite_code,
    storyId: room.story_id,
    phase: room.phase,
    ownerId: room.owner_id,
    members: members.map((m) => ({ userId: m.user_id, username: m.username, role: m.role, characterId: m.character_id })),
    state,
    createdAt: room.created_at,
  })
})

/** POST /api/rooms/:id/start — 房主开始游戏（绑定剧本）。 */
router.post('/:id/start', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const storyId = String((req.body as { storyId?: unknown } | undefined)?.storyId ?? '')
  const db = getDb()
  const room = db.prepare(`SELECT owner_id, phase FROM rooms WHERE room_id = ?`).get(roomId) as { owner_id: number; phase: string } | undefined
  if (!room) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  if (room.owner_id !== userId) {
    sendError(res, new ConflictError('only the owner can start the game'))
    return
  }
  if (!storyId) {
    sendError(res, new BadRequestError('storyId required'))
    return
  }
  db.prepare(`UPDATE rooms SET story_id = ?, phase = 'playing', updated_at = ? WHERE room_id = ?`)
    .run(storyId, Date.now(), roomId)
  res.json({ ok: true })
})

/** POST /api/rooms/:id/character — 绑定角色卡到房间（一人一卡，Phase B4）。 */
router.post('/:id/character', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const charId = String((req.body as { characterId?: unknown } | undefined)?.characterId ?? '')
  const db = getDb()

  // 房间成员校验
  const memberRows = db.prepare(`SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`).all(roomId, userId) as unknown as { role: string }[]
  const member = memberRows[0]
  if (!member) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  // 角色卡归属校验（仅本人）
  const charRows = db.prepare(`SELECT user_id FROM characters WHERE id = ?`).all(charId) as unknown as { user_id: number }[]
  const char = charRows[0]
  if (!char || char.user_id !== userId) {
    sendError(res, new NotFoundError('character not found'))
    return
  }
  // 一人一卡：该角色卡已被他人绑定 → 409
  const bound = db.prepare(`SELECT user_id FROM room_members WHERE room_id = ? AND character_id = ? AND user_id != ?`).all(roomId, charId, userId)
  if (bound.length > 0) {
    sendError(res, new ConflictError('character already bound to another member'))
    return
  }
  db.prepare(`UPDATE room_members SET character_id = ? WHERE room_id = ? AND user_id = ?`).run(charId, roomId, userId)
  res.json({ ok: true, roomId, characterId: charId })
})

/** DELETE /api/rooms/:id — 房主解散。 */
router.delete('/:id', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const db = getDb()
  const room = db.prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(roomId) as { owner_id: number } | undefined
  if (!room) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  if (room.owner_id !== userId) {
    sendError(res, new ConflictError('only the owner can dissolve the room'))
    return
  }
  db.prepare(`DELETE FROM room_members WHERE room_id = ?`).run(roomId)
  db.prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId)
  res.json({ ok: true })
})

export default router

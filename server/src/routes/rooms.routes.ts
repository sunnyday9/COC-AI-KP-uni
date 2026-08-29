/**
 * Room routes (Phase B1, 架构方案 v2.0 FR-M1/M2/M11) — 房间生命周期。
 *  - POST   /api/rooms           创建房间（owner，返回 inviteCode）
 *  - GET    /api/rooms           我的房间列表（owner 或 member）
 *  - GET    /api/rooms/:id       房间详情（成员/阶段/剧本）
 *  - POST   /api/rooms/join      邀请码加入
 *  - POST   /api/rooms/:id/start 房主开始游戏（绑定剧本）
 *  - DELETE /api/rooms/:id       房主解散
 *
 * ADR-0001：路由只做「解析请求 → 调 RoomService 领域方法 → 映射响应」，
 * 不接触 rooms/room_members 表结构（SQL 收口在 roomStorage，经 RoomService）。
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'
import {
  bindRoomCharacter,
  createRoom,
  deleteRoomAsOwner,
  getRoomDetail,
  joinRoomByInviteCode,
  listRoomsForUser,
  startRoom,
} from '../services/roomService.js'

const router = Router()

router.use(requireAuth)

/** 领域失败结果 → HTTP 错误（状态码语义与旧实现逐一对齐）。 */
function sendDomainError(
  res: import('express').Response,
  fail: { reason: 'not-found' | 'not-owner' | 'bad-request' | 'conflict'; message: string },
): void {
  if (fail.reason === 'not-found') sendError(res, new NotFoundError(fail.message))
  else if (fail.reason === 'conflict' || fail.reason === 'not-owner') sendError(res, new ConflictError(fail.message))
  else sendError(res, new BadRequestError(fail.message))
}

/** POST /api/rooms — 创建房间（单人模式 = 隐式建房，FR-M9）。 */
router.post('/', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const username = (req as AuthRequest & { user?: { username?: string } }).user?.username ?? `user_${userId}`
  const storyId = (req.body as { storyId?: unknown } | undefined)?.storyId
  const { roomId, inviteCode } = createRoom(userId, typeof storyId === 'string' ? storyId : null)
  res.json({ ok: true, roomId, inviteCode, ownerId: userId, ownerName: username })
})

/** GET /api/rooms — 我的房间列表。 */
router.get('/', (req: AuthRequest, res) => {
  res.json(listRoomsForUser(req.userId as number))
})

/** POST /api/rooms/join — 邀请码加入。 */
router.post('/join', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const inviteCode = String((req.body as { inviteCode?: unknown } | undefined)?.inviteCode ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(inviteCode)) {
    sendError(res, new BadRequestError('invalid invite code'))
    return
  }
  const result = joinRoomByInviteCode(userId, inviteCode)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId })
})

/** GET /api/rooms/:id — 房间详情（成员/阶段/剧本）。 */
router.get('/:id', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = getRoomDetail(userId, roomId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json(result.detail)
})

/** POST /api/rooms/:id/start — 房主开始游戏（绑定剧本）。 */
router.post('/:id/start', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const storyId = String((req.body as { storyId?: unknown } | undefined)?.storyId ?? '')
  const result = startRoom(userId, roomId, storyId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/character — 绑定角色卡到房间（一人一卡，Phase B4）。 */
router.post('/:id/character', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const charId = String((req.body as { characterId?: unknown } | undefined)?.characterId ?? '')
  const result = bindRoomCharacter(userId, roomId, charId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId, characterId: result.characterId })
})

/** DELETE /api/rooms/:id — 房主解散。 */
router.delete('/:id', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = deleteRoomAsOwner(userId, roomId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

export default router

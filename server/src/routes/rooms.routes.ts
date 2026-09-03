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
  createSoloRoom,
  deleteRoomAsOwner,
  getRoomDetail,
  joinRoomByInviteCode,
  kickRoomMember,
  leaveRoomAsMember,
  listRoomsForUser,
  listSoloRoomsForUser,
  setMemberReady,
  startRoom,
  transferOwnership,
} from '../services/roomService.js'

const router = Router()

router.use(requireAuth)

/** 领域失败结果 → HTTP 错误（状态码语义与旧实现逐一对齐；RoomGovernanceFail 通用）。
 *  not-member 复用 not-found 的 404 语义；not-owner/conflict → 409。 */
function sendDomainError(
  res: import('express').Response,
  fail: { reason: 'not-found' | 'not-owner' | 'not-member' | 'conflict' | 'bad-request'; message: string },
): void {
  if (fail.reason === 'not-found' || fail.reason === 'not-member') sendError(res, new NotFoundError(fail.message))
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

/** POST /api/rooms/solo — 单人开局一体动作（ADR-0002：落角色卡 + 建 solo 房 + 绑卡 + start）。 */
router.post('/solo', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const body = (req.body ?? {}) as { storyId?: unknown; name?: unknown; sheet?: unknown }
  const result = createSoloRoom(userId, { storyId: body.storyId, name: body.name, sheet: body.sheet })
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId, inviteCode: result.inviteCode, characterId: result.characterId })
})

/** GET /api/rooms/solo — 未结束单人局列表（继续游戏）。 */
router.get('/solo', (req: AuthRequest, res) => {
  res.json(listSoloRoomsForUser(req.userId as number))
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

/** POST /api/rooms/:id/ready — 成员就绪/取消（ADR-0005 等待室软信号；body { ready }）。 */
router.post('/:id/ready', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const ready = (req.body as { ready?: unknown } | undefined)?.ready === true
  const result = setMemberReady(userId, roomId, ready)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/leave — 成员主动离开（删行+广播；owner 离开→转让/解散）。 */
router.post('/:id/leave', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = leaveRoomAsMember(userId, roomId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** DELETE /api/rooms/:id/members/:userId — 房主踢出成员（owner only）。 */
router.delete('/:id/members/:userId', (req: AuthRequest, res) => {
  const callerUserId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const targetUserId = Number(req.params.userId)
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    sendError(res, new BadRequestError('invalid userId'))
    return
  }
  const result = kickRoomMember(callerUserId, roomId, targetUserId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/transfer — 房主主动转让（body { userId } → 新 owner）。 */
router.post('/:id/transfer', (req: AuthRequest, res) => {
  const callerUserId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const targetUserId = Number((req.body as { userId?: unknown } | undefined)?.userId)
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    sendError(res, new BadRequestError('invalid userId'))
    return
  }
  const result = transferOwnership(callerUserId, roomId, targetUserId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
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

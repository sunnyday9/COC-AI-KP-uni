/**
 * Room routes (Phase B1, 架构方案 v2.0 FR-M1/M2/M11) — 房间生命周期。
 *  - POST   /api/rooms           创建房间（owner，返回 inviteCode）
 *  - GET    /api/rooms           我的房间列表（owner 或 member）
 *  - GET    /api/rooms/:id       房间详情（成员/阶段/剧本）
 *  - POST   /api/rooms/join      邀请码加入
 *  - POST   /api/rooms/:id/start 房主开始游戏（绑定剧本）
 *  - POST   /api/rooms/:id/end   房主结束游戏
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
  createRoom,
  createSoloRoom,
  getRoomDetail,
  getRoomHistory,
  listRoomsForUser,
  listSoloRoomsForUser,
} from '../services/roomService.js'

import { routeRoomInvite, routeRoomMutation } from '../services/roomCommands.js'
import { roomRequestSignal } from './roomRequestSignal.js'

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

/** POST /api/rooms — 创建房间（单人模式 = 隐式建房，FR-M9）。body.workflow 可选（实验分支双轨）。 */
router.post('/', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const username = (req as AuthRequest & { user?: { username?: string } }).user?.username ?? `user_${userId}`
  const body = (req.body ?? {}) as { storyId?: unknown; workflow?: unknown }
  const storyId = body.storyId
  const { roomId, inviteCode } = await createRoom(userId, typeof storyId === 'string' ? storyId : null, { workflow: body.workflow })
  res.json({ ok: true, roomId, inviteCode, ownerId: userId, ownerName: username })
})

/** GET /api/rooms — 我的房间列表。 */
router.get('/', async (req: AuthRequest, res) => {
  res.json(await listRoomsForUser(req.userId as number))
})

/** POST /api/rooms/solo — 单人开局一体动作（ADR-0002：落角色卡 + 建 solo 房 + 绑卡 + start）。
 *  可选 body.workflow（实验分支双轨：'dossier' 走剧本档案，缺省 rag=现状）。 */
router.post('/solo', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const body = (req.body ?? {}) as { storyId?: unknown; name?: unknown; sheet?: unknown; workflow?: unknown }
  const result = await createSoloRoom(userId, { storyId: body.storyId, name: body.name, sheet: body.sheet, workflow: body.workflow })
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId, inviteCode: result.inviteCode, characterId: result.characterId })
})

/** GET /api/rooms/solo — 未结束单人局列表（游戏 hub 的 solo 续玩）。 */
router.get('/solo', async (req: AuthRequest, res) => {
  res.json(await listSoloRoomsForUser(req.userId as number))
})

/** POST /api/rooms/join — 邀请码加入。 */
router.post('/join', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const inviteCode = String((req.body as { inviteCode?: unknown } | undefined)?.inviteCode ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(inviteCode)) {
    sendError(res, new BadRequestError('invalid invite code'))
    return
  }
  const result = await routeRoomInvite(userId, inviteCode, roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId })
})

/** GET /api/rooms/:id — 房间详情（成员/阶段/剧本）。 */
router.get('/:id', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = await getRoomDetail(userId, roomId)
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json(result.detail)
})

/** GET /api/rooms/:id/history — previous transcript messages in chronological order. */
router.get('/:id/history', async (req: AuthRequest, res) => {
  const { before, limit } = req.query
  const pageSize = limit === undefined ? 40 : typeof limit === 'string' && /^\d{1,3}$/.test(limit) ? Number(limit) : 0
  if (pageSize < 1 || pageSize > 100 || (before !== undefined && (typeof before !== 'string' || before.length < 1 || before.length > 200))) {
    return sendError(res, new BadRequestError('invalid history cursor or limit'))
  }
  const page = await getRoomHistory(req.userId as number, String(req.params.id ?? ''), typeof before === 'string' ? before : null, pageSize)
  if (!page) return sendError(res, new NotFoundError('room not found'))
  res.json(page)
})

/** POST /api/rooms/:id/start — 房主开始游戏（绑定剧本）。 */
router.post('/:id/start', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const storyId = String((req.body as { storyId?: unknown } | undefined)?.storyId ?? '')
  const result = await routeRoomMutation('start', userId, roomId, [storyId], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

router.post('/:id/end', async (req: AuthRequest, res) => {
  const result = await routeRoomMutation('end', req.userId as number, String(req.params.id ?? ''), [], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/character — 绑定角色卡到房间（一人一卡，Phase B4）。 */
router.post('/:id/character', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const charId = String((req.body as { characterId?: unknown } | undefined)?.characterId ?? '')
  const result = await routeRoomMutation('bind', userId, roomId, [charId], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true, roomId: result.roomId, characterId: result.characterId })
})

/** POST /api/rooms/:id/ready — 成员就绪/取消（ADR-0005 等待室软信号；body { ready }）。 */
router.post('/:id/ready', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const ready = (req.body as { ready?: unknown } | undefined)?.ready === true
  const result = await routeRoomMutation('ready', userId, roomId, [ready], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/leave — 成员主动离开（删行+广播；owner 离开→转让/解散）。 */
router.post('/:id/leave', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = await routeRoomMutation('leave', userId, roomId, [], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** DELETE /api/rooms/:id/members/:userId — 房主踢出成员（owner only）。 */
router.delete('/:id/members/:userId', async (req: AuthRequest, res) => {
  const callerUserId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const targetUserId = Number(req.params.userId)
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    sendError(res, new BadRequestError('invalid userId'))
    return
  }
  const result = await routeRoomMutation('kick', callerUserId, roomId, [targetUserId], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** POST /api/rooms/:id/transfer — 房主主动转让（body { userId } → 新 owner）。 */
router.post('/:id/transfer', async (req: AuthRequest, res) => {
  const callerUserId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const targetUserId = Number((req.body as { userId?: unknown } | undefined)?.userId)
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    sendError(res, new BadRequestError('invalid userId'))
    return
  }
  const result = await routeRoomMutation('transfer', callerUserId, roomId, [targetUserId], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

/** DELETE /api/rooms/:id — 房主解散。 */
router.delete('/:id', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const result = await routeRoomMutation('delete', userId, roomId, [], roomRequestSignal(res))
  if (!result.ok) {
    sendDomainError(res, result)
    return
  }
  res.json({ ok: true })
})

export default router

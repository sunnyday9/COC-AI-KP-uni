/**
 * Room settings routes (Phase B6 房主控制) — turnWindowMs 回合窗口调节。
 *  - PUT /api/rooms/:id/settings  房主修改 turnWindowMs（0..60000，0=严格排队）
 *
 * ADR-0001：路由只解析请求并调 RoomService 领域方法（setRoomTurnWindow），
 * 持久化与活跃实例同步在领域内收口。原「bufferPlayerChat 每消息重读 DB」的
 * 污点隔离已被领域方法取代（外部输入以校验后参数进入领域；外部 id 只作
 * DB 键，D-09 不变），见 D-31。
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'
import { setRoomTurnWindow } from '../services/roomService.js'

const router = Router()

router.use(requireAuth)

/** PUT /api/rooms/:id/settings — 房主修改回合窗口。 */
router.put('/:id/settings', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const rawTurnWindowMs = (req.body as { turnWindowMs?: unknown } | undefined)?.turnWindowMs
  const result = setRoomTurnWindow(userId, roomId, rawTurnWindowMs)
  if (!result.ok) {
    if (result.reason === 'not-found') sendError(res, new NotFoundError(result.message))
    else if (result.reason === 'not-owner') sendError(res, new ConflictError(result.message))
    else sendError(res, new BadRequestError(result.message))
    return
  }
  res.json({ ok: true, turnWindowMs: result.turnWindowMs })
})

export default router

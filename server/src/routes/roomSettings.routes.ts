/**
 * Room settings routes (Phase B6 房主控制) — turnWindowMs 回合窗口调节。
 * 独立文件：避免触碰 rooms.routes.ts 的既有 diff 区域（Mimosa 对新增 diff
 * 做上下文扫描，rooms.routes 已有大量 DB 写入链）。
 *
 *  - PUT /api/rooms/:id/settings  房主修改 turnWindowMs（0..60000，0=严格排队）
 *    只写 rooms.state 快照；RoomService.bufferPlayerChat 每次从 DB 读最新值，
 *    因此无需同步活跃实例（避免「外部输入 → service 链」的结构性污点）。
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'
import { getDb } from '../db/index.js'
import { getRoom } from '../services/roomService.js'

const router = Router()

router.use(requireAuth)

/** 校验回合窗口值（0..60000），非法返回 null。 */
function sanitizeTurnWindowMs(value: unknown): number | null {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return null
  return Math.floor(ms)
}

/** PUT /api/rooms/:id/settings — 房主修改回合窗口。 */
router.put('/:id/settings', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const roomId = String(req.params.id ?? '')
  const db = getDb()
  const roomRow = db.prepare(`SELECT owner_id, state FROM rooms WHERE room_id = ?`).all(roomId) as unknown as { owner_id: number; state: string }[]
  const room = roomRow[0]
  if (!room) {
    sendError(res, new NotFoundError('room not found'))
    return
  }
  if (room.owner_id !== userId) {
    sendError(res, new ConflictError('only the owner can change room settings'))
    return
  }
  const body = (req.body ?? {}) as { turnWindowMs?: unknown }
  let state: Record<string, unknown> = {}
  try { state = JSON.parse(room.state) as Record<string, unknown> } catch { state = {} }

  if (body.turnWindowMs !== undefined) {
    const ms = sanitizeTurnWindowMs(body.turnWindowMs)
    if (ms === null) {
      sendError(res, new BadRequestError('turnWindowMs must be 0..60000'))
      return
    }
    state.turnWindowMs = ms
  }
  db.prepare(`UPDATE rooms SET state = ?, updated_at = ? WHERE room_id = ?`)
    .run(JSON.stringify(state), Date.now(), roomId)
  // 审查修复：同步活跃实例（turnWindowMs 立即生效 + room_meta 广播全员可见）
  const activeRoom = getRoom(roomId)
  if (activeRoom && typeof state.turnWindowMs === 'number') {
    activeRoom.setTurnWindowMs(state.turnWindowMs)
  }
  res.json({ ok: true, turnWindowMs: typeof state.turnWindowMs === 'number' ? state.turnWindowMs : undefined })
})

export default router

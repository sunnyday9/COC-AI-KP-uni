/**
 * Room WebSocket adapter (Phase B3, 架构方案 v2.0 §6.2) — 房间事件流。
 *
 * 客户端帧：
 *   room:join   { roomId }                     —— 加入房间事件流（校验成员资格）
 *   room:leave  { roomId }                     —— 离开
 *   room:sync   { roomId, lastSeq }            —— 断线重连：增量补齐（缺口大 → 全量快照）
 *   room:action { roomId, action }             —— 动作（聊天/表态），串行入队处理
 * 服务端帧：
 *   room:state  { roomId, snapshot, seq }      —— 全量（加入/快照过期）
 *   room:event  { roomId, seq, type, payload } —— 增量事件流（全序）
 *   room:error  { roomId, error }
 *
 * 职责边界（架构评审候选 4 / D-33）：本文件只做「JSON 帧编解码 + socket
 * 生命周期接线」——订阅注册表、扇出挂接幂等、sync/join/action 的帧规划
 * 在 roomLedger.ts（订阅簿）；成员资格/实例 materialize/聊天领域逻辑在
 * RoomService（ADR-0001）。
 */
import type { WebSocket } from 'ws'
import type { RoomEvent, RoomService } from '../services/roomService.js'
import { cleanupSocket, ensureFanout, planAction, planJoin, planSync, subscribeSocket, subscribersOf, unsubscribeSocket } from './roomLedger.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

function send(socket: WebSocket, obj: unknown): void {
  if (socket.readyState !== 1 /* WebSocket.OPEN */) return
  let frame: string
  try {
    frame = JSON.stringify(obj)
  } catch (err) {
    logger.warn('room ws send serialization failed, frame dropped', { error: errorMessage(err) })
    return
  }
  socket.send(frame)
}

/** 扇出房间事件（全序 seq 已由 RoomService 分配；编码在此，注册表在订阅簿）。 */
function broadcast(roomId: string, event: RoomEvent, seq: number): void {
  const frame = JSON.stringify({ type: 'room:event', roomId, seq, eventType: event.type, payload: event.payload })
  for (const s of subscribersOf(roomId)) {
    if (s.readyState === 1) s.send(frame)
  }
}

/** 处理 room:join — 成员资格 → 订阅 → 全量快照。 */
export function handleRoomJoin(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  if (!roomId) {
    send(socket, { type: 'room:error', roomId: '', error: 'roomId required' })
    return
  }
  const plan = planJoin(roomId, userId, `user_${userId}`)
  if (!plan.ok) {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  const room = plan.room
  // 扇出挂接：RoomService 事件 → 房间订阅组（幂等由订阅簿保证）
  ensureFanout(room, (event, seq) => broadcast(roomId, event, seq))
  subscribeSocket(socket, roomId)
  // 全量快照（加入时）
  send(socket, { type: 'room:state', roomId, snapshot: room.snapshot(), seq: room.getSeq() })
  logger.info('room join', { roomId, userId })
}

/** 处理 room:leave — 取消订阅。 */
export function handleRoomLeave(socket: WebSocket, roomId: string): void {
  unsubscribeSocket(socket, roomId)
}

/** 处理 room:sync — 订阅簿规划增量/全量；编码在本层。 */
export function handleRoomSync(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  const lastSeq = Number((raw as { lastSeq?: unknown }).lastSeq ?? 0)
  const plan = planSync(roomId, userId, lastSeq)
  if (plan.kind === 'error') {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  if (plan.kind === 'full') {
    // 缺口过大或无需增量 → 全量快照（客户端按 seq 对账）
    send(socket, { type: 'room:state', roomId, snapshot: plan.room.snapshot(), seq: plan.room.getSeq() })
    return
  }
  // 增量补齐：补发 lastSeq 之后的事件（客户端按 seq 应用）
  for (const d of plan.events) {
    send(socket, { type: 'room:event', roomId, seq: d.seq, eventType: d.event.type, payload: d.event.payload })
  }
  send(socket, { type: 'room:sync:done', roomId, seq: plan.room.getSeq() })
}

/** 处理 room:action — 聊天（触发 KP 回合）/ 表态，串行入队（RoomService.enqueue）。 */
export function handleRoomAction(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  const action = (raw as { action?: unknown }).action as { type?: string; payload?: unknown } | undefined
  if (!roomId || !action?.type) {
    send(socket, { type: 'room:error', roomId, error: 'roomId and action.type required' })
    return
  }
  const plan = planAction(roomId, userId)
  if (!plan.ok) {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  const room = plan.room
  void room.enqueue(async () => {
    if (action.type === 'chat') {
      const content = String((action.payload as { content?: unknown } | undefined)?.content ?? '').trim()
      if (!content) {
        send(socket, { type: 'room:error', roomId, error: 'chat content required' })
        return
      }
      // 领域方法（ADR-0001）：身份解析/消息流/回合缓冲都在 RoomService 内部
      room.submitPlayerChat(userId, content)
    } else {
      send(socket, { type: 'room:error', roomId, error: `unknown action type: ${action.type}` })
      return
    }
  })
}

/** 连接关闭：清理所有订阅（注册表在订阅簿）。 */
export function cleanupSocketRooms(socket: WebSocket): void {
  cleanupSocket(socket)
}

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
import { ROOM_RUNTIME } from '../config.js'
import { routeSocketCommand } from '../services/roomCommands.js'
import { activateGatewayPresence, joinGatewayPresence, releaseGatewaySocketPresence } from './gatewayPresence.js'
import { subscribeGatewaySocket, unsubscribeGatewaySocket } from './gatewayRooms.js'
import type { RoomActionResult } from '../../../shared/types/room.js'
import type { RoomEvent, RoomService } from '../services/roomService.js'
import { handleOwnerWsDisconnect } from '../services/roomService.js'
import { cleanupSocket, ensureFanout, planAction, planJoin, planSync, roomIdsOfSocket, subscribeSocket, subscribersOf, unsubscribeSocket } from './roomLedger.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { isTransportReset, sendFrame } from './sendFrame.js'

function send(socket: WebSocket, obj: unknown): void {
  if (socket.readyState !== 1 /* WebSocket.OPEN */) return
  let frame: string
  try {
    frame = JSON.stringify(obj)
  } catch (err) {
    logger.warn('room ws send serialization failed, frame dropped', { error: errorMessage(err) })
    return
  }
  sendFrame(socket, frame)
}

/** 扇出房间事件（全序 seq 已由 RoomService 分配；编码在此，注册表在订阅簿）。 */
function broadcast(roomId: string, event: RoomEvent, seq: number): void {
  const frame = JSON.stringify({ type: 'room:event', roomId, seq, eventType: event.type, payload: event.payload })
  for (const s of subscribersOf(roomId)) {
    sendFrame(s, frame)
  }
}

async function sendGatewayState(socket: WebSocket, userId: number, roomId: string, signal?: AbortSignal): Promise<void> {
  const result = await routeSocketCommand('snapshot', userId, roomId, [], signal)
  if (!result) {
    unsubscribeGatewaySocket(socket, roomId)
    send(socket, { type: 'room:error', roomId, error: 'not a room member' })
    return
  }
  if (socket.readyState !== 1 || !subscribeGatewaySocket(socket, roomId, userId, result.seq)) return
  if (!await joinGatewayPresence(socket, roomId, userId) || socket.readyState !== 1) {
    unsubscribeGatewaySocket(socket, roomId)
    return
  }
  activateGatewayPresence(socket, roomId)
  send(socket, { type: 'room:state', roomId, actionReceipts: true, ...result })
}

/** 处理 room:join — 成员资格 → 订阅 → 全量快照。 */
export async function handleRoomJoin(socket: WebSocket, userId: number, raw: unknown, signal?: AbortSignal): Promise<void> {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  if (!roomId) {
    send(socket, { type: 'room:error', roomId: '', error: 'roomId required' })
    return
  }
  if (ROOM_RUNTIME === 'gateway') return sendGatewayState(socket, userId, roomId, signal)
  const plan = await planJoin(roomId, userId, `user_${userId}`)
  if (!plan.ok) {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  const room = plan.room
  // 扇出挂接：RoomService 事件 → 房间订阅组（幂等由订阅簿保证）
  ensureFanout(room, (event, seq) => broadcast(roomId, event, seq))
  if (socket.readyState !== 1) return
  subscribeSocket(socket, roomId)
  // 全量快照（加入时）
  send(socket, { type: 'room:state', roomId, actionReceipts: true, snapshot: room.snapshot(), seq: room.getSeq() })
  logger.info('room join', { roomId, userId })
}

/** 处理 room:leave — 取消订阅。 */
export function handleRoomLeave(socket: WebSocket, roomId: string): void {
  if (ROOM_RUNTIME === 'gateway') unsubscribeGatewaySocket(socket, roomId)
  else unsubscribeSocket(socket, roomId)
}

/** 处理 room:sync — 订阅簿规划增量/全量；编码在本层。 */
export async function handleRoomSync(socket: WebSocket, userId: number, raw: unknown, signal?: AbortSignal): Promise<void> {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  if (ROOM_RUNTIME === 'gateway') return sendGatewayState(socket, userId, roomId, signal)
  const lastSeq = Number((raw as { lastSeq?: unknown }).lastSeq ?? 0)
  const plan = await planSync(roomId, userId, lastSeq)
  if (plan.kind === 'error') {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  if (plan.kind === 'full') {
    // 缺口过大或无需增量 → 全量快照（客户端按 seq 对账）
    send(socket, { type: 'room:state', roomId, actionReceipts: true, snapshot: plan.room.snapshot(), seq: plan.room.getSeq() })
    return
  }
  // 增量补齐：补发 lastSeq 之后的事件（客户端按 seq 应用）
  for (const d of plan.events) {
    send(socket, { type: 'room:event', roomId, seq: d.seq, eventType: d.event.type, payload: d.event.payload })
  }
  send(socket, { type: 'room:sync:done', roomId, seq: plan.room.getSeq() })
}

/** 处理 room:action — 聊天（触发 KP 回合）/ 表态，串行入队（RoomService.enqueue）。 */
export async function handleRoomAction(socket: WebSocket, userId: number, raw: unknown, signal?: AbortSignal): Promise<void> {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  const action = (raw as { action?: unknown }).action as { type?: string; payload?: unknown } | undefined
  const actionId = (raw as { actionId?: unknown }).actionId
  if (actionId !== undefined) {
    if (typeof actionId !== 'string' || actionId.length > 80) {
      send(socket, { type: 'room:error', roomId, error: '行动编号无效。' })
      return
    }
    const sendResult = (result: RoomActionResult) => send(socket, {
      type: 'room:action:result', roomId, actionId, ...result,
    })
    const rawContent = (action?.payload as { content?: unknown } | undefined)?.content
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(actionId) || !roomId || action?.type !== 'chat' ||
        typeof rawContent !== 'string' || !rawContent.trim()) {
      sendResult({ status: 'rejected', code: 'invalid_action', error: '行动编号或消息内容无效。' })
      return
    }
    try {
      if (ROOM_RUNTIME === 'gateway') {
        const result = await routeSocketCommand('chat', userId, roomId, [rawContent.trim(), actionId], signal)
        sendResult(result ?? { status: 'rejected', code: 'not_member', error: '你已不在该房间内。' })
        return
      }
      const plan = await planAction(roomId, userId)
      if (!plan.ok) {
        if (plan.error === 'room not active') {
          sendResult({ status: 'retry', code: 'room_inactive', error: '房间尚未连接，请重新进入后重试。' })
        } else {
          sendResult({ status: 'rejected', code: 'not_member', error: '你已不在该房间内。' })
        }
        return
      }
      const task = plan.room.queuePlayerChat(userId, rawContent.trim(), actionId)
      sendResult(task ? await task : { status: 'busy', code: 'room_busy', error: '房间待处理的操作已满，请稍后重试。' })
    } catch (error) {
      logger.warn('room action failed', { roomId, error: errorMessage(error) })
      sendResult({ status: 'retry', code: 'storage_unavailable', error: '暂时无法确认消息是否送达，请重试。' })
    }
    return
  }
  if (!roomId || !action?.type) {
    send(socket, { type: 'room:error', roomId, error: 'roomId and action.type required' })
    return
  }
  if (ROOM_RUNTIME === 'gateway') {
    if (action.type === 'chat') {
      const content = String((action.payload as { content?: unknown } | undefined)?.content ?? '').trim()
      if (!content) {
        send(socket, { type: 'room:error', roomId, error: 'chat content required' })
        return
      }
      const result = await routeSocketCommand('chat', userId, roomId, [content], signal)
      if (!result || 'error' in result) {
        send(socket, { type: 'room:error', roomId, error: result && result.code !== 'not_member' ? result.error : 'not a room member' })
      }
    } else if (action.type === 'retry_kp') {
      const result = await routeSocketCommand('retry', userId, roomId, [], signal)
      if (!result) {
        send(socket, { type: 'room:error', roomId, error: result === null ? 'not a room member' : '只有当前房主可以重试 KP。' })
      }
    } else {
      send(socket, { type: 'room:error', roomId, error: 'unknown action type: ' + action.type })
    }
    return
  }
  const plan = await planAction(roomId, userId)
  if (!plan.ok) {
    send(socket, { type: 'room:error', roomId, error: plan.error })
    return
  }
  const room = plan.room
  const busy = () => send(socket, { type: 'room:error', roomId, error: '房间待处理的操作已满，请稍后重试。' })
  let task: Promise<unknown> | null
  if (action.type === 'chat') {
    const content = String((action.payload as { content?: unknown } | undefined)?.content ?? '').trim()
    if (!content) {
      send(socket, { type: 'room:error', roomId, error: 'chat content required' })
      return
    }
    task = room.queuePlayerChat(userId, content)?.then((result) => {
      if (result.status === 'busy') busy()
      if ('error' in result && result.status !== 'busy') {
        send(socket, { type: 'room:error', roomId, error: result.code === 'not_member' ? 'not a room member' : result.error })
      }
    }) ?? null
  } else if (action.type === 'retry_kp') {
    task = room.enqueueClientAction(async () => {
      if (!await room.retryKpTurn(userId)) {
        send(socket, { type: 'room:error', roomId, error: '只有当前房主可以重试 KP。' })
      }
    })
  } else {
    send(socket, { type: 'room:error', roomId, error: `unknown action type: ${action.type}` })
    return
  }
  if (!task) {
    busy()
    return
  }
  void task.catch((error: unknown) => {
    logger.warn('room action failed', { roomId, error: errorMessage(error) })
    send(socket, { type: 'room:error', roomId, error: '房间暂时无法处理该操作，请稍后重试。' })
  })
}

/** 连接关闭：清理所有订阅（注册表在订阅簿）。
 *  服务端因消息大小或发送缓冲超限断开连接时只清理订阅。普通房主断线触发转让或解散（ADR-0005；
 *  领域内判定脱机者身份：非 owner 断线不动房间，成员行保留——主动离开走 REST leave）。 */
export async function cleanupSocketRooms(socket: WebSocket, userId?: number | null): Promise<void> {
  const roomIds = roomIdsOfSocket(socket)
  if (ROOM_RUNTIME === 'gateway') {
    releaseGatewaySocketPresence(socket, !isTransportReset(socket))
    for (const roomId of roomIds) unsubscribeGatewaySocket(socket, roomId)
    return
  }
  cleanupSocket(socket)
  if (!userId || isTransportReset(socket)) return
  await Promise.all(roomIds.map((roomId) => handleOwnerWsDisconnect(roomId, userId)))
}

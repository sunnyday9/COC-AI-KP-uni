/**
 * Room WebSocket handling (Phase B3, 架构方案 v2.0 §6.2) — 房间事件流。
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
 */
import type { WebSocket } from 'ws'
import { getRoom, getOrCreateRoom, type RoomEvent } from '../services/roomService.js'
import { getDb } from '../db/index.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/** socket → 订阅的房间 id 集合（一个连接可订阅多房间）。 */
const socketRooms = new Map<WebSocket, Set<string>>()

/** 房间 → 订阅 socket 集合（扇出目标）。 */
const roomSockets = new Map<string, Set<WebSocket>>()

/** 已挂接广播的 RoomService 实例（防止重复 subscribe 产生重复回调）。 */
const roomBroadcastAttached = new Set<object>()

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

/** 校验用户是否为房间成员（DB 权威）。 */
function isRoomMember(userId: number, roomId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`)
    .get(roomId, userId)
  return !!row
}

function subscribeSocket(socket: WebSocket, roomId: string): void {
  let rooms = socketRooms.get(socket)
  if (!rooms) {
    rooms = new Set()
    socketRooms.set(socket, rooms)
  }
  rooms.add(roomId)
  let sockets = roomSockets.get(roomId)
  if (!sockets) {
    sockets = new Set()
    roomSockets.set(roomId, sockets)
  }
  sockets.add(socket)
}

function unsubscribeSocket(socket: WebSocket, roomId: string): void {
  socketRooms.get(socket)?.delete(roomId)
  roomSockets.get(roomId)?.delete(socket)
}

/** 扇出房间事件（全序 seq 已由 RoomService 分配）。 */
function broadcast(roomId: string, event: RoomEvent, seq: number): void {
  const sockets = roomSockets.get(roomId)
  if (!sockets) return
  const frame = JSON.stringify({ type: 'room:event', roomId, seq, eventType: event.type, payload: event.payload })
  for (const s of sockets) {
    if (s.readyState === 1) s.send(frame)
  }
}

/** 处理 room:join — 校验成员资格 → 订阅 → 全量快照。 */
export function handleRoomJoin(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  if (!roomId) {
    send(socket, { type: 'room:error', roomId: '', error: 'roomId required' })
    return
  }
  if (!isRoomMember(userId, roomId)) {
    send(socket, { type: 'room:error', roomId, error: 'not a room member' })
    return
  }
  const room = getRoom(roomId) ?? getOrCreateRoom(roomId, userId, `user_${userId}`)
  // 挂接广播：RoomService 事件 → 房间订阅组扇出（幂等：subscribe 去重由 Set 保证，
  // 但多次挂接会产生重复回调 → 用标记位防止重复订阅）。
  if (!roomBroadcastAttached.has(room)) {
    roomBroadcastAttached.add(room)
    room.subscribe((event: RoomEvent) => {
      broadcast(roomId, event, room.getSeq())
    })
  }
  subscribeSocket(socket, roomId)
  // 全量快照（加入时）
  send(socket, { type: 'room:state', roomId, snapshot: room.snapshot(), seq: room.getSeq() })
  logger.info('room join', { roomId, userId })
}

/** 供 ws/index.ts：广播房间事件（RoomService 订阅回调）。 */
export function attachRoomBroadcast(roomId: string): void {
  const room = getRoom(roomId)
  if (!room) return
  room.subscribe((event: RoomEvent) => {
    broadcast(roomId, event, room.getSeq())
  })
}

/** 处理 room:leave — 取消订阅。 */
export function handleRoomLeave(socket: WebSocket, roomId: string): void {
  unsubscribeSocket(socket, roomId)
}

/** 处理 room:sync — lastSeq 之后的增量补齐；缺口过大（事件日志淘汰）→ 全量快照。 */
export function handleRoomSync(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  if (!roomId || !isRoomMember(userId, roomId)) {
    send(socket, { type: 'room:error', roomId, error: 'not a room member' })
    return
  }
  const room = getRoom(roomId)
  if (!room) {
    send(socket, { type: 'room:error', roomId, error: 'room not active' })
    return
  }
  const lastSeq = Number((raw as { lastSeq?: unknown }).lastSeq ?? 0)
  const deltas = room.getEventsSince(lastSeq)
  if (deltas === null || deltas.length === 0) {
    // 缺口过大或无需增量 → 全量快照（客户端按 seq 对账）
    send(socket, { type: 'room:state', roomId, snapshot: room.snapshot(), seq: room.getSeq() })
    return
  }
  // 增量补齐：补发 lastSeq 之后的事件（客户端按 seq 应用）
  for (const d of deltas) {
    send(socket, { type: 'room:event', roomId, seq: d.seq, eventType: d.event.type, payload: d.event.payload })
  }
  send(socket, { type: 'room:sync:done', roomId, seq: room.getSeq() })
}

/** 处理 room:action — 聊天（触发 KP 回合）/ 表态，串行入队（RoomService.enqueue）。 */
export function handleRoomAction(socket: WebSocket, userId: number, raw: unknown): void {
  const roomId = String((raw as { roomId?: unknown }).roomId ?? '')
  const action = (raw as { action?: unknown }).action as { type?: string; payload?: unknown } | undefined
  if (!roomId || !action?.type) {
    send(socket, { type: 'room:error', roomId, error: 'roomId and action.type required' })
    return
  }
  if (!isRoomMember(userId, roomId)) {
    send(socket, { type: 'room:error', roomId, error: 'not a room member' })
    return
  }
  const room = getRoom(roomId)
  if (!room) {
    send(socket, { type: 'room:error', roomId, error: 'room not active' })
    return
  }
  void room.enqueue(async () => {
    if (action.type === 'chat') {
      const content = String((action.payload as { content?: unknown } | undefined)?.content ?? '').trim()
      if (!content) {
        send(socket, { type: 'room:error', roomId, error: 'chat content required' })
        return
      }
      const username = (getDb().prepare(`SELECT username FROM users WHERE id = ?`).get(userId) as { username: string } | undefined)?.username ?? `user_${userId}`
      room.appendMessage(
        { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'player', playerName: username, content },
        { userId, roleName: username },
      )
      // Phase B6 + D4：玩家消息触发 KP 回合——回合窗口合并（窗口内多人行动合并进
      // 一次推理）；行动者 = 成员绑定的角色卡（无绑定则 null）。
      // 单人房间 = 单成员（FR-M9）；turnWindowMs=0 时立即处理（严格排队）。
      const memberRow = getDb()
        .prepare(`SELECT character_id FROM room_members WHERE room_id = ? AND user_id = ?`)
        .all(roomId, userId) as unknown as { character_id: string | null }[]
      const activeCharacterId = memberRow[0]?.character_id ?? null
      room.bufferPlayerChat(username, content, activeCharacterId, userId)
    } else {
      send(socket, { type: 'room:error', roomId, error: `unknown action type: ${action.type}` })
      return
    }
  })
}

/** 连接关闭：清理所有订阅。 */
export function cleanupSocketRooms(socket: WebSocket): void {
  const rooms = socketRooms.get(socket)
  if (rooms) {
    for (const roomId of rooms) {
      roomSockets.get(roomId)?.delete(socket)
    }
  }
  socketRooms.delete(socket)
}

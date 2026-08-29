/**
 * RoomLedger — 房间订阅簿（架构评审候选 4 / D-33）。
 *
 * 房间事件流的**传输决策层**：socket↔room 订阅注册表、扇出挂接幂等、
 * sync 的「增量 vs 全量」帧规划、join/action 的成员与活跃性 gate。
 * 与 WebSocket 类型无关（只依赖 RoomSubscriber 结构子集与 RoomService 实例），
 * 可表驱动单测；ws/rooms.ts 只剩 JSON 编解码与 socket 生命周期接线（adapter）。
 *
 * 分层（评审 grilling Q2）：「缺口超出环形日志 → 全量兜底」的语义留在
 * RoomService.getEventsSince（D-16 领域策略）；「对哪个订阅者发哪种帧」的
 * 规划在这里。wire 帧格式不变。
 */
import type { RoomEvent, RoomService } from '../services/roomService.js'
import { getRoom, isRoomMember, joinRoom } from '../services/roomService.js'

/** 订阅者的最小传输面（WebSocket 的结构子集）。readyState === 1 = OPEN。 */
export interface RoomSubscriber {
  readonly readyState: number
  send(frame: string): void
}

/** socket → 订阅的房间集合（一个连接可订阅多房间）。 */
const socketRooms = new Map<RoomSubscriber, Set<string>>()

/** 房间 → 订阅 socket 集合（扇出目标）。 */
const roomSockets = new Map<string, Set<RoomSubscriber>>()

/** 已挂接扇出的 RoomService 实例（防重复 subscribe 产生重复回调）。 */
const fanoutAttached = new Set<object>()

/* ═══════════════ 订阅注册表 ═══════════════ */

export function subscribeSocket(socket: RoomSubscriber, roomId: string): void {
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

export function unsubscribeSocket(socket: RoomSubscriber, roomId: string): void {
  socketRooms.get(socket)?.delete(roomId)
  roomSockets.get(roomId)?.delete(socket)
}

/** 连接关闭：清理该 socket 的全部订阅。 */
export function cleanupSocket(socket: RoomSubscriber): void {
  const rooms = socketRooms.get(socket)
  if (rooms) {
    for (const roomId of rooms) {
      roomSockets.get(roomId)?.delete(socket)
    }
  }
  socketRooms.delete(socket)
}

/** 房间当前的订阅者快照（拷贝，扇出时可安全遍历）。 */
export function subscribersOf(roomId: string): RoomSubscriber[] {
  return [...(roomSockets.get(roomId) ?? [])]
}

/* ═══════════════ 扇出挂接（幂等） ═══════════════ */

/** 同一 RoomService 实例只挂一次扇出监听；帧编码由 adapter 的 listener 完成。 */
export function ensureFanout(room: RoomService, listener: (event: RoomEvent, seq: number) => void): void {
  if (fanoutAttached.has(room)) return
  fanoutAttached.add(room)
  room.subscribe(listener)
}

/* ═══════════════ 帧规划（纯决策，wire 帧编码在 adapter） ═══════════════ */

/** join 规划：成员资格（领域）→ 实例（不存在则 materialize——懒激活）。 */
export function planJoin(
  roomId: string,
  userId: number,
  username: string,
): { ok: true; room: RoomService } | { ok: false; error: string } {
  const room = joinRoom(roomId, userId, username)
  if (!room) return { ok: false, error: 'not a room member' }
  return { ok: true, room }
}

export type SyncPlan =
  | { kind: 'error'; error: string }
  | { kind: 'full'; room: RoomService }
  | { kind: 'delta'; room: RoomService; events: { seq: number; event: RoomEvent }[] }

/** sync 规划：成员 gate → 活跃性 → 增量/全量（getEventsSince null 或空 = 缺口过大/无增量 → 全量兜底）。 */
export function planSync(roomId: string, userId: number, lastSeq: number): SyncPlan {
  if (!roomId || !isRoomMember(roomId, userId)) return { kind: 'error', error: 'not a room member' }
  const room = getRoom(roomId)
  if (!room) return { kind: 'error', error: 'room not active' }
  const deltas = room.getEventsSince(lastSeq)
  if (deltas === null || deltas.length === 0) return { kind: 'full', room }
  return { kind: 'delta', room, events: deltas }
}

/** action 规划：成员 gate → 活跃实例（动作串行入队由调用方在实例上执行）。 */
export function planAction(
  roomId: string,
  userId: number,
): { ok: true; room: RoomService } | { ok: false; error: string } {
  if (!roomId || !isRoomMember(roomId, userId)) return { ok: false, error: 'not a room member' }
  const room = getRoom(roomId)
  if (!room) return { ok: false, error: 'room not active' }
  return { ok: true, room }
}

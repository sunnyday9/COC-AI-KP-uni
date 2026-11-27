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
import { getRoom, hasRoomCapacity, isRoomMember, joinRoom, planCommittedRoomReplay, RoomWorkerBusyError } from '../services/roomService.js'
import { routeSocketCommand } from '../services/roomCommands.js'
import { releaseGatewayPresence } from './gatewayPresence.js'
import { encodeRoomReplay, type FrameRecipient } from './sendFrame.js'

/** 订阅者的最小传输面（WebSocket 的结构子集）。readyState === 1 = OPEN。 */
export type RoomSubscriber = FrameRecipient

/** socket → 订阅的房间集合（一个连接可订阅多房间）。 */
const socketRooms = new Map<RoomSubscriber, Set<string>>()

/** 房间 → 订阅 socket 集合（扇出目标）。 */
const roomSockets = new Map<string, Set<RoomSubscriber>>()

/** 已挂接扇出的 RoomService 实例（防重复 subscribe 产生重复回调）。 */
const fanoutAttached = new WeakSet<RoomService>()
const MAX_GATEWAY_REPLAY_BYTES = 512 * 1024

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
  const rooms = socketRooms.get(socket)
  rooms?.delete(roomId)
  if (rooms?.size === 0) socketRooms.delete(socket)
  const sockets = roomSockets.get(roomId)
  sockets?.delete(socket)
  if (sockets?.size === 0) roomSockets.delete(roomId)
}

/** 连接关闭：清理该 socket 的全部订阅。 */
export function cleanupSocket(socket: RoomSubscriber): void {
  const rooms = socketRooms.get(socket)
  if (rooms) {
    for (const roomId of rooms) {
      unsubscribeSocket(socket, roomId)
    }
  }
}

/** 房间当前的订阅者快照（拷贝，扇出时可安全遍历）。 */
export function subscribersOf(roomId: string): RoomSubscriber[] {
  return [...(roomSockets.get(roomId) ?? [])]
}

export function hasSubscribers(roomId: string): boolean {
  return roomSockets.has(roomId)
}

/** socket 订阅的房间 id 快照（断线清理时枚举——cleanupSocket 会清空注册表，须先取）。 */
export function roomIdsOfSocket(socket: RoomSubscriber): string[] {
  return [...(socketRooms.get(socket) ?? [])]
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
export async function planJoin(
  roomId: string,
  userId: number,
  username: string,
): Promise<{ ok: true; room: RoomService } | { ok: false; error: string }> {
  if (!hasRoomCapacity(roomId)) return { ok: false, error: '服务器活跃房间已满，请稍后重试。' }
  const room = await joinRoom(roomId, userId, username).catch((error: unknown) => {
    if (error instanceof RoomWorkerBusyError) return error
    throw error
  })
  if (room instanceof RoomWorkerBusyError) return { ok: false, error: room.message }
  if (!room) return {
    ok: false,
    error: hasRoomCapacity(roomId) ? 'not a room member' : '\u670d\u52a1\u5668\u6d3b\u8dc3\u623f\u95f4\u5df2\u6ee1\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
  }
  return { ok: true, room }
}

type DirectReplayPlan =
  | { kind: 'full'; room: RoomService }
  | { kind: 'delta'; room: RoomService; events: { seq: number; event: RoomEvent }[] }

export type SyncPlan = { kind: 'error'; error: string } | DirectReplayPlan

/** A join can confirm an already-current cursor without sending a snapshot. */
export function planDirectReplay(room: RoomService, lastSeq: number, joining = false): DirectReplayPlan {
  const events = room.getEventsSince(lastSeq)
  if (events === null || (!joining && events.length === 0)) return { kind: 'full', room }
  return { kind: 'delta', room, events }
}

/** sync 规划：成员 gate → 活跃性 → 增量/全量（getEventsSince null 或空 = 缺口过大/无增量 → 全量兜底）。 */
export async function planSync(roomId: string, userId: number, lastSeq: number): Promise<SyncPlan> {
  if (!roomId || !await isRoomMember(roomId, userId)) return { kind: 'error', error: 'not a room member' }
  const room = getRoom(roomId)
  if (!room) return { kind: 'error', error: 'room not active' }
  return planDirectReplay(room, lastSeq)
}

/** Plan a committed replay or request a fresh snapshot before confirming presence. */
export async function planGatewayResume(
  roomId: string, userId: number, lastSeq: number, current: () => boolean, signal?: AbortSignal,
) {
  if (lastSeq > 0) {
    const replay = await planCommittedRoomReplay(roomId, userId, lastSeq, MAX_GATEWAY_REPLAY_BYTES)
    if (!current()) return null
    if (replay.kind === 'not-member') return { kind: 'not-member' } as const
    if (replay.kind === 'delta') {
      const frames = encodeRoomReplay(roomId, replay.events, MAX_GATEWAY_REPLAY_BYTES)
      if (frames) {
        const terminal = { type: 'room:sync:done', roomId, seq: replay.seq, actionReceipts: true }
        return { kind: 'ready', frames, terminal, seq: replay.seq } as const
      }
    }
  }
  const snapshot = await routeSocketCommand('snapshot', userId, roomId, [], signal)
  if (!current()) return null
  if (!snapshot) return { kind: 'not-member' } as const
  const terminal = { type: 'room:state', roomId, actionReceipts: true, ...snapshot }
  return { kind: 'ready', frames: [], terminal, seq: snapshot.seq } as const
}

/** action 规划：成员 gate → 活跃实例（动作串行入队由调用方在实例上执行）。 */
export async function planAction(
  roomId: string,
  userId: number,
): Promise<{ ok: true; room: RoomService } | { ok: false; error: string }> {
  if (!roomId || !await isRoomMember(roomId, userId)) return { ok: false, error: 'not a room member' }
  const room = getRoom(roomId)
  if (!room) return { ok: false, error: 'room not active' }
  return { ok: true, room }
}

interface GatewaySubscription {
  userId: number
  seq: number | null
}

const gatewaySubscriptions = new Map<string, Map<RoomSubscriber, GatewaySubscription>>()
let gatewaySubscriptionCount = 0

/** Reserve a generation while a join or sync selects its starting cursor. */
export function reserveGatewaySubscription(socket: RoomSubscriber, roomId: string, userId: number): GatewaySubscription | null {
  let listeners = gatewaySubscriptions.get(roomId)
  const alreadySubscribed = listeners?.has(socket)
  if (!alreadySubscribed && (roomIdsOfSocket(socket).length >= 8 || gatewaySubscriptionCount >= 4096 ||
      (!listeners && gatewaySubscriptions.size >= 1024) || (listeners?.size ?? 0) >= 256)) return null

  if (!listeners) {
    listeners = new Map()
    gatewaySubscriptions.set(roomId, listeners)
  }
  const subscription = { userId, seq: null }
  listeners.set(socket, subscription)
  subscribeSocket(socket, roomId)
  if (!alreadySubscribed) gatewaySubscriptionCount++
  return subscription
}

export function unsubscribeGatewaySocket(socket: RoomSubscriber, roomId: string): void {
  releaseGatewayPresence(socket, roomId)
  const listeners = gatewaySubscriptions.get(roomId)
  if (!listeners?.delete(socket)) return
  if (!listeners.size) gatewaySubscriptions.delete(roomId)
  gatewaySubscriptionCount--
  unsubscribeSocket(socket, roomId)
}

export function gatewayRoomIds(): string[] {
  return [...gatewaySubscriptions.keys()]
}

export function gatewaySubscribers(roomId: string): ReadonlyMap<RoomSubscriber, GatewaySubscription> | undefined {
  return gatewaySubscriptions.get(roomId)
}

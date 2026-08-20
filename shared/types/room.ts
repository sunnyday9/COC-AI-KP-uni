/**
 * Room protocol types (Phase B3/B4/C1, 架构方案 v2.0 §6.2) — shared between
 * server (RoomService / ws/rooms.ts) and client (roomStore / RoomClient).
 *
 * 事件流设计（全序 seq 由服务端 RoomService 串行分配）：
 *  - 客户端帧（经共享 WS 连接，见 ws/index.ts）：
 *      room:join   { roomId }
 *      room:leave  { roomId }
 *      room:sync   { roomId, lastSeq }   —— 断线重连增量补齐
 *      room:action { roomId, action }    —— 聊天/表态，串行入队
 *  - 服务端帧：
 *      room:state  { roomId, snapshot, seq }          —— 全量（加入/缺口过大）
 *      room:event  { roomId, seq, eventType, payload }—— 增量事件（全序）
 *      room:sync:done { roomId, seq }                 —— 增量补齐结束
 *      room:error  { roomId, error }
 */

/** 房间阶段（与 server RoomPhase 一致）。 */
export type RoomPhase = 'lobby' | 'playing' | 'ended'

/** 房间成员角色（与 server MemberRole 一致）。 */
export type RoomMemberRole = 'owner' | 'member' | 'observer'

export interface RoomMemberInfo {
  userId: number
  username: string
  role: RoomMemberRole
  characterId: string | null
}

/** 房间事件类型（与 server RoomEvent 一致）。 */
export type RoomEventType = 'message_appended' | 'state_patch' | 'dice_result' | 'room_meta' | 'trace'

export interface RoomMessageAppendedPayload {
  pendingId?: string
  author: { userId: number; roleName: string }
  content: string
  kind: string
}

export interface RoomStatePatchPayload {
  path: string
  value: unknown
}

export interface RoomDiceResultPayload {
  rolls: number[]
  expr: string
  displayText: string
}

export interface RoomMetaPayload {
  phase: RoomPhase
  turnWindowMs: number
  members: RoomMemberInfo[]
}

export interface RoomTracePayload {
  traceEvents: unknown[]
}

/** 服务端增量事件（room:event 帧）。 */
export interface RoomEventFrame {
  roomId: string
  seq: number
  eventType: RoomEventType
  payload: RoomMessageAppendedPayload | RoomStatePatchPayload | RoomDiceResultPayload | RoomMetaPayload | RoomTracePayload
}

/** 房间全量快照（room:state 帧；与 server RoomSnapshot 对齐）。 */
export interface RoomSnapshot {
  seq: number
  phase: RoomPhase
  storyId: string | null
  messages: {
    id: string
    timestamp: number
    role: string
    content: string
    playerName?: string
    isStreaming?: boolean
  }[]
  characters: Record<string, unknown>
  clues: { id: string; description: string }[]
  scene: string | null
  ending: unknown | null
  turnWindowMs: number
  updatedAt: number
}

/** 服务端房间帧（room:*，统一入口，roomStore 按 type 分流）。 */
export type RoomServerFrame =
  | { type: 'room:state'; roomId: string; snapshot: RoomSnapshot; seq: number }
  | { type: 'room:event'; roomId: string; seq: number; eventType: RoomEventType; payload: RoomEventFrame['payload'] }
  | { type: 'room:sync:done'; roomId: string; seq: number }
  | { type: 'room:error'; roomId: string; error: string }

/** REST /api/rooms 响应（roomService 客户端契约）。 */
export interface RoomListItem {
  roomId: string
  inviteCode: string
  storyId: string | null
  phase: RoomPhase
  updatedAt: number
}

export interface RoomDetail {
  roomId: string
  inviteCode: string
  storyId: string | null
  phase: RoomPhase
  ownerId: number
  members: RoomMemberInfo[]
  state: Record<string, unknown>
  createdAt: number
}

export interface CharacterListItem {
  id: string
  name: string
  sheet: Record<string, unknown>
  updatedAt: number
}

/** 房间动作（room:action 帧）。 */
export interface RoomAction {
  type: 'chat'
  payload: { content: string }
}

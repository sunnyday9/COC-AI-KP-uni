/**
 * roomStore — 客户端多人房间视图模型（Phase B3/B4/C1，架构方案 v2.0 §6.3）。
 *
 * 与单机 gameStore 的关键差异：**本 store 不产生任何房间状态**，全部状态
 * 由服务端 RoomService 广播（全序 seq），本 store 只做两件事：
 *   1) 订阅 room:event 增量，按 seq 顺序应用到本地视图模型；
 *   2) 缺口过大/加入时接收 room:state 全量快照，整体替换本地状态。
 *
 * 状态来源只有一个（服务端权威），因此不存在对账冲突；客户端发送的
 * room:action 不做乐观 UI——消息会经 room:event 回灌，UI 以服务端为准。
 *
 * 生命周期（joinRoom 幂等）：
 *   idle ──joinRoom()──▶ joining ──room:state──▶ joined
 *                                        │
 *                                        ├─ 断线重连 ──room:sync──▶ 增量补齐
 *                                        └─ leaveRoom() ──▶ idle
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RoomPhase, RoomMemberInfo, RoomServerFrame, RoomSnapshot, RoomEventType, RoomEventPayloadMap, RoomMessageAppendedPayload, RoomStatePatchPayload, RoomDiceResultPayload, RoomMetaPayload, RoomTracePayload } from '../../../shared/types/room'
import type { Message } from '../../../shared/types/game'
import type { COCCharacterSheet } from '../../../shared/types/character'
import { getBridge } from '../platform'

export type RoomConnectionState = 'idle' | 'joining' | 'joined' | 'error'

/** 全局帧订阅只挂接一次（roomStore 是 pinia 单例，多页面复用同一实例）。 */
let frameBridgeWired = false
let frameBridgeOff: (() => void) | null = null
let reconnectOff: (() => void) | null = null
let pendingSeq = 0

export interface RoomMessageRecord {
  id: string
  timestamp: number
  role: 'kp' | 'player' | 'system'
  playerName?: string
  content: string
  isStreaming?: boolean
  /** 乐观消息标记（唯一乐观面 = 自己的 chat，ADR-0002；服务端 echo 到达后移除）。 */
  pending?: boolean
}

function toMessage(m: RoomMessageRecord): Message {
  if (m.role === 'player') {
    return { id: m.id, timestamp: m.timestamp, role: 'player', playerName: m.playerName ?? '调查员', content: m.content }
  }
  if (m.role === 'system') {
    return { id: m.id, timestamp: m.timestamp, role: 'system', content: m.content }
  }
  return { id: m.id, timestamp: m.timestamp, role: 'kp', content: m.content, isStreaming: m.isStreaming }
}

export const useRoomStore = defineStore('room', () => {
  /** 当前所在房间 id（未加入为 null）。 */
  const roomId = ref<string | null>(null)
  /** 房间邀请码（owner 视角展示用）。 */
  const inviteCode = ref('')
  /** 房间阶段。 */
  const phase = ref<RoomPhase>('lobby')
  /** 剧本 id（owner 开始游戏后存在）。 */
  const storyId = ref<string | null>(null)
  /** 当前场景。 */
  const scene = ref<string | null>(null)
  /** 成员列表（room_meta 事件更新；member 加入/离开无专门事件，REST 刷新兜底）。 */
  const members = ref<RoomMemberInfo[]>([])
  /** 消息流（服务端权威，按 seq 应用）。 */
  const messages = ref<RoomMessageRecord[]>([])
  /** 线索列表。 */
  const clues = ref<{ id: string; description: string }[]>([])
  /** 角色卡组（characterId → sheet）。 */
  const characters = ref<Record<string, unknown>>({})
  /** 结局（房间 ended 后存在）。 */
  const ending = ref<unknown | null>(null)
  /** 连接状态。 */
  const connectionState = ref<RoomConnectionState>('idle')
  /** 错误信息（error 状态时展示）。 */
  const errorMessage = ref('')
  /** 已应用的最高 seq（增量对账水位；0 = 未同步）。 */
  const lastSeq = ref(0)
  /** 是否正在同步（加入/重连补齐中）。 */
  const isSyncing = ref(false)

  /** 当前用户 id（joinRoom 时经 me() 获取，用于 isOwner 判定）。 */
  const selfUserId = ref<number | null>(null)
  /** 房主 id（REST 详情）。 */
  const ownerId = ref<number | null>(null)

  /** 当前用户是否为房主。 */
  const isOwner = computed(() => ownerId.value !== null && ownerId.value === selfUserId.value)

  const isPlaying = computed(() => phase.value === 'playing')
  const isEnded = computed(() => phase.value === 'ended')

  /** 自己的成员信息（昵称/绑定角色卡用）。 */
  const selfMember = computed(() => members.value.find((m) => m.userId === selfUserId.value) ?? null)
  /** 自己的昵称（乐观消息 + 结局页署名）。 */
  const selfName = computed(() => selfMember.value?.username ?? '调查员')
  /** 自己绑定的角色卡（state_patch 服务端推平，客户端零变更器）。 */
  const selfCharacterSheet = computed(() => {
    const cid = selfMember.value?.characterId
    if (!cid) return null
    return (characters.value[cid] as COCCharacterSheet | undefined) ?? null
  })
  /** KP 回合进行中（发消息后置位，KP 回复到达后清位——推进中占位）。 */
  const awaitingKp = ref(false)

  /** 归一化服务端快照 → 本地视图模型。 */
  function applySnapshot(snap: RoomSnapshot): void {
    lastSeq.value = typeof snap.seq === 'number' ? snap.seq : 0
    phase.value = snap.phase ?? 'lobby'
    storyId.value = snap.storyId ?? null
    scene.value = snap.scene ?? null
    clues.value = Array.isArray(snap.clues) ? snap.clues : []
    ending.value = snap.ending ?? null
    characters.value = (snap.characters && typeof snap.characters === 'object') ? snap.characters : {}
    messages.value = Array.isArray(snap.messages) ? snap.messages as RoomMessageRecord[] : []
    // 成员列表来自 REST（room:state 不含 members；room_meta 事件会覆盖）
  }

type RoomEventPayload = RoomEventPayloadMap[RoomEventType]

  /** 应用增量事件（按 seq 严格递增，服务端已保证全序）。 */
  function applyEvent(seq: number, eventType: RoomEventType, payload: RoomEventPayload): void {
    if (seq <= lastSeq.value) return // 乱序/重复帧丢弃（幂等）
    lastSeq.value = seq

    switch (eventType) {
      case 'message_appended': {
        const p = payload as RoomMessageAppendedPayload
        if (!p?.message || typeof p.message.content !== 'string') break
        // 乐观对齐：自己的玩家消息 echo 到达 → 移除同内容 pending；KP/系统消息到达 → 清推进中
        if (p.message.role === 'player') {
          if (p.author?.userId === selfUserId.value) {
            const idx = messages.value.findIndex((m) => m.pending && m.role === 'player' && m.content === p.message.content)
            if (idx >= 0) messages.value.splice(idx, 1)
          }
        } else {
          awaitingKp.value = false
        }
        // payload 携带服务端完整 Message（含 id/timestamp/playerName）——直接 append
        messages.value.push(p.message)
        break
      }
      case 'state_patch': {
        const p = payload as RoomStatePatchPayload
        if (!p || typeof p.path !== 'string') break
        applyPathPatch(p.path, p.value)
        break
      }
      case 'dice_result': {
        const p = payload as RoomDiceResultPayload
        if (!p) break
        messages.value.push({
          id: `dice_${seq}`,
          timestamp: Date.now(),
          role: 'system',
          content: p.displayText || `${p.expr} → ${(p.rolls ?? []).join(', ')}`,
        })
        break
      }
      case 'room_meta': {
        const p = payload as RoomMetaPayload
        if (!p) break
        if (typeof p.phase === 'string') phase.value = p.phase
        if (Array.isArray(p.members)) members.value = p.members
        break
      }
      case 'trace':
        break // 调试帧，视图不消费
    }
  }

  /** 应用 state_patch 路径补丁（characters.<id> 全量替换 / clues 全量 / scene / ending）。 */
  function applyPathPatch(path: string, value: unknown): void {
    if (path === 'clues') {
      if (Array.isArray(value)) clues.value = value as { id: string; description: string }[]
      return
    }
    if (path === 'scene') {
      scene.value = typeof value === 'string' ? value : null
      return
    }
    if (path === 'ending') {
      ending.value = value ?? null
      return
    }
    if (path.startsWith('characters.')) {
      const id = path.slice('characters.'.length)
      if (value && typeof value === 'object') {
        const cur = characters.value[id]
        // 服务端全量 sheet 补丁：合并（保留本地展示字段）
        characters.value = { ...characters.value, [id]: { ...(cur as object), ...(value as object) } }
      }
      return
    }
    // 未知路径忽略（服务端未来扩展字段的兼容策略）
  }

  /** 分发服务端帧（roomStore 唯一入口）。 */
  function handleServerFrame(frame: RoomServerFrame): void {
    if (!frame || typeof frame !== 'object') return
    switch (frame.type) {
      case 'room:state': {
        if (frame.roomId !== roomId.value) return
        isSyncing.value = false
        connectionState.value = 'joined'
        errorMessage.value = ''
        applySnapshot(frame.snapshot)
        break
      }
      case 'room:event': {
        if (frame.roomId !== roomId.value) return
        applyEvent(frame.seq, frame.eventType, frame.payload)
        break
      }
      case 'room:sync:done': {
        if (frame.roomId !== roomId.value) return
        isSyncing.value = false
        break
      }
      case 'room:error': {
        if (frame.roomId && frame.roomId !== roomId.value) return
        errorMessage.value = frame.error
        connectionState.value = 'error'
        isSyncing.value = false
        awaitingKp.value = false
        break
      }
    }
  }

  /** REST 刷新房间元信息（成员/阶段/剧本）——加入后与成员变更后调用。 */
  async function refreshMeta(): Promise<void> {
    const rid = roomId.value
    if (!rid) return
    try {
      const detail = await getBridge().roomDetail(rid)
      phase.value = detail.phase
      storyId.value = detail.storyId
      members.value = detail.members
      inviteCode.value = detail.inviteCode
      ownerId.value = detail.ownerId
    } catch {
      // REST 失败不阻塞房间（WS 流仍可用）；成员列表留待 room_meta 事件
    }
  }

  /** 加入房间：订阅帧 → 发送 room:join → 等全量快照。幂等（已加入则重置重同步）。 */
  async function joinRoom(rid: string): Promise<void> {
    if (connectionState.value === 'joining' || connectionState.value === 'joined') {
      if (roomId.value === rid) return
    }
    leaveRoom()
    // 首次使用时挂接全局帧路由 + 重连通知（一次）
    if (!frameBridgeWired) {
      frameBridgeWired = true
      frameBridgeOff = getBridge().onRoomFrame((frame) => {
        handleServerFrame(frame)
      })
      // 审查修复 #2：断线自动重连成功后重新订阅房间（服务端 socket 订阅已丢）
      reconnectOff = getBridge().onReconnect(() => {
        const rid2 = roomId.value
        if (!rid2 || connectionState.value !== 'joined') return
        connectionState.value = 'joining'
        isSyncing.value = true
        try {
          getBridge().sendRoomFrame('room:join', { roomId: rid2 })
          void refreshMeta()
        } catch {
          connectionState.value = 'error'
          isSyncing.value = false
        }
      })
    }
    roomId.value = rid
    connectionState.value = 'joining'
    isSyncing.value = true
    errorMessage.value = ''
    lastSeq.value = 0
    messages.value = []
    clues.value = []
    characters.value = {}
    scene.value = null
    ending.value = null
    phase.value = 'lobby'

    try {
      await getBridge().connectWs()
      // 当前用户 id（isOwner 判定用）
      try {
        const me = await getBridge().me()
        selfUserId.value = Number(me.user.id)
      } catch { selfUserId.value = null }
      getBridge().sendRoomFrame('room:join', { roomId: rid })
      await refreshMeta()
    } catch (err) {
      connectionState.value = 'error'
      isSyncing.value = false
      errorMessage.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 离开房间：发送 room:leave → 清理本地状态。 */
  function leaveRoom(): void {
    const rid = roomId.value
    if (rid) {
      try {
        getBridge().sendRoomFrame('room:leave', { roomId: rid })
      } catch {
        // 未连接时忽略（本地清理照常）
      }
    }
    roomId.value = null
    inviteCode.value = ''
    phase.value = 'lobby'
    storyId.value = null
    scene.value = null
    members.value = []
    messages.value = []
    clues.value = []
    characters.value = {}
    ending.value = null
    connectionState.value = 'idle'
    errorMessage.value = ''
    lastSeq.value = 0
    isSyncing.value = false
    awaitingKp.value = false
    selfUserId.value = null
    ownerId.value = null
  }

  /** 断线重连增量补齐：向服务端请求 lastSeq 之后的增量（缺口过大 → 全量快照）。 */
  function resync(): void {
    const rid = roomId.value
    if (!rid) return
    isSyncing.value = true
    try {
      getBridge().sendRoomFrame('room:sync', { roomId: rid, lastSeq: lastSeq.value })
    } catch (err) {
      isSyncing.value = false
      errorMessage.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 发送聊天消息：本地乐观追加（pending）→ 服务端串行入队；服务端 echo 到达后对齐。 */
  function sendChat(content: string): void {
    const rid = roomId.value
    if (!rid || connectionState.value !== 'joined') return
    const trimmed = content.trim()
    if (!trimmed) return
    // 唯一乐观面（ADR-0002）：自己的消息立即显示；KP 回复前显示推进中占位
    messages.value.push({
      id: `local_${Date.now()}_${pendingSeq++}`,
      timestamp: Date.now(),
      role: 'player',
      playerName: selfName.value,
      content: trimmed,
      pending: true,
    })
    awaitingKp.value = true
    try {
      getBridge().sendRoomFrame('room:action', { roomId: rid, action: { type: 'chat', payload: { content: trimmed } } })
    } catch (err) {
      // 发送失败：撤回乐观消息（服务端权威无此消息）
      const idx = messages.value.findIndex((m) => m.pending && m.content === trimmed)
      if (idx >= 0) messages.value.splice(idx, 1)
      awaitingKp.value = false
      errorMessage.value = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    roomId,
    inviteCode,
    phase,
    storyId,
    scene,
    members,
    messages,
    clues,
    characters,
    ending,
    connectionState,
    errorMessage,
    lastSeq,
    isSyncing,
    isOwner,
    isPlaying,
    isEnded,
    selfMember,
    selfName,
    selfCharacterSheet,
    awaitingKp,
    joinRoom,
    leaveRoom,
    resync,
    sendChat,
    refreshMeta,
    handleServerFrame,
    // 视图辅助
    toMessage,
  }
})

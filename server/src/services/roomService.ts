/**
 * RoomService — 服务端房间会话（Phase B1，架构方案 v2.0 §三/D6/D7）。
 *
 * 每房间一个实例，是房间状态的**唯一权威**：
 *  - 状态真源：成员角色组 / 线索 / 场景 / 消息流 / 结局 / seq 水位
 *  - 串行队列：动作按到达顺序处理，seq 全序分配，杜绝并发冲突
 *  - KP 回合：复用 kpTurnService 的服务端图内工具循环（角色卡/世界增量由
 *    本服务维护，不再依赖客户端上传快照）
 *  - 持久化：变更节流落库（rooms.state 快照）+ TTL 回收 + 重连游标
 *
 * 单人模式 = 单成员房间（同一代码路径，FR-M9）。
 */
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { RoomStoryBundle } from './roomStoryRevision.js'
import * as roomStorage from './roomStorage.js'
export { RoomWorkerBusyError } from './roomStorage.js'
import { logger } from '../utils/logging.js'
import { createCharacterMutatorFactory, type CharacterEnding } from '../rule-engine/characterMutators.js'
import { getRoomContextBudgetChars, isKpChunkStreamEnabled, isMockAiMode, ROOM_WORKER_FAILOVER_ENABLED, ROOM_WORKER_LEASE_MS, SHARED_ROOMS_ENABLED, SHARED_ROOM_CATALOG_ENABLED } from '../config.js'
import { buildRoomTurnMessages, buildRoomOpeningMessages, roomConversationLookback, MAX_MEMORY_ENTRIES, type RoomPromptInput, type StoryWorkflow } from './kpPromptService.js'
import { acquireKpTurn } from './kpAdmission.js'
// 开局门闩判定单源（deep module，架构走查候选 4）：startRoom / createSoloRoom 双入口
// 共用 checkStartGate，差异用 gateFor 表达。startGate 是零 fs/db 运行时依赖的叶子
// （dossierCore/ragService 知识层走其内部动态 import，唯一静态运行时依赖是零依赖
// 纯函数 codec roomStateCodec），静态引入不加重量。
import { checkStartGate, sanitizeWorkflow } from './startGate.js'
// rooms.state JSON 文档 codec（#61）：读点容错解析 / 写点序列化单点收口。
import { parseRoomState, parseRoomStateOr, serializeRoomState } from './roomStateCodec.js'
import type {
  RoomActionResult,
  RoomEventPayloadMap,
  RoomEventType,
  RoomHistoryPage,
  RoomMemberInfo,
  RoomMemberRole,
  RoomPhase as SharedRoomPhase,
  RoomSnapshot as SharedRoomSnapshot,
} from '../../../shared/types/room.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'

/** 房间阶段（shared 单一来源别名——评审候选 3）。 */
export type RoomPhase = SharedRoomPhase

/** 房间成员角色（shared 单一来源别名）。 */
export type MemberRole = RoomMemberRole

export type RoomMember = RoomMemberInfo

/** 房间事件（全序，seq 由 RoomService 串行分配）；payload 单一来源 = shared RoomEventPayloadMap。 */
export type RoomEvent = { [K in RoomEventType]: { type: K; payload: RoomEventPayloadMap[K] } }[RoomEventType]

interface PendingTurnMessage {
  username: string
  content: string
  characterId: string | null
  authorUserId: number
  actionId?: string
  messageId?: string
}

interface PlayerTurnCheckpoint {
  id: string
  actionCount: number
}

/** 房间持久化快照（rooms.state JSON）。 */
export interface RoomSnapshot {
  seq: number
  phase: RoomPhase
  storyId: string | null
  messages: Message[]
  transcript?: SharedRoomSnapshot['transcript']
  hasNarrative?: boolean
  characters: Record<string, COCCharacterSheet>
  clues: { id: string; description: string }[]
  scene: string | null
  ending: unknown | null
  turnWindowMs: number
  /** 房间知识 workflow（实验分支双轨；缺省 rag=现状）。 */
  workflow?: StoryWorkflow
  /** KP 记忆条目（ADR-0002 上下文收口，服务端持有）。 */
  kpMemory?: string[]
  /** 长期摘要（ADR-0002 上下文收口，服务端持有）。 */
  longTermSummary?: string
  /** 每房间近期对话上下文预算（字符数）；旧快照使用当前服务端配置。 */
  contextBudgetChars?: number
  /** Pending player actions survive a paused KP turn and server restart. */
  pendingTurnMessages?: PendingTurnMessage[]
  /** A claimed batch stays at the head of pendingTurnMessages across worker restarts. */
  pendingPlayerTurn?: PlayerTurnCheckpoint
  openingCheckpointed?: boolean
  /** True while the current room owner must complete AI settings before KP can run. */
  kpSetupRequired?: boolean
  updatedAt: number
}

interface RoomOptions {
  roomId: string
  ownerId: number
  ownerName: string
  storyId?: string | null
  storyOwnerId?: number | null
  turnWindowMs?: number
  workflow?: StoryWorkflow
  contextBudgetChars?: number
  restore?: RoomSnapshot | null
  workerLease?: roomStorage.RoomWorkerLease
}

class RoomStoryUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The pinned story revision is unavailable.', options)
  }
}

const DEFAULT_TURN_WINDOW_MS = 5_000
const SNAPSHOT_EVERY_N_EVENTS = 20
const SNAPSHOT_EVERY_MS = 10_000
const ROOM_TTL_MS = 30 * 60_000
/** 事件日志环形容量（Phase C1：重连增量窗口；超出 → 全量快照兜底）。 */
const MAX_EVENT_LOG = roomStorage.ROOM_EVENT_WINDOW
const HOT_TRANSCRIPT_MESSAGES = 40
const HOT_TRANSCRIPT_BYTES = 512 * 1024

function snapshotHasRecoverableTurn(snapshot: RoomSnapshot): boolean {
  return !snapshot.kpSetupRequired && (snapshot.pendingTurnMessages?.length ?? 0) > 0
}

function isNarrative(message: Message): boolean {
  return message?.role === 'player' || message?.role === 'kp'
}

function boundTranscript(snapshot: Pick<RoomSnapshot, 'messages' | 'transcript' | 'hasNarrative'>): void {
  const { messages } = snapshot
  if (!snapshot.hasNarrative && messages.some(isNarrative)) snapshot.hasNarrative = true
  let cutoff = messages.length
  let bytes = 0
  const earliest = Math.max(0, messages.length - HOT_TRANSCRIPT_MESSAGES)
  while (cutoff > earliest) {
    bytes += Buffer.byteLength(JSON.stringify(messages[cutoff - 1])) + 1
    if (bytes > HOT_TRANSCRIPT_BYTES) break
    cutoff--
  }
  if (cutoff > 0) snapshot.messages = messages.slice(cutoff)
  if (cutoff > 0 || snapshot.transcript) snapshot.transcript = { before: snapshot.messages[0]?.id ?? null }
}

const MAX_PENDING_PLAYER_ACTIONS = 32
/** 每 N 个 KP 回合刷新一次长期摘要（场景切换也会触发）。 */
const LONG_TERM_SUMMARY_EVERY_TURNS = 10
const ROOM_SUMMARY_SOURCE_MAX_CHARS = 12_000

function isValidContextBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 房间侧故事上下文（#73）：runKpTurnForRoom 的 storyContext 通道。房间路径唯一
 * 构造点 = 私有 buildStoryContext()（未绑定剧本传 null）。KP 图
 * （kpGraph）按 scriptId/sceneId 做脚本门控（loadScriptContext）；workflow 目前
 * 仅透传（图内未读，留作知识分派的显式通道）。图内还消费宽键集（sanity/openClues/
 * act/activeNPCs/forceTransitionScene——shared StoryContext 的 Electron 遗产形状），
 * 房间路径不构造它们（上下文服务端收口 ADR-0002 后客户端不再发送）。以 type alias
 * 而非 interface 声明：下游 runKpTurn 的 body.storyContext 仍是
 * `Record<string, unknown> | null`，interface 无隐式索引签名会断型。
 */
export type RoomStoryContext = {
  /** IDs of already obtained story clues, derived from server-owned room state. */
  openClues: string[]
  /** 当前剧本 id（KP 图脚本门控 loadScriptContext 的入参）。 */
  scriptId: string
  /** Account owning the selected story artifacts; AI calls use the current room owner. */
  storyOwnerId: number
  /** 房间当前场景名（未切过场景以 undefined 传递；门控据此定位当前场景）。 */
  sceneId?: string
  /** 房间知识 workflow（rag/dossier；图内暂未读，透传保留）。 */
  workflow: StoryWorkflow
  /** Dossier terminal metadata, kept out of player-facing prompt text. */
  terminalEndings?: { name: string; condition: string; outcome?: string; relatedTruths?: string[] }[]
}

/**
 * 房间实例。所有状态变更必须经 enqueue（串行），事件按 seq 全序广播。
 */
export class RoomService {
  readonly roomId: string
  readonly workerLease?: roomStorage.RoomWorkerLease
  /** 现任房主（转让/断线易主后随 syncFromDb 更新——KP/RAG/记忆全程跟随现任 owner）。 */
  private ownerId: number
  private ownershipVersion = 0
  private ownerName: string

  private phase: RoomPhase = 'lobby'
  private storyId: string | null = null
  /** Account that owns the selected story artifacts; unlike AI identity, this survives handoff. */
  private storyOwnerId: number | null = null
  private storyRevision: roomStorage.StoryRevisionPin | null = null
  private kpSetupRequired = false
  private messages: Message[] = []
  private characters = new Map<string, COCCharacterSheet>()
  /** characterId → 绑定它的成员 userId（D5 归属校验）。 */
  private characterOwner = new Map<string, number>()
  private clues: { id: string; description: string }[] = []
  private scene: string | null = null
  private ending: unknown = null
  private turnWindowMs: number
  /** 房间知识 workflow（dossier 房 = 档案静态注入 + 查证工具）。 */
  private workflow: StoryWorkflow
  /** KP 记忆条目（服务端持有，ADR-0002）。 */
  private kpMemory: string[] = []
  /** 长期摘要（服务端持有，ADR-0002）。 */
  private longTermSummary = ''
  private contextBudgetChars: number
  private turnCount = 0
  /** opening 回合已触发标记（实例生命周期内一次；失败不重试内重入）。 */
  private openingStarted = false
  private openingInFlight = false
  private readonly lifetime = new AbortController()
  private get disposed(): boolean { return this.lifetime.signal.aborted }
  private summarizing = false
  private summaryRefreshPending = false
  private seq = 0
  private persistedSeq = 0
  private lastSnapshotAt = Date.now()
  private lastActivityAt = Date.now()
  private queue: Promise<unknown> = Promise.resolve()
  private queuedClientActions = 0
  private readonly listeners = new Set<(event: RoomEvent, seq: number) => void>()
  /** 事件日志（Phase C1）：带 seq 的增量事件，环形保留最近 MAX_EVENT_LOG 条。 */
  private eventLog: { seq: number; event: RoomEvent }[] = []
  private eventLogStartSeq = 0
  private snapshotTimer: NodeJS.Timeout | null = null
  private leaseTimer: NodeJS.Timeout | null = null
  private renewingLease = false
  private pendingPlayerTurn?: PlayerTurnCheckpoint
  private openingCheckpointed = false
  private hasNarrative = false
  private transcript?: RoomSnapshot['transcript']
  /** 回合窗口（D4）：缓冲窗口内玩家消息，超时合并进一次 KP 回合。 */
  private turnBuffer: PendingTurnMessage[] = []
  /** Batch currently executing; included in snapshots until its turn commits. */
  private activeTurnBatch: PendingTurnMessage[] = []
  private turnTimer: NodeJS.Timeout | null = null
  private turnFlushing = false

  constructor(private readonly opts: RoomOptions) {
    this.roomId = opts.roomId
    this.workerLease = opts.workerLease
    this.ownerId = opts.ownerId
    this.ownerName = opts.ownerName
    this.storyId = opts.storyId ?? null
    this.storyOwnerId = opts.storyOwnerId ?? (this.storyId ? opts.ownerId : null)
    this.turnWindowMs = opts.turnWindowMs ?? DEFAULT_TURN_WINDOW_MS
    this.workflow = opts.workflow ?? 'rag'
    this.contextBudgetChars = isValidContextBudget(opts.contextBudgetChars)
      ? opts.contextBudgetChars
      : getRoomContextBudgetChars()
    if (opts.restore) {
      this.phase = opts.restore.phase ?? 'lobby'
      this.storyId = opts.restore.storyId ?? null
      this.kpSetupRequired = opts.restore.kpSetupRequired === true
      this.turnBuffer = Array.isArray(opts.restore.pendingTurnMessages)
        ? opts.restore.pendingTurnMessages.filter((entry): entry is PendingTurnMessage =>
            !!entry && typeof entry.username === 'string' && typeof entry.content === 'string' &&
            (entry.characterId === null || typeof entry.characterId === 'string') && Number.isSafeInteger(entry.authorUserId) &&
            (entry.actionId === undefined || typeof entry.actionId === 'string') &&
            (entry.messageId === undefined || typeof entry.messageId === 'string'),
          )
        : []
      const checkpoint = opts.restore.pendingPlayerTurn
      if (this.workerLease && checkpoint && typeof checkpoint.id === 'string' &&
          Number.isSafeInteger(checkpoint.actionCount) && checkpoint.actionCount > 0 && checkpoint.actionCount <= this.turnBuffer.length) {
        this.pendingPlayerTurn = checkpoint
      }
      this.openingCheckpointed = opts.restore.openingCheckpointed === true
      this.hasNarrative = opts.restore.hasNarrative === true
      this.messages = Array.isArray(opts.restore.messages) ? opts.restore.messages : []
      this.transcript = opts.restore.transcript
      this.characters = new Map(Object.entries(opts.restore.characters ?? {}))
      this.clues = Array.isArray(opts.restore.clues) ? opts.restore.clues : []
      this.scene = opts.restore.scene ?? null
      this.ending = opts.restore.ending ?? null
      this.seq = typeof opts.restore.seq === 'number' ? opts.restore.seq : 0
      this.turnWindowMs = opts.restore.turnWindowMs ?? DEFAULT_TURN_WINDOW_MS
      this.workflow = opts.restore.workflow === 'dossier' ? 'dossier' : 'rag'
      this.kpMemory = Array.isArray(opts.restore.kpMemory) ? opts.restore.kpMemory : []
      this.longTermSummary = typeof opts.restore.longTermSummary === 'string' ? opts.restore.longTermSummary : ''
      if (isValidContextBudget(opts.restore.contextBudgetChars)) this.contextBudgetChars = opts.restore.contextBudgetChars
    }
    this.persistedSeq = this.seq
    this.snapshotTimer = setInterval(() => {
      void this.maybeSnapshot().catch((error: unknown) => {
        logger.warn('periodic room snapshot failed', { roomId: this.roomId, error: String(error) })
      })
    }, SNAPSHOT_EVERY_MS)
    this.snapshotTimer.unref?.()
    if (this.workerLease) {
      this.leaseTimer = setInterval(() => {
        if (this.renewingLease || this.disposed) return
        this.renewingLease = true
        void this.renewWorkerLease().catch((error) => {
          logger.warn('room worker lease renewal failed', { roomId: this.roomId, error: String(error) })
        }).finally(() => { this.renewingLease = false })
      }, Math.floor(ROOM_WORKER_LEASE_MS / 3))
      this.leaseTimer.unref?.()
    }
  }

  async renewWorkerLease(): Promise<boolean> {
    if (this.disposed) return false
    if (!this.workerLease) return true
    try {
      if (await roomStorage.renewRoomLease(this.roomId, this.workerLease)) return !this.disposed
      this.retireWorker()
      return false
    } catch (error) {
      this.retireWorker()
      throw error
    }
  }

  private retireWorker(): void {
    this.dispose()
    if (getRoom(this.roomId) === this) roomRegistry.delete(this.roomId)
  }

  /* ═══════════════ 查询（只读，无需入队） ═══════════════ */

  getPhase(): RoomPhase { return this.phase }
  /** 结束态（终态，#54）。方法形态：调用点能拿到"此刻"的值，不受 TS 属性收窄影响。 */
  isEnded(): boolean { return this.phase === 'ended' }
  getSeq(): number { return this.seq }
  getStoryId(): string | null { return this.storyId }
  getStoryOwnerId(): number | null { return this.storyOwnerId }
  getKpSetupRequired(): boolean { return this.kpSetupRequired }
  getWorkflow(): StoryWorkflow { return this.workflow }
  getScene(): string | null { return this.scene }
  getMessages(): readonly Message[] { return this.messages }
  getMembers(): RoomMemberInfo[] { return this.members }
  getCharacters(): ReadonlyMap<string, COCCharacterSheet> { return this.characters }
  getClues(): readonly { id: string; description: string }[] { return this.clues }
  getEnding(): unknown { return this.ending }
  isStale(): boolean {
    return !this.turnFlushing && !this.openingInFlight && this.queuedClientActions === 0 &&
      Date.now() - this.lastActivityAt > ROOM_TTL_MS
  }

  /** 序列化快照（落库/重连全量）。 */
  snapshot(): RoomSnapshot {
    return {
      seq: this.seq,
      phase: this.phase,
      storyId: this.storyId,
      messages: this.messages,
      transcript: this.transcript,
      hasNarrative: this.hasNarrative || undefined,
      characters: Object.fromEntries(this.characters),
      clues: this.clues,
      scene: this.scene,
      ending: this.ending,
      turnWindowMs: this.turnWindowMs,
      workflow: this.workflow === 'dossier' ? 'dossier' : 'rag',
      kpMemory: this.kpMemory,
      longTermSummary: this.longTermSummary,
      contextBudgetChars: this.contextBudgetChars,
      pendingTurnMessages: [...this.activeTurnBatch, ...this.turnBuffer],
      pendingPlayerTurn: this.pendingPlayerTurn,
      openingCheckpointed: this.openingCheckpointed || undefined,
      kpSetupRequired: this.kpSetupRequired,
      updatedAt: Date.now(),
    }
  }

  /** 订阅房间事件（增量广播）。回调携带 (event, seq)——seq 不经 seam 丢失（评审候选 3）。返回取消函数。 */
  subscribe(listener: (event: RoomEvent, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /* ═══════════════ 串行执行 ═══════════════ */

  /** 串行入队：任何状态变更/事件广播都经此执行，保证 seq 全序。 */
  /** 串行入队：任何状态变更/事件广播都经此执行，保证 seq 全序。 */
  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    this.lastActivityAt = Date.now()
    const run = this.queue.then(() => task())
    // 队列链必须更新（否则并发任务并行执行，破坏全序）；吞错避免队列卡死。
    this.queue = run.catch(() => undefined)
    return run
  }

  enqueueClientAction<T>(task: () => Promise<T>): Promise<T> | null {
    if (this.disposed || this.queuedClientActions >= MAX_PENDING_PLAYER_ACTIONS) return null
    this.queuedClientActions++
    return this.enqueue(task).finally(() => { this.queuedClientActions-- })
  }

  private emit(event: RoomEvent): void {
    this.seq += 1
    // 事件日志（环形缓冲，Phase C1 重连增量）：保留最近 MAX_EVENT_LOG 条。
    this.eventLog.push({ seq: this.seq, event })
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog.shift()
    }
    this.eventLogStartSeq = this.eventLog[0]?.seq ?? this.seq
    for (const l of this.listeners) {
      try { l(event, this.seq) } catch { /* 监听器错误不影响广播 */ }
    }
  }

  /** 增量事件（lastSeq 之后；返回 null 表示缺口过大需全量快照）。
   * lastSeq=0（客户端无状态）或 < 日志起始 seq → 全量。 */
  getEventsSince(lastSeq: number): { seq: number; event: RoomEvent }[] | null {
    if (lastSeq <= 0 || lastSeq > this.seq) return null
    if (lastSeq === this.seq) return []
    if (lastSeq < this.eventLogStartSeq - 1) return null
    const events = this.eventLog.filter((e) => e.seq > lastSeq)
    return events.length === this.seq - lastSeq ? events : null
  }

  /* ═══════════════ 动作处理 ═══════════════ */

  /** 追加玩家/KP 消息并广播（message_appended，payload 携带完整 Message）。 */
  appendMessage(msg: Message, author: { userId: number; roleName: string }): void {
    this.messages.push(msg)
    this.emit({
      type: 'message_appended',
      payload: { message: msg, author },
    })
  }

  /** 角色卡状态补丁（state_patch）。 */
  patchCharacter(characterId: string, patch: Record<string, unknown>): void {
    const cur = this.characters.get(characterId)
    if (!cur) return
    Object.assign(cur, patch)
    this.emit({ type: 'state_patch', payload: { path: `characters.${characterId}`, value: patch } })
  }

  /** 线索追加（state_patch）。 */
  addClue(description: string, clueId?: string): void {
    const id = clueId ?? `clue_${this.seq + 1}`
    if (!this.clues.some((c) => c.id === id || c.description === description)) {
      this.clues.push({ id, description })
      this.emit({ type: 'state_patch', payload: { path: 'clues', value: this.clues } })
    }
  }

  /** 场景切换（state_patch）；场景变化触发长期摘要刷新（fire-and-forget，不阻塞回合）。 */
  setScene(sceneName: string): void {
    const changed = this.scene !== sceneName
    this.scene = sceneName
    this.emit({ type: 'state_patch', payload: { path: 'scene', value: sceneName } })
    if (changed) void this.refreshLongTermSummary()
  }

  /** 结局（state_patch + phase 变更）。 */
  setEnding(ending: unknown): Promise<void> {
    this.ending = ending
    this.phase = 'ended'
    this.emit({ type: 'state_patch', payload: { path: 'ending', value: ending } })
    this.emit({ type: 'room_meta', payload: { phase: 'ended', turnWindowMs: this.turnWindowMs, members: this.members } })
    // Endings are terminal state. Persist them immediately instead of waiting
    // for the normal event-count/time snapshot threshold.
    return this.persistSnapshot().catch((err) => {
      logger.warn('room ending snapshot failed', { roomId: this.roomId, error: err instanceof Error ? err.message : String(err) })
    })
  }

  /** 设置房间阶段（room_meta）。 */
  setPhase(phase: RoomPhase): void {
    this.phase = phase
    this.persistPhase(phase)
    this.emit({ type: 'room_meta', payload: { phase, turnWindowMs: this.turnWindowMs, members: this.members } })
  }

  private persistPhase(phase: RoomPhase): void {
    void withRoomCommand(this.roomId, () => roomStorage.updateRoomPhase(this.roomId, phase, this.workerLease)).catch((error) => {
      logger.error('room phase persistence failed', { roomId: this.roomId, phase, error: String(error) })
    })
  }

  private members: RoomMember[] = []

  /** Callers hold the room command slot. The worker publishes only committed metadata. */
  async broadcastMembers(members: RoomMember[]): Promise<void> {
    const event: RoomEvent = { type: 'room_meta', payload: { phase: this.phase, turnWindowMs: this.turnWindowMs, members } }
    if (this.workerLease) {
      await this.commitCheckpoint(this.snapshot(), [event], () => { this.members = members })
    } else {
      this.members = members
      this.emit(event)
    }
  }

  /** 设置回合窗口（房主控制，B6）；0 = 严格排队。广播 room_meta 全员可见。 */
  async setTurnWindowMs(ms: number): Promise<void> {
    const clamped = Math.max(0, Math.min(60_000, Math.floor(ms)))
    const event: RoomEvent = { type: 'room_meta', payload: { phase: this.phase, turnWindowMs: clamped, members: this.members } }
    if (this.workerLease) {
      await this.commitCheckpoint({ ...this.snapshot(), turnWindowMs: clamped }, [event], () => { this.turnWindowMs = clamped })
    } else {
      this.turnWindowMs = clamped
      this.emit(event)
    }
  }

  getTurnWindowMs(): number {
    return this.turnWindowMs
  }

  /** 开始游戏（lobby → playing，绑定剧本）。 */
  startGame(storyId: string, storyOwnerId = this.ownerId): void {
    this.storyId = storyId
    this.storyOwnerId = storyOwnerId
    this.phase = 'playing'
    this.emit({ type: 'room_meta', payload: { phase: 'playing', turnWindowMs: this.turnWindowMs, members: this.members } })
  }

  /**
   * 从 DB 权威状态同步活跃实例（审查修复 #1/#3）：
   * REST start/绑定角色只写 DB，此处把 storyId/phase/characters map 同步进内存实例，
   * 使 KP 回合拿到剧本上下文、多角色分派拿到角色组。
   */
  async syncFromDb(): Promise<void> {
    const r = await roomStorage.getRoomRow(this.roomId)
    if (!r) return
    const [members, sheets] = await Promise.all([
      roomStorage.listMembers(this.roomId), roomStorage.boundCharacterSheets(this.roomId),
    ])
    this.members = members.map(memberRowToInfo)
    if (typeof r.story_id === 'string') this.storyId = r.story_id
    this.storyOwnerId = typeof r.story_id === 'string' ? (r.story_owner_id ?? r.owner_id) : null
    this.storyRevision = r.story_preparation_revision && r.story_source_revision
      ? { revision: r.story_preparation_revision, sourceRevision: r.story_source_revision }
      : null
    if (this.phase !== 'ended' && (r.phase === 'lobby' || r.phase === 'playing' || r.phase === 'ended')) {
      this.phase = r.phase
    }
    // 房主跟随 DB（ADR-0005 转让/断线易主）：KP/RAG/记忆解析账号 = 现任 owner
    this.updateOwner(r.owner_id)
    // 角色组：从 DB 绑定关系加载 sheet（characters 表是 sheet 权威）
    for (const b of sheets) {
      this.characterOwner.set(b.characterId, b.userId)
      if (this.characters.has(b.characterId)) continue
      try {
        const sheet = JSON.parse(b.sheet) as COCCharacterSheet
        this.characters.set(b.characterId, sheet)
      } catch { /* 脏 sheet 忽略 */ }
    }
    if (this.phase === 'playing') {
      void this.refreshOwnerAiSetupStatus().then((ready) => {
        if (ready && this.turnBuffer.length > 0) this.startBufferedTurn()
      }).catch((error) => {
        logger.warn('room AI setup status persistence failed', { roomId: this.roomId, ownerId: this.ownerId, error: String(error) })
      })
    }
  }

  /** Apply a committed transfer before an older Keeper turn can publish new effects. */
  updateOwner(ownerId: number): void {
    if (ownerId === this.ownerId) return
    this.ownerId = ownerId
    this.ownershipVersion += 1
    this.ownerName = this.members.find((member) => member.userId === ownerId)?.username ?? `user_${ownerId}`
  }

  /** 绑定角色卡（成员 → 房间角色组，Phase B4/B6）。 */
  bindCharacter(memberUserId: number, characterId: string, sheet: COCCharacterSheet): void {
    this.characterOwner.set(characterId, memberUserId)
    this.characters.set(characterId, sheet)
    this.emit({ type: 'state_patch', payload: { path: `characters.${characterId}`, value: sheet } })
  }

  /** 取单张角色卡（供 bindRoomCharacter 换绑后定向广播 sheet）。 */
  getCharacter(characterId: string): COCCharacterSheet | null {
    return this.characters.get(characterId) ?? null
  }

  /** 角色卡 sheet 定向广播（T4 #31：绑定/换绑后全员拿到 characters.<id>）。 */
  async emitSheetPatch(characterId: string, sheet: COCCharacterSheet): Promise<void> {
    const event: RoomEvent = { type: 'state_patch', payload: { path: `characters.${characterId}`, value: sheet } }
    if (this.workerLease) await this.commitCheckpoint(this.snapshot(), [event], () => {})
    else this.emit(event)
  }

  /** 角色卡归属查询（D5：工具 characterId 归属校验）。 */
  characterOwnerOf(characterId: string): number | null {
    return this.characterOwner.get(characterId) ?? null
  }

  /** 取房间角色组（characterId → sheet，供 KP 回合）。 */
  getCharacterMap(): Record<string, COCCharacterSheet> {
    return Object.fromEntries(this.characters)
  }

  /* ═══════════════ 回合窗口合并（D4） ═══════════════ */

  /** 玩家聊天（领域方法，ADR-0001）：解析身份 → 消息流广播 →（playing 才）进回合缓冲。
   *  Phase gate（ADR-0005）：lobby 等待室聊天只广播不触发 KP 回合。 */
  async submitPlayerChat(userId: number, content: string): Promise<boolean> {
    if (getRoom(this.roomId) === this) {
      const result = await this.queuePlayerChat(userId, content)
      return result !== null && 'messageId' in result
    }
    const [username, characterId] = await Promise.all([
      roomStorage.usernameOf(userId).then((name) => name ?? `user_${userId}`),
      roomStorage.memberCharacterId(this.roomId, userId),
    ])
    if (this.disposed) return false
    if (this.phase === 'playing' && this.turnBuffer.length >= MAX_PENDING_PLAYER_ACTIONS) return false
    const message: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(), role: 'player', playerName: username, content,
    }
    const author = { userId, roleName: username }
    const pending = this.phase === 'playing' ? { username, content, characterId, authorUserId: userId } : null
    if (SHARED_ROOMS_ENABLED) {
      const snapshot = this.snapshot()
      snapshot.messages = [...snapshot.messages, message]
      if (pending) snapshot.pendingTurnMessages = [...(snapshot.pendingTurnMessages ?? []), pending]
      await this.commitCheckpoint(snapshot, [{ type: 'message_appended', payload: { message, author } }], () => {
        this.messages = snapshot.messages
        if (pending) this.turnBuffer.push(pending)
      })
      if (pending) this.scheduleBufferedTurn()
    } else {
      this.appendMessage(message, author)
      if (pending) this.bufferPlayerChat(username, content, characterId, userId)
    }
    return true
  }

  /** Check membership and persist the receipt in the same room command slot. */
  queuePlayerChat(userId: number, content: string, clientActionId?: string): Promise<RoomActionResult> | null {
    // Legacy frames have no replay key. Keep their echoes and give each submission a server-side identity.
    const actionId = clientActionId ?? 'legacy:' + crypto.randomUUID()
    return this.enqueueClientAction(() => withRoomCommand(this.roomId, async () => {
      if (this.disposed || getRoom(this.roomId) !== this) {
        return { status: 'retry', code: 'room_inactive', error: '房间尚未连接，请重新进入后重试。' }
      }
      const member = await roomStorage.getRoomMember(this.roomId, userId)
      if (!member) return { status: 'rejected', code: 'not_member', error: '你已不在该房间内。' }
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(['chat', content])).digest('hex')
      const existing = await roomStorage.getRoomAction(this.roomId, userId, actionId)
      if (existing) {
        return existing.payload_hash === payloadHash
          ? { status: existing.status, messageId: existing.message_id }
          : { status: 'rejected', code: 'action_conflict', error: '此行动编号已用于另一条消息。' }
      }
      if (this.phase === 'playing' && this.turnBuffer.length + this.activeTurnBatch.length >= MAX_PENDING_PLAYER_ACTIONS) {
        return { status: 'busy', code: 'room_busy', error: '房间待处理的操作已满，请稍后重试。' }
      }

      if (this.phase === 'playing') {
        try {
          await this.loadTurnStory()
        } catch (error) {
          if (!(error instanceof RoomStoryUnavailableError)) throw error
          return { status: 'retry', code: 'story_unavailable', error: error.message }
        }
      }

      const message: Message = {
        id: `msg_${crypto.randomUUID()}`, timestamp: Date.now(), role: 'player', playerName: member.username, content,
      }
      const pending = this.phase === 'playing'
        ? { username: member.username, content, characterId: member.character_id, authorUserId: userId, actionId, messageId: message.id }
        : null
      const status = pending ? 'pending' : 'completed'
      const snapshot = this.snapshot()
      snapshot.messages = [...snapshot.messages, message]
      if (pending) snapshot.pendingTurnMessages = [...(snapshot.pendingTurnMessages ?? []), pending]
      const author = { userId, roleName: member.username }
      await this.commitCheckpoint(snapshot, [{ type: 'message_appended', payload: { message, author, actionId: clientActionId } }], () => {
        this.messages = snapshot.messages
        if (pending) this.turnBuffer.push(pending)
      }, [{ userId, actionId, payloadHash, messageId: message.id, status }])
      if (pending) this.scheduleBufferedTurn()
      return { status, messageId: message.id }
    }))
  }

  /** Buffer a player message and schedule Keeper processing. */
  bufferPlayerChat(username: string, content: string, characterId: string | null, authorUserId: number): void {
    this.turnBuffer.push({ username, content, characterId, authorUserId })
    this.scheduleBufferedTurn()
  }

  private scheduleBufferedTurn(): void {
    if (this.turnWindowMs <= 0) {
      this.startBufferedTurn()
      return
    }
    if (!this.turnTimer) {
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null
        this.startBufferedTurn()
      }, this.turnWindowMs)
      this.turnTimer.unref?.()
    }
  }

  private startBufferedTurn(): void {
    void this.flushTurn().catch((error: unknown) => {
      logger.warn('room turn interrupted', { roomId: this.roomId, error: String(error) })
    })
  }

  private async takePlayerTurnBatch(): Promise<{ batch: PendingTurnMessage[]; history: Message[] }> {
    return withRoomCommand(this.roomId, async () => {
      if (this.disposed || this.isEnded()) return { batch: [], history: [] }
      const queued = this.turnBuffer
      const candidates = this.pendingPlayerTurn ? queued.slice(0, this.pendingPlayerTurn.actionCount) : queued
      const remaining = queued.slice(candidates.length)
      const messageIds = new Set(queued.flatMap((entry) => entry.messageId ? [entry.messageId] : []))
      const legacyCount = queued.length - messageIds.size
      // Echoes and the previous Keeper reply can interleave while a turn is running.
      // Remove these exact player echoes from history before adding the merged action.
      const history = this.messages.slice(0, Math.max(0, this.messages.length - legacyCount))
        .filter((message) => !messageIds.has(message.id))
      if (this.workerLease && this.transcript) {
        const lookback = roomConversationLookback(history, this.contextBudgetChars)
        if (lookback) {
          const older = await roomStorage.readArchivedTurnHistory(
            this.roomId, this.transcript.before, messageIds, Math.max(0, legacyCount - this.messages.length), lookback,
          )
          history.unshift(...older)
        }
      }
      const dispatch = (batch: PendingTurnMessage[], checkpoint?: PlayerTurnCheckpoint) => {
        this.turnBuffer = remaining
        this.activeTurnBatch = batch
        this.pendingPlayerTurn = checkpoint
        return { batch, history }
      }
      // Standalone RoomService instances used with the in-memory buffer have no persisted membership.
      if (getRoom(this.roomId) !== this && !queued.some((entry) => entry.actionId)) return dispatch(queued)

      const members = new Map((await roomStorage.listMembers(this.roomId)).map((member) => [member.user_id, member]))
      const batch: PendingTurnMessage[] = []
      const cancelled: roomStorage.RoomActionWrite[] = []
      let batchChanged = false
      for (const entry of candidates) {
        const member = members.get(entry.authorUserId)
        if (!member || member.character_id !== entry.characterId) batchChanged = true
        if (member) {
          batch.push({ ...entry, characterId: member.character_id })
        } else if (entry.actionId) {
          cancelled.push({ userId: entry.authorUserId, actionId: entry.actionId, status: 'cancelled' })
        }
      }
      if (this.workerLease || batch.length < candidates.length) {
        const previousTurn = this.pendingPlayerTurn
        const checkpoint = this.workerLease && batch.length > 0
          ? { id: (batchChanged ? undefined : previousTurn?.id) ?? crypto.randomUUID(), actionCount: batch.length }
          : undefined
        const snapshot = this.snapshot()
        snapshot.pendingTurnMessages = [...batch, ...remaining]
        snapshot.pendingPlayerTurn = checkpoint
        // Retire the old identity with its complete original action set.
        // Survivors with fresh membership or bindings belong to a new turn.
        const cancelledTurn = previousTurn && batchChanged ? {
          id: previousTurn.id,
          actionKeys: candidates.flatMap((entry) => entry.actionId ? [{ userId: entry.authorUserId, actionId: entry.actionId }] : []),
          outcome: 'cancelled' as const,
          firstEventSeq: null,
          lastEventSeq: null,
        } : undefined
        await this.commitCheckpoint(snapshot, [], () => { dispatch(batch, checkpoint) }, cancelled, cancelledTurn)
        return { batch, history }
      }
      return dispatch(batch)
    })
  }

  /** 合并缓冲内玩家消息 → 一次 KP 回合（窗口超时/严格排队时调用）。 */
  async flushTurn(): Promise<void> {
    if (this.turnFlushing || this.openingInFlight || this.disposed) return
    // 结束态是终态（#54）：end_game 之后不再消费任何缓冲消息。
    if (this.isEnded()) {
      this.turnBuffer = []
      return
    }
    if (this.turnBuffer.length === 0) return

    this.turnFlushing = true
    let release: (() => void) | null = null
    let interrupted = false
    let blockedOnStory = false
    try {
      release = await acquireKpTurn(this.lifetime.signal)
      if (!release || this.disposed || this.isEnded()) return
      // Check the successor's own provider setup before consuming queued player actions.
      // When missing, keep the full batch in the persisted snapshot for an explicit retry.
      if (!(await this.refreshOwnerAiSetupStatus())) {
        // A paused room can receive more player actions while the flag is
        // already set; persist the unchanged pause state together with the new
        // queue so a restart cannot lose those actions.
        await this.persistSnapshot()
        return
      }
      const { batch, history } = await this.takePlayerTurnBatch()
      const durable = batch.some((entry) => entry.actionId)
      if (batch.length > 0 && !durable) await this.persistTurnSnapshot()
      if (this.turnTimer) {
        clearTimeout(this.turnTimer)
        this.turnTimer = null
      }
      if (batch.length === 0) return

      const turnOwnerId = this.ownerId
      const turnStoryOwnerId = this.storyOwnerId ?? turnOwnerId
      const turnOwnershipVersion = this.ownershipVersion
      const checkMembership = durable || getRoom(this.roomId) === this
      const canRunTurn = () => !this.disposed && !this.isEnded() && this.ownershipVersion === turnOwnershipVersion &&
        (!checkMembership || batch.every((entry) => this.members.some((member) =>
          member.userId === entry.authorUserId && member.characterId === entry.characterId,
        )))
      const merged = batch.map((b) => `【${b.username}】${b.content}`).join('\n')
      const activeCharacterId = batch[batch.length - 1]?.characterId ?? null
      const allowedCharacterIds = new Set(batch.map((b) => b.characterId).filter((id): id is string => !!id))
      const preparedStory = await this.loadTurnStory()
      const { assembleTurnKnowledge } = await import('./turnKnowledge.js')
      const knowledge = await assembleTurnKnowledge({
        workflow: this.workflow,
        ownerId: turnOwnerId,
        storyOwnerId: turnStoryOwnerId,
        storyId: this.storyId,
        ...(preparedStory ? { preparedStory } : {}),
        roomId: this.roomId,
        scene: this.scene,
        playerText: merged,
        stage: 'turn',
      })
      // Wait for any concurrent room governance command before invoking the Keeper.
      if (!await withRoomCommand(this.roomId, async () => canRunTurn() && await this.renewWorkerLease())) return
      const chatMessages = buildRoomTurnMessages(
        this.promptInput(knowledge.storyName, history),
        knowledge.ragContext,
        merged,
        {
          workflow: this.workflow,
          sceneBlock: knowledge.sceneBlock,
          verifyBlock: knowledge.verifyBlock,
          supplement: knowledge.supplement,
          contextBudgetChars: this.contextBudgetChars,
        },
      )
      await this.runKpTurnForRoom(
        turnOwnerId,
        chatMessages,
        this.buildStoryContext(knowledge.terminalEndings),
        activeCharacterId,
        (chunk) => this.emitKpChunk(chunk),
        allowedCharacterIds,
        knowledge.wireInjectionText,
        canRunTurn,
        undefined,
        preparedStory,
      )
      if (!durable && !SHARED_ROOMS_ENABLED && !this.disposed) {
        if (canRunTurn() || this.isEnded()) this.activeTurnBatch = []
        await this.persistTurnSnapshot()
      }
    } catch (error) {
      interrupted = true
      blockedOnStory = error instanceof RoomStoryUnavailableError
      throw error
    } finally {
      release?.()
      this.turnFlushing = false
      if (!this.disposed && this.activeTurnBatch.length > 0) {
        this.turnBuffer = [...this.activeTurnBatch, ...this.turnBuffer]
        this.activeTurnBatch = []
        void this.persistSnapshot().catch((error) => logger.warn('room interrupted turn recovery persistence failed', { roomId: this.roomId, error: String(error) }))
      }
      if (this.disposed || this.isEnded()) {
        this.turnBuffer = []
      } else if (!blockedOnStory && !this.kpSetupRequired && this.turnBuffer.length > 0) {
        // Messages arriving while a healthy turn is running are flushed next.
        if (!interrupted && this.turnWindowMs <= 0) {
          this.startBufferedTurn()
        } else {
          if (this.turnTimer) clearTimeout(this.turnTimer)
          this.turnTimer = setTimeout(() => {
            this.turnTimer = null
            this.startBufferedTurn()
          }, interrupted ? Math.max(this.turnWindowMs, 1_000) : this.turnWindowMs)
          this.turnTimer.unref?.()
        }
      }
    }
  }

  /** 清理回合窗口状态（房间回收时）。 */
  private clearTurnWindow(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.turnBuffer = []
  }

  private async loadTurnStory(): Promise<RoomStoryBundle | undefined> {
    if (!this.storyRevision && !SHARED_ROOM_CATALOG_ENABLED) return
    if (!this.storyRevision || !this.storyId || this.storyOwnerId === null) throw new RoomStoryUnavailableError()
    try {
      const { loadRoomStory } = await import('./roomStoryRevision.js')
      return await loadRoomStory(this.storyOwnerId, this.storyId, this.storyRevision, this.lifetime.signal)
    } catch (cause) {
      throw new RoomStoryUnavailableError({ cause })
    }
  }

  /**
   * 房间故事上下文唯一构造点（#77 收编 flushTurn / runOpeningTurn 的重复字面量）：
   * 未绑定剧本（storyId 为空）传 null，KP 图据此跳过脚本门控。
   */
  private buildStoryContext(terminalEndings: RoomStoryContext['terminalEndings'] = []): RoomStoryContext | null {
    return this.storyId
      ? {
          scriptId: this.storyId,
          storyOwnerId: this.storyOwnerId ?? this.ownerId,
          sceneId: this.scene ?? undefined,
          openClues: this.clues.map((clue) => clue.id),
          workflow: this.workflow,
          terminalEndings,
        }
      : null
  }

  /**
   * KP 回复流式增量帧（实验 KP_CHUNK_STREAM=1，TTFT 测量；客户端未消费，
   * 整段 message_appended 仍为准）。flushTurn / runOpeningTurn 的 onChunk 回调共用。
   */
  private emitKpChunk(chunk: string): void {
    if (isKpChunkStreamEnabled() && chunk) this.emit({ type: 'kp_chunk', payload: { content: chunk } })
  }

  /**
   * 房间内 KP 回合（Phase B6 + D4/D5）：复用 kpTurnService 的服务端图内工具循环。
   * - characters = 房间角色组（多人多卡）；activeCharacterId = 缺省行动者
   * - 工具执行的世界增量（线索/场景/结局）直接应用到房间状态并广播
   * - KP 回复追加消息流（message_appended）
   * - 角色卡变更 → state_patch 广播（所有成员实时可见）
   * - mutators 按 characterId 分派（D5）：工具 args.characterId → 对应角色卡
   * - 生产调用方仅 flushTurn / runOpeningTurn 两条回合入口；公开性保留给测试直调
   *   （roomTurnWindow D5 用例），收 private 会断测试可达性（#73 评估）。
   */
  async runKpTurnForRoom(
    ownerUserId: number,
    messages: unknown[],
    storyContext: RoomStoryContext | null,
    activeCharacterId: string | null,
    onChunk: (chunk: string) => void,
    allowedCharacterIds?: Set<string>,
    /** 当轮 RAG 注入原文（wire 采样 T1；缺省 = 无注入）。 */
    ragContext = '',
    /** Suppress subsequent graph calls and tool effects if governance changes mid-turn. */
    isOwnerCurrent: () => boolean = () => true,
    onOwnerChanged?: () => void,
    preparedStory?: RoomStoryBundle,
  ): Promise<void> {
    const { runKpTurn } = await import('./kpTurnService.js')
    // dossier 查证工具执行器随回合知识一并收编在 TurnKnowledge（活值读取器传入——
    // 工具在回合执行中才被调用，场景切换/房主转让可能发生在同回合内）。
    const { buildStoryLookup } = await import('./turnKnowledge.js')
    const preparedScript = preparedStory
      ? (await import('../rag/dossier/schema.js')).toScriptContext(preparedStory.dossier)
      : undefined
    if (preparedStory && !preparedScript) throw new RoomStoryUnavailableError()
    const characterMap = this.getCharacterMap()
    const batch = this.activeTurnBatch
    const checkpointOpening = this.openingInFlight && getRoom(this.roomId) === this
    const draft = SHARED_ROOMS_ENABLED || checkpointOpening || batch.some((entry) => entry.actionId) ? {
      characters: structuredClone(characterMap),
      changedCharacters: new Set<string>(),
      clues: [...this.clues],
      scene: this.scene,
      ending: null as CharacterEnding | null,
      events: [] as RoomEvent[],
      content: '',
      ownerChanged: false,
      failed: false,
    } : null

    const stage = (event: RoomEvent) => {
      if (draft) draft.events.push(event)
      else this.emit(event)
    }
    const append = (message: Message, roleName: string) => {
      const author = { userId: ownerUserId, roleName }
      if (draft) stage({ type: 'message_appended', payload: { message, author } })
      else this.appendMessage(message, author)
    }
    const mutatorFactory = createCharacterMutatorFactory({
      resolveSheet: (id) => (id ? (draft ? draft.characters[id] : this.characters.get(id)) : null) ?? null,
      onSheetMutated: (id, sheet) => {
        if (!id) return
        draft?.changedCharacters.add(id)
        stage({ type: 'state_patch', payload: { path: `characters.${id}`, value: draft ? structuredClone(sheet) : sheet } })
      },
      transitionToScene: (sceneName) => {
        if (!draft) {
          this.setScene(sceneName)
          return
        }
        draft.scene = sceneName
        stage({ type: 'state_patch', payload: { path: 'scene', value: sceneName } })
      },
      addClue: (description, clueId) => {
        if (!draft) {
          this.addClue(description, clueId)
          return
        }
        if (draft.clues.some((clue) => clue.id === clueId || clue.description === description)) return
        draft.clues = [...draft.clues, { id: clueId ?? `clue_${crypto.randomUUID()}`, description }]
        stage({ type: 'state_patch', payload: { path: 'clues', value: draft.clues } })
      },
      endGame: (ending) => {
        if (!draft) {
          void this.setEnding(ending)
          return
        }
        draft.ending = ending
        stage({ type: 'state_patch', payload: { path: 'ending', value: ending } })
      },
    })

    await runKpTurn(
      ownerUserId,
      { messages, storyContext },
      {
        characters: draft?.characters ?? characterMap,
        ...(preparedScript ? { preparedScript } : {}),
        activeCharacterId,
        mutatorFactory,
        allowedCharacterIds, // D5：归属校验（窗口内行动者可用的角色卡集）
        isOwnerCurrent,
        onOwnerChanged: () => {
          if (draft) draft.ownerChanged = true
          onOwnerChanged?.()
        },
        sampling: { roomId: this.roomId, storyId: this.storyId, ragContext }, // T1 wire 采样（唯一新缝）
        storyLookup: buildStoryLookup({ // dossier workflow 查证工具（rag = undefined）
          roomId: this.roomId,
          getWorkflow: () => this.workflow,
          getOwnerId: () => this.ownerId,
          getStoryOwnerId: () => this.storyOwnerId ?? this.ownerId,
          getStoryId: () => this.storyId,
          getScene: () => draft ? draft.scene : this.scene,
          ...(preparedStory ? { preparedStory } : {}),
        }),
        handlers: {
          onChunk: draft ? (chunk) => {
            if (isKpChunkStreamEnabled() && chunk) stage({ type: 'kp_chunk', payload: { content: chunk } })
          } : onChunk,
          onEnd: (result) => {
            // KP 回复追加消息流
            if (result.content?.trim()) {
              append(
                { id: `kp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'kp', content: result.content },
                'KP',
              )
              // 回合后记忆编排（fire-and-forget，ADR-0002 上下文收口）
              if (draft) draft.content = result.content
              else void this.rememberTurn(result.content)
            }
            // 工具展示消息（骰子/系统提示）追加消息流
            for (const dm of result.displayMessages ?? []) {
              append(dm as Message, 'KP')
            }
          },
          onError: () => {
            if (draft) draft.failed = true
            // 回合失败可见化：系统消息进流（同时供客户端清除「KP 推进中」占位）
            append(
              { id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'system', content: 'KP 回合失败，请稍后重试。' },
              'system',
            )
          },
        },
      },
    )
    if (!draft || draft.ownerChanged) return

    const committed = await withRoomCommand(this.roomId, async () => {
      if (this.disposed || !isOwnerCurrent()) return false
      const snapshot = this.snapshot()
      const sceneChanged = draft.scene !== snapshot.scene
      const ended = draft.ending !== null
      const events = draft.events.flatMap((event): RoomEvent[] => {
        if (event.type === 'state_patch' && event.payload.path === 'ending') {
          return [event, { type: 'room_meta', payload: {
            phase: 'ended', turnWindowMs: snapshot.turnWindowMs, members: this.members,
          } }]
        }
        return [event]
      })
      snapshot.phase = ended ? 'ended' : snapshot.phase
      snapshot.ending = ended ? draft.ending : snapshot.ending
      snapshot.scene = draft.scene
      snapshot.clues = draft.clues
      for (const id of draft.changedCharacters) snapshot.characters[id] = draft.characters[id]!
      snapshot.messages = [...snapshot.messages, ...events.flatMap((event) =>
        event.type === 'message_appended' ? [event.payload.message] : [],
      )]
      snapshot.pendingTurnMessages = ended ? [] : [...this.turnBuffer]
      snapshot.pendingPlayerTurn = undefined
      const retryableOpeningFailure = checkpointOpening && draft.failed && !draft.content &&
        !draft.events.some((event) => event.type === 'state_patch')
      if (this.workerLease && checkpointOpening) snapshot.openingCheckpointed = !retryableOpeningFailure
      const checkpointMemory = draft.content
        ? this.appendFallbackTurnMemory(draft.content)
        : this.kpMemory
      snapshot.kpMemory = checkpointMemory
      const actionUpdates: roomStorage.RoomActionWrite[] = []
      for (const entry of batch) {
        if (entry.actionId) actionUpdates.push({ userId: entry.authorUserId, actionId: entry.actionId, status: 'completed' })
      }
      if (ended) {
        for (const entry of this.turnBuffer) {
          if (entry.actionId) actionUpdates.push({ userId: entry.authorUserId, actionId: entry.actionId, status: 'cancelled' })
        }
      }

      const turnId = retryableOpeningFailure
        ? 'opening-failed:' + crypto.randomUUID()
        : checkpointOpening ? 'opening' : this.pendingPlayerTurn?.id
      const turn = this.workerLease && turnId ? {
        id: turnId,
        actionKeys: batch.flatMap((entry) => entry.actionId ? [{ userId: entry.authorUserId, actionId: entry.actionId }] : []),
        outcome: draft.failed ? 'failed' as const : 'completed' as const,
        firstEventSeq: events.length ? this.seq + 1 : null,
        lastEventSeq: events.length ? this.seq + events.length : null,
      } : undefined
      await this.commitCheckpoint(snapshot, events, () => {
        this.phase = snapshot.phase
        this.ending = snapshot.ending
        this.scene = snapshot.scene
        this.clues = snapshot.clues
        this.characters = new Map(Object.entries(snapshot.characters))
        this.messages = snapshot.messages
        this.activeTurnBatch = []
        this.pendingPlayerTurn = undefined
        this.openingCheckpointed = snapshot.openingCheckpointed === true
        this.kpMemory = checkpointMemory
        if (ended) this.clearTurnWindow()
      }, actionUpdates, turn)
      if (draft.content) {
        this.recordCompletedTurn()
        void this.refineSharedTurnMemory(ownerUserId, draft.content, checkpointMemory)
      }
      if (sceneChanged) void this.refreshLongTermSummary()
      return true
    })
    if (!committed) onOwnerChanged?.()

  }

  /* ═══════════════ 回合记忆与提示词投影（ADR-0002，服务端收口） ═══════════════ */

  /** 房间提示词输入（运行态只读投影；historyMessages 由调用方切片）。 */
  private promptInput(storyName: string, historyMessages: Message[]): RoomPromptInput {
    return {
      storyName,
      scene: this.scene,
      clues: [...this.clues],
      messages: historyMessages,
      kpMemory: this.kpMemory,
      longTermSummary: this.longTermSummary,
      characters: [...this.characters.values()],
    }
  }

  /** 回合后记忆：先落截断兜底条目，抽取成功后替换；上限 MAX_MEMORY_ENTRIES（与旧客户端编排同语义）。 */
  private appendFallbackTurnMemory(content: string): string[] {
    return [...this.kpMemory, `${content.slice(0, 80)}…`].slice(-MAX_MEMORY_ENTRIES)
  }

  private async rememberTurn(content: string): Promise<void> {
    this.kpMemory = this.appendFallbackTurnMemory(content)
    try {
      const { extractMemoryPoints } = await import('./roomMemory.js')
      const points = await extractMemoryPoints(this.ownerId, content)
      this.kpMemory = [...this.kpMemory.slice(0, -1), ...points].slice(-MAX_MEMORY_ENTRIES)
    } catch {
      // The fallback remains in memory.
    }
    this.recordCompletedTurn()
  }

  private async refineSharedTurnMemory(ownerId: number, content: string, checkpointMemory: string[]): Promise<void> {
    const ownershipVersion = this.ownershipVersion
    try {
      const { extractMemoryPoints } = await import('./roomMemory.js')
      if (this.disposed || this.ownershipVersion !== ownershipVersion) return
      const points = await extractMemoryPoints(ownerId, content)
      if (points.length === 1 && points[0] === checkpointMemory.at(-1)) return
      await withRoomCommand(this.roomId, async () => {
        // Keep the committed fallback if this result belongs to a previous
        // host or a newer turn has already added its own memory.
        if (this.disposed || this.ownershipVersion !== ownershipVersion || this.kpMemory !== checkpointMemory) return
        const snapshot = this.snapshot()
        snapshot.kpMemory = [...checkpointMemory.slice(0, -1), ...points].slice(-MAX_MEMORY_ENTRIES)
        await this.writeSnapshot(snapshot)
        this.kpMemory = snapshot.kpMemory
      })
    } catch (error) {
      logger.warn('room turn memory refinement failed', { roomId: this.roomId, error: String(error) })
    }
  }

  private recordCompletedTurn(): void {
    this.turnCount += 1
    if (this.turnCount % LONG_TERM_SUMMARY_EVERY_TURNS === 0) void this.refreshLongTermSummary()
  }

  /** 长期摘要刷新（fire-and-forget；失败保持原摘要）。 */
  private async refreshLongTermSummary(): Promise<void> {
    if (this.summarizing) {
      this.summaryRefreshPending = true
      return
    }
    this.summarizing = true
    try {
      do {
        this.summaryRefreshPending = false
        try {
          const { summarizeLongTerm } = await import('./roomMemory.js')
          const recentMessages = this.messages.slice(-20)
          const recent = recentMessages
            .filter((message) => message.role === 'kp' || message.role === 'player')
            .map((m) => `${m.role === 'kp' ? '守密人' : '调查员'}: ${String((m as { content?: unknown }).content ?? '')}`)
            .join('\n')
          const recentToolResults = recentMessages
            .filter((message) => message.role === 'system')
            .map((message) => {
              const content = String((message as { content?: unknown }).content ?? '')
              const result = (message as { result?: { skill?: string; roll?: number; target?: number; outcome?: string } }).result
              const facts = [
                result?.skill,
                typeof result?.roll === 'number' ? `骰值=${result.roll}` : undefined,
                typeof result?.target === 'number' ? `目标=${result.target}` : undefined,
                result?.outcome,
              ].filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
              return [content, facts.join(' / ')].filter(Boolean).join('；')
            })
            .filter(Boolean)
            .join('\n')
          const summary = await summarizeLongTerm(this.ownerId, {
            recentMessagesText: recent.slice(-ROOM_SUMMARY_SOURCE_MAX_CHARS),
            recentToolResultsText: recentToolResults.slice(-ROOM_SUMMARY_SOURCE_MAX_CHARS),
            currentSummary: this.longTermSummary,
            storyContextText: [
              `当前场景：${this.scene ?? '未知'}`,
              `已获线索：${this.clues.map((clue) => clue.description).join('、') || '无'}`,
            ].join('；'),
          })
          if (summary && summary !== this.longTermSummary) {
            const previousSummary = this.longTermSummary
            this.longTermSummary = summary
            try {
              // Keep the previous summary in memory if durable storage fails. The
              // original transcript remains intact, so a later checkpoint can retry.
              await this.persistSnapshot()
            } catch (error) {
              this.longTermSummary = previousSummary
              logger.warn('room long-term summary persistence failed', { roomId: this.roomId, error: String(error) })
            }
          }
        } catch {
          // Summary failures are isolated from player turns and keep the old value.
        }
      } while (this.summaryRefreshPending)
    } finally {
      this.summarizing = false
    }
  }

  private async refreshOwnerAiSetupStatus(): Promise<boolean> {
    const ownerId = this.ownerId
    let issue: string | null = null
    // The deterministic mock deliberately bypasses provider settings.
    if (!isMockAiMode()) {
      try {
        const settings = await import('./settingsService.js')
        issue = SHARED_ROOMS_ENABLED ? await settings.getSharedAiSetupIssue(ownerId) : settings.getAiSetupIssue(ownerId)
      } catch (error) {
        logger.warn('room owner AI setup check failed', { roomId: this.roomId, ownerId, error: String(error) })
        issue = '无法读取当前房主的 AI 设置，请检查设置后重试。'
      }
    }
    if (SHARED_ROOMS_ENABLED) {
      const applied = await withRoomCommand(this.roomId, async () => {
        if (this.disposed) return true
        if (this.ownerId !== ownerId) return false
        await this.setKpSetupRequired(issue)
        return true
      })
      if (!applied) return this.refreshOwnerAiSetupStatus()
    } else {
      if (this.ownerId !== ownerId) return this.refreshOwnerAiSetupStatus()
      await this.setKpSetupRequired(issue)
    }
    return issue === null
  }

  private async setKpSetupRequired(issue: string | null): Promise<void> {
    const required = issue !== null
    if (this.kpSetupRequired === required) return
    const patch: RoomEvent = { type: 'state_patch', payload: { path: 'kpSetupRequired', value: required } }
    const message: Message | null = issue === null ? null : {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      role: 'system',
      content: `KP 已暂停：${issue} 待处理的玩家行动已保留。配置后请房主点击“重试 KP”。`,
    }
    const author = { userId: this.ownerId, roleName: 'system' }
    if (SHARED_ROOMS_ENABLED) {
      const snapshot = this.snapshot()
      const events: RoomEvent[] = [patch]
      snapshot.kpSetupRequired = required
      if (message) {
        snapshot.messages = [...snapshot.messages, message]
        events.push({ type: 'message_appended', payload: { message, author } })
      }
      await this.commitCheckpoint(snapshot, events, () => {
        this.kpSetupRequired = required
        this.messages = snapshot.messages
      })
      return
    }
    this.kpSetupRequired = required
    this.emit(patch)
    if (message) this.appendMessage(message, author)
    void this.persistSnapshot().catch((error) => {
      logger.warn('room AI setup status persistence failed', { roomId: this.roomId, ownerId: this.ownerId, error: String(error) })
    })
  }

  /** Current owner can resume the preserved opening or queued player actions after setup. */
  async retryKpTurn(userId: number): Promise<boolean> {
    if (!await roomStorage.isRoomMember(this.roomId, userId) || userId !== this.ownerId || this.phase !== 'playing') return false
    if (!(await this.refreshOwnerAiSetupStatus())) return true
    if (this.turnBuffer.length > 0) {
      this.startBufferedTurn()
      return true
    }
    const hasNarrative = this.hasNarrative || this.messages.some(isNarrative)
    if (!hasNarrative && !this.openingStarted) this.beginOpeningIfPending()
    return true
  }

  /** opening（ADR-0002）：startRoom / 首次 join 时触发一次，失败不阻塞进入。 */
  beginOpeningIfPending(): void {
    if (this.disposed || this.openingStarted || this.openingCheckpointed || this.openingInFlight || this.turnFlushing || this.phase !== 'playing' ||
        this.hasNarrative || this.messages.some(isNarrative)) return
    this.openingStarted = true
    this.openingInFlight = true
    void this.runOpeningTurn()
  }

  /**
   * opening 回合真实执行：串行入队（与后续 flushTurn 共享队列，避免与玩家
   * 首条消息并发跑两个回合）。失败不阻塞进入——首回合不是门闩，玩家消息
   * 照常触发回合（flushTurn 路径独立）。快照恢复时角色组（characters map）
   * 由 getOrCreateRoom 的 syncFromDb 装载后才会调用本方法（懒激活顺序保证）。
   */
  private async runOpeningTurn(): Promise<void> {
    let release: (() => void) | null = null
    let retryOpening = false
    try {
      release = await acquireKpTurn(this.lifetime.signal)
      if (!release || this.disposed || this.phase !== 'playing') return
      const turnOwnershipVersion = this.ownershipVersion
      if (!(await this.refreshOwnerAiSetupStatus())) {
        this.openingStarted = false
        return
      }
      if (this.ownershipVersion !== turnOwnershipVersion) {
        this.openingStarted = false
        retryOpening = true
        return
      }
      const turnOwnerId = this.ownerId
      // 回合知识装配唯一入口（TurnKnowledge）：stage:'opening' = 无玩家文本——
      // rag query 退化为开场固定 query、补充层 query 退化为纯场景名（T4 契约）、不触发预取。
      const preparedStory = await this.loadTurnStory()
      const { assembleTurnKnowledge } = await import('./turnKnowledge.js')
      const knowledge = await assembleTurnKnowledge({
        workflow: this.workflow,
        ownerId: turnOwnerId,
        storyOwnerId: this.storyOwnerId ?? this.ownerId,
        storyId: this.storyId,
        ...(preparedStory ? { preparedStory } : {}),
        roomId: this.roomId,
        scene: this.scene,
        playerText: '',
        stage: 'opening',
      })
      if (this.ownershipVersion !== turnOwnershipVersion) {
        this.openingStarted = false
        retryOpening = true
        return
      }
      if (!await this.renewWorkerLease()) return
      const chatMessages = buildRoomOpeningMessages(this.promptInput(knowledge.storyName, this.messages), knowledge.ragContext, {
        workflow: this.workflow,
        sceneBlock: knowledge.sceneBlock,
        supplement: knowledge.supplement,
      })
      const firstCharacterId = [...this.characters.keys()][0] ?? null
      await this.enqueue(() =>
        this.runKpTurnForRoom(
          turnOwnerId,
          chatMessages,
          this.buildStoryContext(knowledge.terminalEndings),
          firstCharacterId,
          (chunk) => this.emitKpChunk(chunk),
          undefined,
          // wire 采样注入列：与 flushTurn 同口径（单源在 TurnKnowledge）
          knowledge.wireInjectionText,
          () => !this.disposed && !this.isEnded() && this.ownershipVersion === turnOwnershipVersion,
          () => {
            this.openingStarted = false
            retryOpening = !this.disposed
          },
          preparedStory,
        ),
      )
    } catch (err) {
      // A staged opening whose checkpoint failed has not been published.
      // Leave it eligible for the next explicit retry or join.
      if (SHARED_ROOMS_ENABLED || getRoom(this.roomId) === this) this.openingStarted = false
      // opening 失败不阻塞（ADR-0002）——保留可见日志（此前全吞难排查）
      logger.warn('room opening turn failed', { roomId: this.roomId, ownerId: this.ownerId, error: err instanceof Error ? err.message : String(err) })
    } finally {
      release?.()
      this.openingInFlight = false
      if (this.turnBuffer.length > 0 && !this.kpSetupRequired && !this.turnTimer) {
        this.startBufferedTurn()
      } else if (retryOpening) {
        this.beginOpeningIfPending()
      }
    }
  }

  /* ═══════════════ 快照 / 回收 ═══════════════ */

  private async maybeSnapshot(): Promise<void> {
    const events = this.seq - this.persistedSeq
    if (events > 0 && (events >= SNAPSHOT_EVERY_N_EVENTS || Date.now() - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS)) {
      await this.persistSnapshot()
    }
  }

  /** 落库快照（rooms.state）。 */
  async persistSnapshot(): Promise<void> {
    await withRoomCommand(this.roomId, () => this.writeSnapshot())
  }

  /** Persist a complete transition before making it visible to clients. Requires the room command slot. */
  private async commitCheckpoint(
    snapshot: RoomSnapshot, events: RoomEvent[], install: () => void, actions: readonly roomStorage.RoomActionWrite[] = [],
    turn?: roomStorage.RoomCheckpoint['turn'],
  ): Promise<void> {
    snapshot.seq = this.seq + events.length
    const stagedEvents = events.map((event, index) => ({ seq: this.seq + index + 1, event }))
    if (!await this.writeSnapshot(snapshot, actions, stagedEvents, turn)) {
      throw new Error('Room was disposed before its checkpoint could commit')
    }
    install()
    for (const event of events) this.emit(event)
  }

  async writeSnapshot(
    snapshot = this.snapshot(), actions: readonly roomStorage.RoomActionWrite[] = [],
    stagedEvents: { seq: number; event: RoomEvent }[] = [], turn?: roomStorage.RoomCheckpoint['turn'],
  ): Promise<boolean> {
    if (this.disposed) return false
    if (this.workerLease) boundTranscript(snapshot)
    const checkpoint = this.workerLease ? {
      seq: snapshot.seq,
      turnPending: snapshotHasRecoverableTurn(snapshot),
      lease: this.workerLease,
      events: [...this.eventLog.filter(({ seq }) => seq > this.persistedSeq), ...stagedEvents]
        .map(({ seq, event }) => ({ seq, type: event.type, payload: event.payload })),
      turn,
    } : undefined
    try {
      await roomStorage.updateRoomStateSnapshot(
        this.roomId, serializeRoomState(snapshot), snapshot.phase === 'ended' ? 'ended' : undefined, actions, checkpoint,
      )
    } catch (error) {
      // A failed COMMIT response can still mean PostgreSQL committed. Discard
      // the local state before replay so it reloads receipts and the turn result.
      if (this.workerLease) this.retireWorker()
      throw error
    }
    this.persistedSeq = Math.max(this.persistedSeq, snapshot.seq)
    this.lastSnapshotAt = Date.now()
    if (this.workerLease) {
      this.transcript = snapshot.transcript
      this.hasNarrative = snapshot.hasNarrative === true
    }
    return true
  }

  private async persistTurnSnapshot(): Promise<void> {
    if (SHARED_ROOMS_ENABLED) {
      await this.persistSnapshot()
      return
    }
    const seq = await roomStorage.queueTurnSnapshot(this.roomId, () => ({
      seq: this.seq,
      stateJson: serializeRoomState(this.snapshot()),
    }))
    this.persistedSeq = Math.max(this.persistedSeq, seq)
    this.lastSnapshotAt = Date.now()
  }

  /** 停止定时器（房间回收时调用）。 */
  dispose(): void {
    this.lifetime.abort()
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshotTimer = null
    if (this.leaseTimer) clearInterval(this.leaseTimer)
    this.leaseTimer = null
    this.clearTurnWindow()
    this.listeners.clear()
  }
}

/* ═══════════════ 房间注册表（进程内单例） ═══════════════ */

const roomRegistry = new Map<string, RoomService>()
const roomsActivating = new Set<string>()
const roomCommands = new Map<string | symbol, Promise<unknown>>()
const roomCreationSlot = Symbol('room creation')

/** Hold the same room's command slot across database I/O without blocking other rooms. */
function withRoomCommand<T>(
  roomId: string | symbol, command: (workerLease?: roomStorage.RoomWorkerLease) => Promise<T>,
): Promise<T> {
  const previous = roomCommands.get(roomId)
  const run = async () => {
    try { await previous } catch { /* failures do not block later commands */ }
    return command(typeof roomId === 'string' ? getRoom(roomId)?.workerLease : undefined)
  }
  const next = run().finally(() => {
    if (roomCommands.get(roomId) === next) roomCommands.delete(roomId)
  })
  roomCommands.set(roomId, next)
  return next
}

/** A dormant room uses an exclusive temporary lease without materializing it. */
function withRoomMutation<T>(
  roomId: string, command: (workerLease?: roomStorage.RoomWorkerLease) => Promise<T>,
): Promise<T> {
  return withRoomCommand(roomId, async (workerLease) => {
    if (!ROOM_WORKER_FAILOVER_ENABLED || workerLease) return command(workerLease)
    const temporaryLease = await roomStorage.claimRoomLease(roomId)
    if (!temporaryLease) {
      if (!await roomStorage.getRoomRow(roomId)) return command()
      throw new roomStorage.RoomWorkerBusyError()
    }
    let renewing = false
    const heartbeat = setInterval(() => {
      if (renewing) return
      renewing = true
      void roomStorage.renewRoomLease(roomId, temporaryLease).then((live) => {
        if (!live) clearInterval(heartbeat)
      }).catch((error) => {
        logger.warn('temporary room lease renewal failed', { roomId, error: String(error) })
      }).finally(() => { renewing = false })
    }, Math.floor(ROOM_WORKER_LEASE_MS / 3))
    heartbeat.unref?.()
    try {
      return await command(temporaryLease)
    } finally {
      clearInterval(heartbeat)
      await roomStorage.releaseRoomLease(roomId, temporaryLease).catch((error) => {
        logger.warn('temporary room lease release failed', { roomId, error: String(error) })
      })
    }
  })
}

export function hasRoomCapacity(roomId: string): boolean {
  const configured = Number(process.env.ROOM_ACTIVE_INSTANCES ?? 1024)
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 1024
  return roomRegistry.has(roomId) || roomsActivating.has(roomId) || roomRegistry.size + roomsActivating.size < limit
}

/** 获取或创建房间（owner 建房）。 */
export function getOrCreateRoom(
  roomId: string, ownerId: number, ownerName: string, storyId?: string | null,
): Promise<RoomService> {
  return withRoomCommand(roomId, () => materializeRoom(roomId, ownerId, ownerName, storyId))
}

async function materializeRoom(
  roomId: string,
  ownerId: number,
  ownerName: string,
  storyId?: string | null,
): Promise<RoomService> {
  let room = roomRegistry.get(roomId)
  if (!room) {
    const workerLease = ROOM_WORKER_FAILOVER_ENABLED ? await roomStorage.claimRoomLease(roomId) : undefined
    if (ROOM_WORKER_FAILOVER_ENABLED && !workerLease) throw new roomStorage.RoomWorkerBusyError()
    // DB 权威：列（story_id/phase）优先于 state 快照（审查修复 #1：
    // REST start 只更新列，实例 restore 必须拿到最新 storyId/phase）
    const r = await roomStorage.getRoomRow(roomId)
    let restore: RoomSnapshot | null = null
    if (r?.state) restore = parseRoomState<RoomSnapshot>(r.state)
    if (restore) {
      // 列是权威：覆盖快照中的过期值
      if (typeof r?.story_id === 'string') restore.storyId = r.story_id
      if (r?.phase === 'lobby' || r?.phase === 'playing' || r?.phase === 'ended') restore.phase = r.phase
      // 旧数据自愈（#54）：修复前 end_game 只改内存不写列，库里留下的坏行是
      // 「列=playing + 快照 ending!=null」。ending 只有 setEnding 写、没有取消路径，
      // 故它非空即可反推 ended——否则这些房间重启后仍被复活成进行中。
      if (restore.ending != null && restore.phase === 'playing') {
        restore.phase = 'ended'
        try { await roomStorage.updateRoomPhase(roomId, 'ended', workerLease) } catch { /* 自愈失败不阻断物化 */ }
      }
    } else if (r) {
      restore = {
        seq: 0,
        phase: (r.phase === 'lobby' || r.phase === 'playing' || r.phase === 'ended') ? r.phase : 'lobby',
        storyId: typeof r.story_id === 'string' ? r.story_id : null,
        messages: [],
        characters: {},
        clues: [],
        scene: null,
        ending: null,
        turnWindowMs: DEFAULT_TURN_WINDOW_MS,
        updatedAt: Date.now(),
      }
    }
    if (workerLease && r && !r.transcript_archived && restore) {
      const legacyMessages = Array.isArray(restore.messages) ? restore.messages : []
      restore.messages = legacyMessages
      boundTranscript(restore)
      try {
        await roomStorage.archiveRoomTranscript(
          roomId, workerLease, legacyMessages, serializeRoomState(restore), restore.seq ?? 0, snapshotHasRecoverableTurn(restore),
        )
      } catch (error) {
        await roomStorage.releaseRoomLease(roomId, workerLease).catch(() => {})
        throw error
      }
    }
    room = new RoomService({ roomId, ownerId: r?.owner_id ?? ownerId, ownerName: (r ? await roomStorage.usernameOf(r.owner_id) : null) ?? ownerName, storyId: typeof r?.story_id === 'string' ? r.story_id : storyId, storyOwnerId: r?.story_owner_id ?? (typeof r?.story_id === 'string' ? r.owner_id : null), restore, workerLease })
    // 对账（ADR-0001）：物化即列优先同步——列（story_id/phase）已入 restore，
    // 绑定角色组从 DB 装载（createSoloRoom 先绑后 join、TTL 回收重进都依赖此步）。
    try { await room.syncFromDb() } catch (error) {
      room.dispose()
      if (workerLease) await roomStorage.releaseRoomLease(roomId, workerLease).catch(() => {})
      throw error
    }
    roomRegistry.set(roomId, room)
  }
  return room
}

/** 获取房间（不存在返回 null）。 */
export function getRoom(roomId: string): RoomService | null {
  return roomRegistry.get(roomId) ?? null
}

/** Remove a deleted room from the in-memory registry and stop its timers/listeners. */
function disposeDeletedRoom(roomId: string): void {
  const room = roomRegistry.get(roomId)
  if (!room) return
  room.dispose()
  roomRegistry.delete(roomId)
}

/* ═══════════════ 领域入口（ADR-0001：REST/ws 的唯一通道，房间 SQL 不出 roomStorage） ═══════════════ */

/** 6 位随机邀请码（字母数字，去易混字符）。 */
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i]! % chars.length]
  }
  return code
}

async function ensureUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateInviteCode()
    if (!await roomStorage.inviteCodeExists(code)) return code
  }
  throw new Error('failed to generate unique invite code')
}

/** 若房间有活跃实例：DB 权威状态同步 + 成员广播（REST 写路径的领域内对账）。 */
async function syncActiveRoom(roomId: string): Promise<void> {
  const room = getRoom(roomId)
  if (!room) return
  await room.syncFromDb()
  await broadcastMemberMeta(roomId)
}

/** 广播 DB 权威成员列表（成员加入/绑定后）。 */
async function broadcastMemberMeta(roomId: string): Promise<void> {
  const room = getRoom(roomId)
  if (!room) return
  await room.broadcastMembers(
    (await roomStorage.listMembers(roomId)).map(memberRowToInfo),
  )
}

/** room_members 行 → wire 成员信息（ready 列 0/1 → boolean；room_meta/详情共用）。 */
function memberRowToInfo(m: roomStorage.RoomMemberRow): RoomMember {
  return {
    userId: m.user_id,
    username: m.username,
    role: m.role as MemberRole,
    characterId: m.character_id,
    ready: !!m.ready,
  }
}

/** POST /api/rooms —— 创建房间（只持久化，不激活内存实例：懒激活，ADR-0001）。 */
export function createRoom(
  userId: number,
  storyId: string | null,
  opts: { workflow?: unknown } = {},
): Promise<{ roomId: string; inviteCode: string }> {
  return withRoomCommand(roomCreationSlot, async () => {
    const roomId = `room_${crypto.randomUUID()}`
    const inviteCode = await ensureUniqueInviteCode()
    const state = serializeRoomState(sanitizeWorkflow(opts.workflow) === 'dossier' ? { workflow: 'dossier' } : {})
    await roomStorage.insertMultiplayerRoom(roomId, userId, inviteCode, storyId, state)
    return { roomId, inviteCode }
  })
}

/** GET /api/rooms —— 我的房间列表。 */
export function listRoomsForUser(userId: number): Promise<roomStorage.RoomListItemRow[]> {
  return roomStorage.listRoomsForUser(userId)
}

/** GET /api/rooms/solo —— 未结束单人局列表（游戏 hub 的 solo 续玩入口，ADR-0002）。 */
export function listSoloRoomsForUser(userId: number): Promise<roomStorage.SoloRoomListItemRow[]> {
  return roomStorage.listSoloRoomsForUser(userId)
}

/** POST /api/rooms/solo —— 单人开局一体领域动作（ADR-0002）：落角色卡 + 建 solo 房 + 绑卡 + start。
 *  可选 workflow（实验分支双轨；缺省 rag）。 */
export async function createSoloRoom(
  userId: number,
  input: { storyId: unknown; name: unknown; sheet: unknown; workflow?: unknown },
): Promise<{ ok: true; roomId: string; inviteCode: string; characterId: string } | { ok: false; reason: 'bad-request' | 'conflict'; message: string }> {
  const storyId = typeof input?.storyId === 'string' ? input.storyId.trim() : ''
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const sheet = input?.sheet as COCCharacterSheet | undefined
  const workflow = sanitizeWorkflow(input?.workflow)
  if (!storyId) return { ok: false, reason: 'bad-request', message: 'storyId required' }
  if (!name) return { ok: false, reason: 'bad-request', message: 'name required' }
  if (!sheet || typeof sheet !== 'object' || !sheet.derived) {
    return { ok: false, reason: 'bad-request', message: 'sheet required (COCCharacterSheet)' }
  }
  // 开局门闩（唯一判定落点 startGate，gateFor='solo-create'）：solo 出生即 playing、不经
  // startRoom，但仍必须通过所选 workflow 的知识 artifact 门闩，避免直接进入没有原文的局。
  // 无结束态/已选剧本/绑卡闩——房间行尚未存在，一体动作自己在下面的同一事务里绑卡。
  const gate = await checkStartGate({ gateFor: 'solo-create', storyId, ownerId: userId, workflow: input?.workflow })
  if (!gate.ok) return gate
  return withRoomCommand(roomCreationSlot, async () => {
    const characterId = `char_${crypto.randomUUID()}`
    const roomId = `room_${crypto.randomUUID()}`
    const inviteCode = await ensureUniqueInviteCode()
    const state = serializeRoomState(workflow === 'dossier' ? { turnWindowMs: 0, workflow } : { turnWindowMs: 0 })
    try {
      await roomStorage.insertSoloRoom(roomId, userId, inviteCode, storyId, state, { id: characterId, name, sheet: JSON.stringify(sheet) }, gate.pin)
    } catch (error) {
      if (!(error instanceof roomStorage.StoryRevisionChangedError)) throw error
      return { ok: false, reason: 'conflict', message: 'Prepared story changed. Select it again to start.' }
    }
    return { ok: true, roomId, inviteCode, characterId }
  })
}

export function resolveRoomInvite(inviteCode: string): Promise<string | null> {
  return roomStorage.findRoomIdByInviteCode(inviteCode)
}


/** POST /api/rooms/join —— 邀请码加入（幂等：INSERT OR IGNORE）。
 *  ADR-0005：playing 后锁房——开局后邀请码不可再加入（observer 旁观留后续）。 */
export async function joinRoomByInviteCode(
  userId: number,
  inviteCode: string,
): Promise<{ ok: true; roomId: string } | { ok: false; reason: 'not-found' | 'conflict'; message: string }> {
  const roomId = await roomStorage.findRoomIdByInviteCode(inviteCode)
  if (!roomId) return { ok: false, reason: 'not-found', message: 'room not found' }
  return withRoomMutation(roomId, async (workerLease) => {
    const room = await roomStorage.getRoomRow(roomId)
    if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
    if (room.phase !== 'lobby') {
      return { ok: false, reason: 'conflict', message: 'room already started' }
    }
    await roomStorage.insertMember(roomId, userId, 'member', workerLease)
    await broadcastMemberMeta(roomId)
    return { ok: true, roomId }
  })
}

/** GET /api/rooms/:id —— 房间详情（成员可见；非成员与不存在同样 404，语义同旧路由）。 */
export async function getRoomDetail(
  userId: number,
  roomId: string,
): Promise<{ ok: true; detail: Record<string, unknown> } | { ok: false; reason: 'not-found'; message: string }> {
  return withRoomCommand(roomId, async () => {
    if (!await roomStorage.memberRole(roomId, userId)) return { ok: false, reason: 'not-found', message: 'room not found' }
    const room = await roomStorage.getRoomRow(roomId)
    if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
    // rooms.state 经 codec 容错解析（#61）：脏 JSON → {}；成功值原样透传（含 JSON null，原语义）
    const state = parseRoomStateOr(room.state, {}) as Partial<RoomSnapshot> | null
    if (ROOM_WORKER_FAILOVER_ENABLED && !room.transcript_archived && Array.isArray(state?.messages)) {
      boundTranscript(state as RoomSnapshot)
    }
    return {
      ok: true,
      detail: {
        roomId: room.room_id,
        inviteCode: room.invite_code,
        storyId: room.story_id,
        phase: room.phase,
        ownerId: room.owner_id,
        members: (await roomStorage.listMembers(roomId)).map((m) => ({
          userId: m.user_id,
          username: m.username,
          role: m.role,
          characterId: m.character_id,
          ready: !!m.ready,
        })),
        state,
        createdAt: room.created_at,
      },
    }
  })
}

export async function getRoomHistory(
  userId: number, roomId: string, before: string | null, limit: number,
): Promise<RoomHistoryPage | undefined> {
  const newestFirst = await roomStorage.readRoomHistory(roomId, userId, before, limit + 1)
  if (!newestFirst) return undefined
  const messages = newestFirst.slice(0, limit).reverse()
  return { messages, nextBefore: newestFirst.length > limit ? messages[0]?.id ?? null : null }
}

/** POST /api/rooms/:id/start —— 房主开始游戏。开局门闩（ADR-0005）判定单源在
 *  startGate.checkStartGate（gateFor='lobby-start'：结束态终态 #54 / 已选剧本 /
 *  workflow 可用性——dossier 已生成+未降质一次 readdir、rag 已索引 / 成员绑卡），
 *  409 reason/message 与拆分前逐字节一致。本方法保留治理前置（成员资格/房主判定）
 *  与成功路径副作用时序（写库 → 活跃实例对账 → opening）。就绪是软信号，开局不等待
 *  全员就绪。 */
export async function startRoom(
  userId: number,
  roomId: string,
  storyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'not-owner' | 'conflict'; message: string }> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(userId, roomId)
    if (!g.ok) return g
    if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can start the game' }
    // 开局门闩（唯一判定落点 startGate）：入口只喂房间行摘要 + 成员行摘要 + 归属，
    // 判定（含 rooms.state workflow 解析与分派）全在门内。
    if (g.room.story_preparation_revision) {
      if (g.room.phase === 'ended' || getRoom(roomId)?.isEnded()) {
        return { ok: false, reason: 'conflict', message: 'This investigation has ended.' }
      }
      return storyId === g.room.story_id
        ? { ok: true }
        : { ok: false, reason: 'conflict', message: 'This investigation has a pinned story.' }
    }
    if (SHARED_ROOM_CATALOG_ENABLED && g.room.phase === 'playing') {
      return { ok: false, reason: 'conflict', message: 'This investigation has no verified story revision.' }
    }
    // Reuse the persisted source when the selected story is unchanged; a newly
    // selected story belongs to the current owner who selected it.
    const storyOwnerId = storyId === g.room.story_id && g.room.story_owner_id !== null
      ? g.room.story_owner_id
      : g.room.owner_id
    const gate = await checkStartGate({
      gateFor: 'lobby-start',
      storyId,
      ownerId: storyOwnerId,
      room: { phase: g.room.phase, state: g.room.state },
      members: (await roomStorage.listMembers(roomId)).map((m) => ({ characterId: m.character_id, username: m.username })),
    })
    if (!gate.ok) return gate
    if (getRoom(roomId)?.isEnded()) return { ok: false, reason: 'conflict', message: '\u5bf9\u5c40\u5df2\u7ed3\u675f\uff0c\u65e0\u6cd5\u91cd\u65b0\u5f00\u59cb' }
    try {
      await roomStorage.updateRoomStart(roomId, storyId, storyOwnerId, gate.pin, workerLease)
    } catch (error) {
      if (!(error instanceof roomStorage.StoryRevisionChangedError)) throw error
      return { ok: false, reason: 'conflict', message: 'Prepared story changed. Select it again to start.' }
    }
    await syncActiveRoom(roomId)
    // opening 回合（ADR-0002）：实例已激活则立即触发；未激活时随首次 join 触发（懒激活保持）。
    getRoom(roomId)?.beginOpeningIfPending()
    return { ok: true }
  })
}

export async function createCharacter(userId: number, name: string, sheet: COCCharacterSheet): Promise<{ id: string; name: string }> {
  const id = `char_${crypto.randomUUID()}`
  await roomStorage.insertCharacter(id, userId, name, JSON.stringify(sheet))
  return { id, name }
}

export async function listCharactersForUser(userId: number): Promise<{
  id: string; name: string; sheet: COCCharacterSheet; updatedAt: number
}[]> {
  const rows = await roomStorage.listCharactersForUser(userId)
  return rows.map((row) => {
    let sheet: COCCharacterSheet
    try {
      sheet = JSON.parse(row.sheet) as COCCharacterSheet
    } catch {
      sheet = {} as COCCharacterSheet
    }
    return { id: row.id, name: row.name, sheet, updatedAt: row.updated_at }
  })
}

/** POST /api/rooms/:id/character —— 绑定角色卡（一人一卡，Phase B4）。 */
export async function bindRoomCharacter(
  userId: number,
  roomId: string,
  characterId: string,
): Promise<{ ok: true; roomId: string; characterId: string } | { ok: false; reason: 'not-found' | 'conflict'; message: string }> {
  return withRoomMutation(roomId, async (workerLease) => {
    if (!await roomStorage.memberRole(roomId, userId)) return { ok: false, reason: 'not-found', message: 'room not found' }
    if (await roomStorage.characterOwnerUserId(characterId) !== userId) {
      return { ok: false, reason: 'not-found', message: 'character not found' }
    }
    if (await roomStorage.boundMemberOf(roomId, characterId, userId) !== null) {
      return { ok: false, reason: 'conflict', message: 'character already bound to another member' }
    }
    await roomStorage.bindMemberCharacter(roomId, userId, characterId, workerLease)
    await syncActiveRoom(roomId)
    // T4 #31：换绑后广播新绑定卡 sheet（room_meta 只带 member.characterId；
    // characters.<id> 走 state_patch——客户端档案区/队友卡依赖此通道）。
    // 定向发本卡：幂等（绑同卡重复调用也只会同步一份权威 sheet）。
    const active = getRoom(roomId)
    const sheet = active?.getCharacter(characterId) ?? null
    if (active && sheet) {
      await active.emitSheetPatch(characterId, sheet)
    }
    return { ok: true, roomId, characterId }
  })
}

/** 校验回合窗口值（0..60000），非法返回 null。 */
function sanitizeTurnWindowMs(value: unknown): number | null {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return null
  return Math.floor(ms)
}

/** PUT /api/rooms/:id/settings —— 房主改 turnWindowMs（写库 + 活跃实例立即生效并广播）。 */
export async function setRoomTurnWindow(
  userId: number,
  roomId: string,
  rawTurnWindowMs: unknown,
): Promise<{ ok: true; turnWindowMs?: number } | { ok: false; reason: 'not-found' | 'not-owner' | 'bad-request'; message: string }> {
  return withRoomMutation(roomId, async (workerLease) => {
    const room = await roomStorage.getRoomRow(roomId)
    if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
    if (room.owner_id !== userId) return { ok: false, reason: 'not-owner', message: 'only the owner can change room settings' }
    // ADR-0002：solo 房间回合窗口恒为 0（单成员无需合并缓冲），不可设置
    if (room.kind === 'solo') return { ok: false, reason: 'bad-request', message: 'solo rooms have a fixed turn window of 0' }
    // rooms.state 经 codec 容错解析（#61）：脏 JSON → {}；成功值原样（含 JSON null/原始值，
    // 后续赋值/写回按现状表现，不附加对象守卫）
    const state = parseRoomStateOr(room.state, {}) as Record<string, unknown>
    let ms: number | undefined
    if (rawTurnWindowMs !== undefined) {
      const sanitized = sanitizeTurnWindowMs(rawTurnWindowMs)
      if (sanitized === null) return { ok: false, reason: 'bad-request', message: 'turnWindowMs must be 0..60000' }
      state.turnWindowMs = sanitized
      ms = sanitized
    }
    await roomStorage.updateRoomStateSettings(roomId, serializeRoomState(state), workerLease)
    const active = getRoom(roomId)
    if (active && typeof ms === 'number') await active.setTurnWindowMs(ms)
    return { ok: true, turnWindowMs: ms }
  })
}

/** DELETE /api/rooms/:id —— 房主解散。 */
export async function deleteRoomAsOwner(
  userId: number,
  roomId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'not-owner' | 'conflict'; message: string }> {
  return withRoomMutation(roomId, async (workerLease) => {
    const room = await roomStorage.getRoomRow(roomId)
    if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
    if (room.owner_id !== userId) return { ok: false, reason: 'not-owner', message: 'only the owner can dissolve the room' }
    if (room.phase === 'playing') return { ok: false, reason: 'conflict', message: 'playing rooms cannot be dissolved' }
    await roomStorage.deleteRoomRows(roomId, workerLease)
    disposeDeletedRoom(roomId)
    return { ok: true }
  })
}

/* ═══════════════ 等待室治理（ADR-0005：就绪/离开/踢出/转让/门闩） ═══════════════ */

/** 领域失败（各治理方法共用）；路由只按 reason 映射 HTTP。 */
export interface RoomGovernanceFail {
  ok: false
  reason: 'not-found' | 'not-owner' | 'not-member' | 'conflict' | 'bad-request'
  message: string
}

/** 房间治理约束统一入口（成员资格 / 房主判定 / kind）。
 *  - 治理动作只对多人房（kind='multi'）有意义；
 *  - 房间不存在、调用者非成员、被操作者非成员 → not-found（与既有成员可见语义一致）。 */
async function governanceGate(
  userId: number,
  roomId: string,
  targetUserId?: number,
): Promise<{ ok: true; room: roomStorage.RoomRow; callerRole: string | null } | { ok: false; reason: 'not-found' | 'not-owner' | 'conflict'; message: string }> {
  const room = await roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (room.kind !== 'multi') return { ok: false, reason: 'conflict', message: 'governance actions require a multiplayer room' }
  if (targetUserId !== undefined) {
    if (!await roomStorage.memberRole(roomId, targetUserId)) return { ok: false, reason: 'not-found', message: 'member not found' }
  }
  const callerRole = await roomStorage.memberRole(roomId, userId)
  if (!callerRole) return { ok: false, reason: 'not-found', message: 'room not found' }
  return { ok: true, room, callerRole }
}

/** POST /api/rooms/:id/ready —— 成员就绪/取消（ADR-0005 软信号；owner 不持有 ready）。
 *  role='member' 的 UPDATE 天然保护 owner；重复设置幂等。就绪在开局（playing）后无意义，忽略之。 */
export async function setMemberReady(
  userId: number,
  roomId: string,
  ready: boolean,
): Promise<{ ok: true } | RoomGovernanceFail> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(userId, roomId)
    if (!g.ok) return g
    if (g.callerRole === 'owner') return { ok: false, reason: 'not-owner', message: 'only members can toggle ready' }
    if (g.room.phase !== 'lobby') return { ok: true } // playing 后就绪无意义：幂等成功
    await roomStorage.setMemberReady(roomId, userId, ready, workerLease)
    await syncActiveRoom(roomId)
    return { ok: true }
  })
}

/** POST /api/rooms/:id/leave —— 成员主动离开（删行 + 广播；owner 离开走转让/解散）。
 *  替代旧 ws room:leave 只退订不删行（成员列表只增不减的缺口，ADR-0005）。 */
export async function leaveRoomAsMember(
  userId: number,
  roomId: string,
): Promise<{ ok: true } | RoomGovernanceFail> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(userId, roomId)
    if (!g.ok) return g
    if (g.callerRole === 'owner') {
      await transferToSuccessorOrDissolve(roomId, userId, workerLease)
      return { ok: true }
    }
    await roomStorage.deleteMemberRow(roomId, userId, workerLease)
    await broadcastMemberMeta(roomId)
    return { ok: true }
  })
}

/** 房主离开的领域动作：还有成员 → 立即转让给最早成员（rowid 序）；否则解散（ADR-0005 无宽限）。 */
export async function leaveRoomAsOwner(
  userId: number,
  roomId: string,
): Promise<{ ok: true } | RoomGovernanceFail> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(userId, roomId)
    if (!g.ok) return g
    if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can dissolve the room' }
    await transferToSuccessorOrDissolve(roomId, userId, workerLease)
    return { ok: true }
  })
}

/** 转让房主行写库（新 owner 行 role='owner' + ready 清零；旧 owner 行降为 member 且留在房内）。 */
async function transferOwnerRow(
  roomId: string, oldOwnerId: number, newOwnerId: number, workerLease?: roomStorage.RoomWorkerLease,
): Promise<void> {
  await roomStorage.transferRoomOwnership(roomId, oldOwnerId, newOwnerId, workerLease)
  getRoom(roomId)?.updateOwner(newOwnerId)
}

/** ADR-0005 继位策略单源（决策 6）：还有其他成员 → 立即转让给最早成员（rowid 序）；否则解散房间行。
 *  转让后对活跃实例做 DB→广播对账（syncActiveRoom）；解散路径行已删、无实例对账。
 *  调用方（REST leaveRoomAsOwner / WS handleOwnerWsDisconnect）各持前置 gate，进入时调用者即 multi 房主。 */
async function transferToSuccessorOrDissolve(
  roomId: string, oldOwnerId: number, workerLease?: roomStorage.RoomWorkerLease,
): Promise<void> {
  const members = await roomStorage.listMembersOrdered(roomId)
  const successor = members.find((m) => m.user_id !== oldOwnerId)
  if (!successor) {
    await roomStorage.deleteRoomRows(roomId, workerLease)
    disposeDeletedRoom(roomId)
    return
  }
  await transferOwnerRow(roomId, oldOwnerId, successor.user_id, workerLease)
  await syncActiveRoom(roomId)
}

/** DELETE /api/rooms/:id/members/:userId —— 房主踢出成员（owner only；删行 + 广播；不可踢自己/owner）。 */
export async function kickRoomMember(
  callerUserId: number,
  roomId: string,
  targetUserId: number,
): Promise<{ ok: true } | RoomGovernanceFail> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(callerUserId, roomId, targetUserId)
    if (!g.ok) return g
    if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can kick members' }
    if (callerUserId === targetUserId) return { ok: false, reason: 'bad-request', message: 'owner cannot kick themselves' }
    await roomStorage.deleteMemberRow(roomId, targetUserId, workerLease)
    await broadcastMemberMeta(roomId)
    return { ok: true }
  })
}

/** POST /api/rooms/:id/transfer —— 房主主动转让给指定成员（新 owner 获得治理权）。 */
export async function transferOwnership(
  callerUserId: number,
  roomId: string,
  targetUserId: number,
): Promise<{ ok: true } | RoomGovernanceFail> {
  return withRoomMutation(roomId, async (workerLease) => {
    const g = await governanceGate(callerUserId, roomId, targetUserId)
    if (!g.ok) return g
    if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can transfer ownership' }
    if (callerUserId === targetUserId) return { ok: false, reason: 'bad-request', message: 'target is already the owner' }
    await transferOwnerRow(roomId, callerUserId, targetUserId, workerLease)
    await syncActiveRoom(roomId)
    return { ok: true }
  })
}

/** 房主 WS 断线（无 REST 语义）：立即转让给最早成员 / 无其他成员解散（ADR-0005 无宽限）。
 *  供 ws 层断线事件调用——仅当脱机的正是当前 owner 时执行（非 owner 断线不动房间；
 *  刷新即易主是已知取舍）。solo 房主断线不转让（单人房主=唯一成员，solo 无等待室）。 */
export async function handleOwnerWsDisconnect(roomId: string, userId: number): Promise<void> {
  return withRoomCommand(roomId, async (workerLease) => {
    if (ROOM_WORKER_FAILOVER_ENABLED && !workerLease) return
    const room = await roomStorage.getRoomRow(roomId)
    if (!room || room.phase === 'ended' || getRoom(roomId)?.isEnded()) return
    if (room.kind !== 'multi' || room.owner_id !== userId) return
    await transferToSuccessorOrDissolve(roomId, userId, workerLease)
  })
}

/** WS join：校验成员资格并返回活跃实例（不存在则 materialize——懒激活）。 */
export async function joinRoom(roomId: string, userId: number, username: string): Promise<RoomService | null> {
  return withRoomCommand(roomId, async () => {
    if (!await roomStorage.isRoomMember(roomId, userId)) return null
    const active = getRoom(roomId)
    if (active && (!active.workerLease || await active.renewWorkerLease())) {
      active.beginOpeningIfPending()
      return active
    }
    if (!hasRoomCapacity(roomId)) return null
    roomsActivating.add(roomId)
    try {
      const room = await materializeRoom(roomId, userId, username)
      // A member may have been removed while this process waited for a lease.
      if (room.workerLease && !await roomStorage.isRoomMember(roomId, userId)) return null
      room.beginOpeningIfPending()
      return room
    } finally {
      roomsActivating.delete(roomId)
    }
  })
}

/** A replaying gateway need not contact a worker. Recover committed pending turns on the workers themselves. */
export async function runPendingRoomRecovery(): Promise<never> {
  for (;;) {
    try {
      if (hasRoomCapacity('')) {
        const rooms = await roomStorage.listPendingRoomRecoveries(8)
        await Promise.all(rooms.map(async ({ room_id: roomId, owner_id: ownerId }) => {
          if (!hasRoomCapacity(roomId)) return
          try {
            await joinRoom(roomId, ownerId, 'user_' + ownerId)
          } catch (error) {
            if (!(error instanceof roomStorage.RoomWorkerBusyError)) {
              logger.warn('Pending room recovery failed', { roomId, error: String(error) })
            }
          }
        }))
      }
    } catch (error) {
      logger.warn('Pending room recovery scan failed', { error: String(error) })
    }
    await delay(500)
  }
}

/** WS 成员资格 gate（sync/action 帧用）。 */
export function isRoomMember(roomId: string, userId: number): Promise<boolean> {
  return roomStorage.isRoomMember(roomId, userId)
}

/** 回收过期房间（TTL 扫描，进程启动时定期调用）。 */
export function reapStaleRooms(canEvict: (roomId: string) => boolean = () => true): void {
  for (const [id, room] of roomRegistry) {
    if (canEvict(id) && room.isStale()) {
      // Recheck after taking the command slot, since a join or action may
      // have arrived while the previous snapshot or membership write ran.
      void withRoomCommand(id, async () => {
        if (roomRegistry.get(id) !== room || !canEvict(id) || !room.isStale()) return
        try {
          await room.writeSnapshot()
        } finally {
          room.dispose()
          roomRegistry.delete(id)
          if (room.workerLease) await roomStorage.releaseRoomLease(id, room.workerLease)
        }
      }).catch((err: unknown) => logger.error('room reaper persistSnapshot failed', { roomId: id, error: String(err) }))
    }
  }
}

/** 定期回收（测试可注入间隔；默认 60s）。 */
export function startRoomReaper(intervalMs = 60_000, canEvict?: (roomId: string) => boolean): NodeJS.Timeout {
  // interval 回调整体 try/catch（#86 装配级）：同步异常不让 interval 打崩进程。
  const t = setInterval(() => {
    try {
      reapStaleRooms(canEvict)
    } catch (err) {
      logger.error('room reaper scan failed', { error: String(err) })
    }
  }, intervalMs)
  t.unref?.()
  return t
}

/** 供测试：清空注册表。 */
export function _clearRoomRegistryForTests(): void {
  for (const room of roomRegistry.values()) room.dispose()
  roomRegistry.clear()
}

export const readRoomOutbox = roomStorage.readRoomOutbox
export const ROOM_EVENT_WINDOW = roomStorage.ROOM_EVENT_WINDOW

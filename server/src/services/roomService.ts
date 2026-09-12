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
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as roomStorage from './roomStorage.js'
import { createCharacterMutatorFactory } from '../rule-engine/characterMutators.js'
import { isKpChunkStreamEnabled } from '../config.js'
import { buildRoomTurnMessages, buildRoomOpeningMessages, OPENING_RAG_QUERY, MAX_MEMORY_ENTRIES, type RoomPromptInput, type StoryWorkflow } from './kpPromptService.js'
import { listStories as listIndexedStories } from './ragService.js'
import type { SceneCoverage } from '../rag/dossier/coverageGaps.js'
import type {
  RoomEventPayloadMap,
  RoomEventType,
  RoomMemberInfo,
  RoomMemberRole,
  RoomPhase as SharedRoomPhase,
} from '../../../shared/types/room.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'

/** 房间阶段（shared 单一来源别名——评审候选 3）。 */
export type RoomPhase = SharedRoomPhase

/** 解析 workflow 入参：仅接受 'dossier'，其余（含 undefined/非法）一律 rag（现状默认）。 */
export function sanitizeWorkflow(value: unknown): StoryWorkflow {
  return value === 'dossier' ? 'dossier' : 'rag'
}

/** 房间成员角色（shared 单一来源别名）。 */
export type MemberRole = RoomMemberRole

export type RoomMember = RoomMemberInfo

/** 房间事件（全序，seq 由 RoomService 串行分配）；payload 单一来源 = shared RoomEventPayloadMap。 */
export type RoomEvent = { [K in RoomEventType]: { type: K; payload: RoomEventPayloadMap[K] } }[RoomEventType]

/** 房间持久化快照（rooms.state JSON）。 */
export interface RoomSnapshot {
  seq: number
  phase: RoomPhase
  storyId: string | null
  messages: Message[]
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
  updatedAt: number
}

interface RoomOptions {
  roomId: string
  ownerId: number
  ownerName: string
  storyId?: string | null
  turnWindowMs?: number
  workflow?: StoryWorkflow
  restore?: RoomSnapshot | null
}

const DEFAULT_TURN_WINDOW_MS = 5_000
const SNAPSHOT_EVERY_N_EVENTS = 20
const SNAPSHOT_EVERY_MS = 10_000
const ROOM_TTL_MS = 30 * 60_000
/** 事件日志环形容量（Phase C1：重连增量窗口；超出 → 全量快照兜底）。 */
const MAX_EVENT_LOG = 200
/** 每 N 个 KP 回合刷新一次长期摘要（场景切换也会触发）。 */
const LONG_TERM_SUMMARY_EVERY_TURNS = 10

/**
 * 房间实例。所有状态变更必须经 enqueue（串行），事件按 seq 全序广播。
 */
export class RoomService {
  readonly roomId: string
  /** 现任房主（转让/断线易主后随 syncFromDb 更新——KP/RAG/记忆全程跟随现任 owner）。 */
  private ownerId: number
  private ownerName: string

  private phase: RoomPhase = 'lobby'
  private storyId: string | null = null
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
  private turnCount = 0
  /** opening 回合已触发标记（实例生命周期内一次；失败不重试内重入）。 */
  private openingStarted = false
  private summarizing = false
  private seq = 0
  private eventCountSinceSnapshot = 0
  private lastSnapshotAt = Date.now()
  private lastActivityAt = Date.now()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(event: RoomEvent, seq: number) => void>()
  /** 事件日志（Phase C1）：带 seq 的增量事件，环形保留最近 MAX_EVENT_LOG 条。 */
  private eventLog: { seq: number; event: RoomEvent }[] = []
  private eventLogStartSeq = 0
  private snapshotTimer: NodeJS.Timeout | null = null
  /** 回合窗口（D4）：缓冲窗口内玩家消息，超时合并进一次 KP 回合。 */
  private turnBuffer: { username: string; content: string; characterId: string | null; authorUserId: number }[] = []
  private turnTimer: NodeJS.Timeout | null = null
  private turnFlushing = false

  constructor(private readonly opts: RoomOptions) {
    this.roomId = opts.roomId
    this.ownerId = opts.ownerId
    this.ownerName = opts.ownerName
    this.storyId = opts.storyId ?? null
    this.turnWindowMs = opts.turnWindowMs ?? DEFAULT_TURN_WINDOW_MS
    this.workflow = opts.workflow ?? 'rag'
    if (opts.restore) {
      this.phase = opts.restore.phase ?? 'lobby'
      this.storyId = opts.restore.storyId ?? null
      this.messages = Array.isArray(opts.restore.messages) ? opts.restore.messages : []
      this.characters = new Map(Object.entries(opts.restore.characters ?? {}))
      this.clues = Array.isArray(opts.restore.clues) ? opts.restore.clues : []
      this.scene = opts.restore.scene ?? null
      this.ending = opts.restore.ending ?? null
      this.seq = typeof opts.restore.seq === 'number' ? opts.restore.seq : 0
      this.turnWindowMs = opts.restore.turnWindowMs ?? DEFAULT_TURN_WINDOW_MS
      this.workflow = opts.restore.workflow === 'dossier' ? 'dossier' : 'rag'
      this.kpMemory = Array.isArray(opts.restore.kpMemory) ? opts.restore.kpMemory : []
      this.longTermSummary = typeof opts.restore.longTermSummary === 'string' ? opts.restore.longTermSummary : ''
    }
    this.snapshotTimer = setInterval(() => void this.maybeSnapshot(), SNAPSHOT_EVERY_MS)
    this.snapshotTimer.unref?.()
  }

  /* ═══════════════ 查询（只读，无需入队） ═══════════════ */

  getPhase(): RoomPhase { return this.phase }
  /** 结束态（终态，#54）。方法形态：调用点能拿到"此刻"的值，不受 TS 属性收窄影响。 */
  isEnded(): boolean { return this.phase === 'ended' }
  getSeq(): number { return this.seq }
  getStoryId(): string | null { return this.storyId }
  getWorkflow(): StoryWorkflow { return this.workflow }
  getScene(): string | null { return this.scene }
  getMessages(): readonly Message[] { return this.messages }
  getCharacters(): ReadonlyMap<string, COCCharacterSheet> { return this.characters }
  getClues(): readonly { id: string; description: string }[] { return this.clues }
  getEnding(): unknown { return this.ending }
  isStale(): boolean { return Date.now() - this.lastActivityAt > ROOM_TTL_MS }

  /** 序列化快照（落库/重连全量）。 */
  snapshot(): RoomSnapshot {
    return {
      seq: this.seq,
      phase: this.phase,
      storyId: this.storyId,
      messages: this.messages,
      characters: Object.fromEntries(this.characters),
      clues: this.clues,
      scene: this.scene,
      ending: this.ending,
      turnWindowMs: this.turnWindowMs,
      workflow: this.workflow === 'dossier' ? 'dossier' : 'rag',
      kpMemory: this.kpMemory,
      longTermSummary: this.longTermSummary,
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

  private emit(event: RoomEvent): void {
    this.seq += 1
    this.eventCountSinceSnapshot += 1
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
    if (lastSeq < this.eventLogStartSeq) return null
    return this.eventLog.filter((e) => e.seq > lastSeq)
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
  setEnding(ending: unknown): void {
    this.ending = ending
    this.phase = 'ended'
    this.persistPhase('ended')
    this.emit({ type: 'state_patch', payload: { path: 'ending', value: ending } })
    this.emit({ type: 'room_meta', payload: { phase: 'ended', turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  /** 设置房间阶段（room_meta）。 */
  setPhase(phase: RoomPhase): void {
    this.phase = phase
    this.persistPhase(phase)
    this.emit({ type: 'room_meta', payload: { phase, turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  /** 阶段落库（#54）：`rooms.phase` 列是详情 / 继续游戏列表 / restore 的真源，
   *  内存变更必须写列——否则结束的局仍挂在首页入口，重启后还会被复活成进行中。
   *  写失败只记日志：阶段广播已经发生，回合/游玩流程不该因一次写失败中断。 */
  private persistPhase(phase: RoomPhase): void {
    try {
      roomStorage.updateRoomPhase(this.roomId, phase)
    } catch (err) {
      console.error(`[room-phase] room=${this.roomId} 落库 ${phase} 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 广播成员列表（room_meta）——成员加入/离开/绑定角色/就绪后调用（Phase C2 / ADR-0005）。 */
  broadcastMembers(members: RoomMember[]): void {
    this.emit({ type: 'room_meta', payload: { phase: this.phase, turnWindowMs: this.turnWindowMs, members } })
  }

  /** 从 DB 加载成员列表（room_meta 事件携带真实 members，避免清空客户端列表——审查修复）。 */
  private membersFromDb(): RoomMember[] {
    return roomStorage.listMembers(this.roomId).map(memberRowToInfo)
  }

  /** 设置回合窗口（房主控制，B6）；0 = 严格排队。广播 room_meta 全员可见。 */
  setTurnWindowMs(ms: number): void {
    const clamped = Math.max(0, Math.min(60_000, Math.floor(ms)))
    this.turnWindowMs = clamped
    this.emit({ type: 'room_meta', payload: { phase: this.phase, turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  getTurnWindowMs(): number {
    return this.turnWindowMs
  }

  /** 开始游戏（lobby → playing，绑定剧本）。 */
  startGame(storyId: string): void {
    this.storyId = storyId
    this.phase = 'playing'
    this.emit({ type: 'room_meta', payload: { phase: 'playing', turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  /**
   * 从 DB 权威状态同步活跃实例（审查修复 #1/#3）：
   * REST start/绑定角色只写 DB，此处把 storyId/phase/characters map 同步进内存实例，
   * 使 KP 回合拿到剧本上下文、多角色分派拿到角色组。
   */
  syncFromDb(): void {
    const r = roomStorage.getRoomRow(this.roomId)
    if (!r) return
    if (typeof r.story_id === 'string') this.storyId = r.story_id
    if (typeof r.phase === 'string' && (r.phase === 'lobby' || r.phase === 'playing' || r.phase === 'ended')) {
      this.phase = r.phase
    }
    // 房主跟随 DB（ADR-0005 转让/断线易主）：KP/RAG/记忆解析账号 = 现任 owner
    if (r.owner_id !== this.ownerId) {
      this.ownerId = r.owner_id
      this.ownerName = roomStorage.usernameOf(r.owner_id) ?? `user_${r.owner_id}`
    }
    // 角色组：从 DB 绑定关系加载 sheet（characters 表是 sheet 权威）
    for (const b of roomStorage.boundCharacterSheets(this.roomId)) {
      try {
        const sheet = JSON.parse(b.sheet) as COCCharacterSheet
        this.characters.set(b.characterId, sheet)
        this.characterOwner.set(b.characterId, b.userId)
      } catch { /* 脏 sheet 忽略 */ }
    }
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
  emitSheetPatch(characterId: string, sheet: COCCharacterSheet): void {
    this.emit({ type: 'state_patch', payload: { path: `characters.${characterId}`, value: sheet } })
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
  submitPlayerChat(userId: number, content: string): void {
    const username = roomStorage.usernameOf(userId) ?? `user_${userId}`
    const characterId = roomStorage.memberCharacterId(this.roomId, userId)
    this.appendMessage(
      { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'player', playerName: username, content },
      { userId, roleName: username },
    )
    if (this.phase !== 'playing') return
    // Phase B6 + D4：玩家消息触发 KP 回合——回合窗口合并；行动者 = 成员绑定的角色卡。
    // 单人房间 = 单成员（FR-M9）；turnWindowMs=0 时立即处理（严格排队）。
    this.bufferPlayerChat(username, content, characterId, userId)
  }

  /** 玩家消息进回合缓冲（聊天即时广播；KP 回合等窗口超时合并执行）。 */
  bufferPlayerChat(username: string, content: string, characterId: string | null, authorUserId: number): void {
    this.turnBuffer.push({ username, content, characterId, authorUserId })
    // turnWindowMs 由活跃实例唯一持有（ADR-0001）：房主设置经领域方法
    // setRoomTurnWindow 一次写库 + 同步实例；快照 restore 是重启兜底。
    // turnWindowMs=0 → 严格排队：每条消息立即触发 KP 回合（无合并延迟）
    if (this.turnWindowMs <= 0) {
      void this.flushTurn()
      return
    }
    if (!this.turnTimer) {
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null
        void this.flushTurn()
      }, this.turnWindowMs)
      this.turnTimer.unref?.()
    }
  }

  /** 合并缓冲内玩家消息 → 一次 KP 回合（窗口超时/严格排队时调用）。 */
  async flushTurn(): Promise<void> {
    if (this.turnFlushing) return
    // 结束态是终态（#54）：end_game 之后不再消费任何缓冲消息。
    // 覆盖两条入口——本函数自身，以及回合进行中投递的消息（见下方 finally 的补触发）。
    // 只拦 'ended'（不拦 lobby）：阶段门闩在 `submitPlayerChat`（生产唯一入口），
    // 本方法是**无门闩的机制**——等待室闲聊本就不经它（D4/B6 既有分工）。
    if (this.isEnded()) {
      this.turnBuffer = []
      return
    }
    const batch = this.turnBuffer
    this.turnBuffer = []
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    if (batch.length === 0) return

    this.turnFlushing = true
    try {
      // 合并为带行动者标记的 user 消息（D4：一次 LLM 推理覆盖多人行动）
      const merged = batch.map((b) => `【${b.username}】${b.content}`).join('\n')
      // 缺省工具 characterId 回退目标 = 最后一位行动者
      const activeCharacterId = batch[batch.length - 1]?.characterId ?? null
      // D5 归属校验：窗口内行动者可用的角色卡 id 集（各自绑定的卡）
      const allowedCharacterIds = new Set(batch.map((b) => b.characterId).filter((id): id is string => !!id))
      // 上下文注入服务端收口（ADR-0002）：RAG + 记忆 + 近窗对话在本侧组装；
      // 历史不含本批（本批以合并 user 消息收尾），角色组随状态注入 system。
      const historyEnd = Math.max(0, this.messages.length - batch.length)
      // 知识注入按 workflow 分派：rag = 玩家消息当 query 检索；dossier = 静态场景块
      const [knowledge, storyName] = await Promise.all([
        this.workflow === 'dossier' ? this.fetchKnowledge() : this.fetchRagContext(merged).then((ragContext) => ({ ragContext, sceneBlock: '', sceneName: undefined })),
        this.fetchStoryName(),
      ])
      const ragContext = knowledge.ragContext
      const sceneBlock = knowledge.sceneBlock
      // P27（预取）+ M1-T6（检索补充）并行：预取是事实层深挖（玩家发言是事实问句且
      // 档案对不上措辞时先跑一次查证，结论并入本轮 system，对玩家不可见——P26 已证
      // 纯提示词无法让 KP 主动查证）；补充层是纹理（ADR-0007）。两者互不依赖，失败
      // 一律静默降级为空。**补充层关闭开关时不读档案、不检索、不加载模型。**
      const [prefetched, supplement] = await Promise.all([
        this.prefetchVerification(merged, knowledge),
        this.fetchTurnSupplement(merged, knowledge),
      ])
      const chatMessages = buildRoomTurnMessages(
        this.promptInput(storyName, this.messages.slice(0, historyEnd)),
        ragContext,
        merged,
        { workflow: this.workflow, sceneBlock, verifyBlock: prefetched, supplement },
      )
      await this.runKpTurnForRoom(
        this.ownerId,
        chatMessages,
        this.storyId ? { scriptId: this.storyId, sceneId: this.scene ?? undefined, workflow: this.workflow } : null,
        activeCharacterId,
        (chunk) => {
          // 实验（KP_CHUNK_STREAM=1）：KP 回复流式增量帧（TTFT 测量；客户端未消费，整段 message_appended 仍为准）
          if (isKpChunkStreamEnabled() && chunk) this.emit({ type: 'kp_chunk', payload: { content: chunk } })
        },
        allowedCharacterIds,
        // wire 采样（M1-T6 语义扩展）：注入列 = 场景档案块 + 检索补充小节
        // （此前只有 rag 房的 ragContext）。采样落库的注入文本即"KP 本轮实际看到的
        // 知识块"，供 A/B 报告统计注入量与还原现场。
        [sceneBlock, supplement].filter((s) => !!s && s.trim().length > 0).join('\n\n') || ragContext,
      )
    } finally {
      this.turnFlushing = false
      // 本回合内 KP 可能调了 end_game（setEnding 改 phase）——此时缓冲里的消息
      // **不再**补触发新回合（#54：已完结的局不该继续跑 KP）；直接丢弃。
      // 用 isEnded() 而不是裸 `this.phase === 'ended'`：函数顶部那条同形守卫会把
      // `this.phase` 收窄成非 ended，TS 在 finally 里看不到回合中的变更（TS2367）。
      if (this.isEnded()) {
        this.turnBuffer = []
      } else if (this.turnBuffer.length > 0) {
        // 审查修复：flush 期间到达的新消息补触发（否则挂起到下一条消息）
        if (this.turnWindowMs <= 0) {
          void this.flushTurn()
        } else {
          this.turnTimer = setTimeout(() => {
            this.turnTimer = null
            void this.flushTurn()
          }, this.turnWindowMs)
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

  /**
   * 房间内 KP 回合（Phase B6 + D4/D5）：复用 kpTurnService 的服务端图内工具循环。
   * - characters = 房间角色组（多人多卡）；activeCharacterId = 缺省行动者
   * - 工具执行的世界增量（线索/场景/结局）直接应用到房间状态并广播
   * - KP 回复追加消息流（message_appended）
   * - 角色卡变更 → state_patch 广播（所有成员实时可见）
   * - mutators 按 characterId 分派（D5）：工具 args.characterId → 对应角色卡
   */
  /** dossier workflow 查证工具执行器：按工具名查档案，返回工具结果 content。 */
  private buildStoryLookup(): ((toolName: string, args: Record<string, unknown>) => Promise<{ content: string }>) | undefined {
    if (this.workflow !== 'dossier' || !this.storyId) return undefined
    return async (toolName, args) => {
      const { loadDossier, listScenes, buildSceneBlock, findScene, lexicalSearch, renderSceneNotFound, renderLexicalMiss } = await import('../rag/dossier/dossierCore.js')
      const { computeSceneCoverage, loadGaps } = await import('../rag/dossier/coverageGaps.js')
      const dossier = await loadDossier(this.ownerId, this.storyId as string)
      if (!dossier) return { content: 'error: 剧本档案不存在' }
      if (toolName === 'scene_list') {
        const scenes = listScenes(dossier)
        if (scenes.length === 0) return { content: '剧本档案中暂无场景。' }
        return { content: scenes.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`).join('\n') }
      }
      if (toolName === 'scene_dossier') {
        const name = String(args.sceneName ?? '').trim()
        if (!name) return { content: 'error: sceneName required' }
        const scene = findScene(dossier, name)
        if (!scene) {
          return { content: renderSceneNotFound(name, listScenes(dossier).map((s) => s.name)) }
        }
        // P26：附场景覆盖提示（缺口归属按 .gaps.json；loadGaps 内部已吞错返回 null）
        const gaps = await loadGaps(this.ownerId, this.storyId as string)
        const coverage = gaps ? computeSceneCoverage(gaps, scene.id) : null
        return { content: buildSceneBlock(dossier, scene.id, coverage) }
      }
      if (toolName === 'lexical_search') {
        const query = String(args.query ?? '').trim()
        if (!query) return { content: 'error: query required' }
        const hits = lexicalSearch(dossier, query, 5)
        if (hits.length === 0) return { content: renderLexicalMiss(query) }
        return { content: hits.map((h) => `[${h.kind}] ${h.name}${h.text ? `：${h.text.slice(0, 200)}` : ''}`).join('\n') }
      }
      if (toolName === 'verify_original') {
        // P25 运行时原文查证：场景锚点窗口 → 全新上下文子阅读器（剧透层标注随内容）。
        // 缺省场景 = 房间当前场景；内部失败一律降级为「未取得」文本（不阻断回合）。
        const question = String(args.question ?? '').trim()
        if (!question) return { content: 'error: question required' }
        const sceneArg = String(args.scene ?? '').trim() || this.scene || undefined
        const { verifyOriginal } = await import('../rag/dossier/originalLookup.js')
        const res = await verifyOriginal(
          { question, scene: sceneArg },
          { userId: this.ownerId, scriptId: this.storyId as string },
        )
        if (process.env.KP_LLM_DEBUG === '1') {
          console.error(`[verify-original] room=${this.roomId} scene=${sceneArg ?? ''} tier=${res.meta.tier} chars=${res.meta.chars} ok=${res.meta.ok} ${res.meta.durationMs}ms`)
        }
        return { content: res.content }
      }
      return { content: `error: unknown tool "${toolName}"` }
    }
  }

  async runKpTurnForRoom(
    ownerUserId: number,
    messages: unknown[],
    storyContext: Record<string, unknown> | null,
    activeCharacterId: string | null,
    onChunk: (chunk: string) => void,
    allowedCharacterIds?: Set<string>,
    /** 当轮 RAG 注入原文（wire 采样 T1；缺省 = 无注入）。 */
    ragContext = '',
  ): Promise<void> {
    const { runKpTurn } = await import('./kpTurnService.js')
    const characterMap = this.getCharacterMap()

    // 变更应用器工厂（评审候选 1：15 个 sheet 变更语义唯一实现在 rule-engine/characterMutators；
    // onSheetMutated → state_patch 广播，world 三回调接房间状态方法）
    const mutatorFactory = createCharacterMutatorFactory({
      resolveSheet: (id) => (id ? this.characters.get(id) : null) ?? null,
      onSheetMutated: (id, sheet) => {
        if (id) this.emit({ type: 'state_patch', payload: { path: `characters.${id}`, value: sheet } })
      },
      transitionToScene: (sceneName) => this.setScene(sceneName),
      addClue: (description, clueId) => this.addClue(description, clueId),
      endGame: (ending) => this.setEnding(ending),
    })

    await runKpTurn(
      ownerUserId,
      { messages, storyContext },
      {
        characters: characterMap,
        activeCharacterId,
        mutatorFactory,
        allowedCharacterIds, // D5：归属校验（窗口内行动者可用的角色卡集）
        sampling: { roomId: this.roomId, storyId: this.storyId, ragContext }, // T1 wire 采样（唯一新缝）
        storyLookup: this.buildStoryLookup(), // dossier workflow 查证工具（rag = undefined）
        handlers: {
          onChunk,
          onEnd: (result) => {
            // KP 回复追加消息流
            if (result.content?.trim()) {
              this.appendMessage(
                { id: `kp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'kp', content: result.content },
                { userId: ownerUserId, roleName: 'KP' },
              )
              // 回合后记忆编排（fire-and-forget，ADR-0002 上下文收口）
              void this.rememberTurn(result.content)
            }
            // 工具展示消息（骰子/系统提示）追加消息流
            for (const dm of result.displayMessages ?? []) {
              this.appendMessage(dm as Message, { userId: ownerUserId, roleName: 'KP' })
            }
          },
          onError: () => {
            // 回合失败可见化：系统消息进流（同时供客户端清除「KP 推进中」占位）
            this.appendMessage(
              { id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'system', content: 'KP 回合失败，请稍后重试。' },
              { userId: ownerUserId, roleName: 'system' },
            )
          },
        },
      },
    )
  }

  /**
   * P27 预取：事实问句 + 档案对不上措辞 → 服务端先查证，结论并入本轮 system。
   * 仅在 dossier 房生效；任何失败/超时返回 ''（不回填、不阻断回合）。
   * 覆盖度复用 fetchDossierContext 算好的那份（不再单独读 gaps）；查证本身若触发，
   * `verifyOriginal` 会自行读一次 gaps/原文（各有 TTL 缓存）——口径一致，非重复劳动。
   *
   * 动态 import 也包在 try 里（审查）：模块加载失败会让 `Promise.all` 拒绝，
   * 而 flushTurn 没有外层 catch → 整个回合静默丢失。
   */
  private async prefetchVerification(
    playerText: string,
    knowledge: { sceneBlock: string; sceneName?: string; coverage?: SceneCoverage | null },
  ): Promise<string> {
    if (this.workflow !== 'dossier' || !this.storyId) return ''
    try {
      const { runPrefetch } = await import('../rag/dossier/prefetch.js')
      const res = await runPrefetch(
        { playerText, sceneBlock: knowledge.sceneBlock, sceneName: knowledge.sceneName, coverage: knowledge.coverage ?? null },
      {
        userId: this.ownerId,
        scriptId: this.storyId,
        onEvent: (e) => {
          if (process.env.KP_LLM_DEBUG === '1') console.error(`[prefetch] room=${this.roomId} ${JSON.stringify(e)}`)
          // 实验追踪（PREFETCH_TRACE=<path>，默认关）：逐行 JSONL，供报告统计触发/命中。
          const trace = process.env.PREFETCH_TRACE
          if (trace) {
            try {
              mkdirSync(dirname(trace), { recursive: true })
              appendFileSync(trace, JSON.stringify({ at: Date.now(), roomId: this.roomId, storyId: this.storyId, ...e }) + '\n')
            } catch {
              /* 追踪失败不影响回合 */
            }
          }
        },
      },
    )
      return res?.content ?? ''
    } catch {
      // 预取链路失败（含动态 import 失败）→ 静默降级为空（回合照常）
      return ''
    }
  }

  /* ═══════════════ 上下文注入与记忆（ADR-0002，服务端收口） ═══════════════ */

  /**
   * 检索补充小节（M1-T6 / spec #44 / ADR-0007 决策 5/6）：档案房每回合固定检索一次，
   * 注入 ≤3 块 / ≤1.6k 字符的原文纹理。返回**已渲染小节**（空串 = 不注入）。
   *
   * 只在 dossier workflow 生效；rag 房的情报块本身就是检索产物（标准管线，见 fetchRagContext）。
   * 总开关 `rag.supplement`（默认开）关闭时直接返回 ''——不读档案、不检索、不加载模型。
   * 永不抛出：任何失败都降级为空小节（回合不因纹理补充中断）。
   */
  private async fetchTurnSupplement(
    playerText: string,
    knowledge: { sceneName?: string } = {},
  ): Promise<string> {
    if (this.workflow !== 'dossier' || !this.storyId) return ''
    try {
      const { getSettings } = await import('./settingsService.js')
      if (getSettings(this.ownerId)?.rag?.supplement === false) return ''
      const { buildSupplement, defaultRewrite } = await import('../rag/supplementService.js')
      const { buildGetEmbeddingForUser } = await import('./ragService.js')
      const res = await buildSupplement(
        {
          userId: this.ownerId,
          scriptId: this.storyId,
          playerText,
          sceneName: knowledge.sceneName ?? this.scene ?? undefined,
          enabled: true,
        },
        {
          getEmbedding: (await buildGetEmbeddingForUser(this.ownerId)) ?? undefined,
          // 低分改写（ADR-0007 决策 6）：仅在检索最高分低于阈值时触发一次
          rewrite: defaultRewrite(this.ownerId),
          onEvent: (e) => {
            if (process.env.KP_LLM_DEBUG === '1') console.error(`[supplement] room=${this.roomId} ${JSON.stringify(e)}`)
            const trace = process.env.SUPPLEMENT_TRACE
            if (trace) {
              try {
                mkdirSync(dirname(trace), { recursive: true })
                appendFileSync(trace, JSON.stringify({ at: Date.now(), roomId: this.roomId, storyId: this.storyId, ...e }) + '\n')
              } catch {
                /* 追踪失败不影响回合 */
              }
            }
          },
        },
      )
      return res.section
    } catch (err) {
      if (process.env.KP_LLM_DEBUG === '1') console.error(`[supplement-fail] room=${this.roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  /**
   * RAG 房情报块（M1-T6）：**标准管线，无图路径**（ADR-0007 决策 2/3）。
   * query → 嵌入 → 向量召回 → 本地 cross-encoder rerank → 渲染块文本。
   *
   * 与档案房的差别（同一套检索，两种装配语义）：
   *  - `mode: 'plain'`——rag 房没有档案块，所以**不做**档案重叠剔除与场景归属排序
   *    （审查发现：两者都会把 rag 房自己的知识来源删掉/塌成 1 条）；
   *  - `rawQuery`——玩家发言就是检索意图，不套场景名拼接与规则清洗；
   *  - 渲染块文本用 `renderBlock`（跨场景前缀必须保留），不另起小节标题
   *    （那属于档案房的双轨标注）。
   * 剧透硬闸两房共有。失败回退 ''——回合不因检索中断。
   */
  private async fetchRagContext(query: string): Promise<string> {
    if (!this.storyId) return ''
    try {
      const { buildSupplement, defaultRewrite } = await import('../rag/supplementService.js')
      // renderBlock 取自装配模块本体（纯函数）——不经服务层 re-export，
      // 这样测试桩 supplementService（IO 层）时渲染口径仍是真的。
      const { renderBlock } = await import('../rag/supplementAssembly.js')
      const { buildGetEmbeddingForUser } = await import('./ragService.js')
      const res = await buildSupplement(
        {
          userId: this.ownerId,
          scriptId: this.storyId,
          rawQuery: query,
          sceneName: this.scene ?? undefined,
          mode: 'plain',
          enabled: true,
        },
        {
          getEmbedding: (await buildGetEmbeddingForUser(this.ownerId)) ?? undefined,
          // 标准管线的低分改写对两房一致启用（否则 A/B 对照臂被削——审查发现）
          rewrite: defaultRewrite(this.ownerId),
          onEvent: (e) => {
            if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch] room=${this.roomId} ${JSON.stringify(e)}`)
          },
        },
      )
      const text = res.blocks.map(renderBlock).join('\n\n')
      if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch] room=${this.roomId} chars=${text.length} degraded=${res.degraded}`)
      return text
    } catch (err) {
      if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch-fail] room=${this.roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  /** dossier workflow：按当前场景取档案静态块 + 场景清单（场景名归一 + 覆盖度）。 */
  private async fetchDossierContext(): Promise<{ block: string; sceneName?: string; coverage?: SceneCoverage | null }> {
    if (!this.storyId) return { block: '' }
    try {
      const { loadDossier, buildSceneBlock, listScenes, findScene, renderSceneUncovered } = await import('../rag/dossier/dossierCore.js')
      const { computeSceneCoverage, loadGaps } = await import('../rag/dossier/coverageGaps.js')
      const dossier = await loadDossier(this.ownerId, this.storyId)
      if (!dossier) return { block: '' }
      const scenes = listScenes(dossier)
      // 场景归属（#53）：房间 scene 为空（新局，还没切过场景）→ 回落档案首场景；
      // **有值但对不上任何档案场景 → 绝不安到别的场景上**（错喂 B 场景的块/在场 NPC/
      // 覆盖率，KP 会照着讲述眼前并不存在的东西）。名字先过 findScene 归一
      // （大小写/包含），与检索补充层、原文查证共用同一套匹配口径。
      const wanted = String(this.scene ?? '').trim()
      const matched = wanted ? findScene(dossier, wanted) : null
      // 回落只在"房间还没有场景"时发生；id 与 name 取自**同一个**已解析场景，
      // 否则空场景会退化成"有块没名字"——补充层的 query 锚与预取的定位窗口全丢。
      const resolved = matched ?? (!wanted ? scenes[0] : undefined)
      const unmatched = !!wanted && !matched
      if (unmatched && process.env.KP_LLM_DEBUG === '1') {
        console.error(
          `[dossier-scene] room=${this.roomId} story=${this.storyId} 房间场景「${wanted}」未匹配到档案场景` +
            `（档案 ${scenes.length} 个：${scenes.slice(0, 8).map((s) => s.name).join('、')}${scenes.length > 8 ? '…' : ''}）→ 不注入场景块`,
        )
      }
      const sceneName = unmatched ? wanted : resolved?.name
      // P26：场景块附覆盖提示（该场景原文有多少未入档）——P25 观测到 KP 缺少
      // "档案可能不全"的信号，从不主动查原文。loadGaps 内部已吞错返回 null。
      // 未覆盖时不取覆盖率：那是别的场景的数据，报出来就是冒充。
      const gaps = unmatched ? null : await loadGaps(this.ownerId, this.storyId)
      const coverage = resolved?.id ? computeSceneCoverage(gaps, resolved.id) : null
      const block = unmatched
        ? renderSceneUncovered(wanted, scenes.map((s) => s.name))
        : buildSceneBlock(dossier, resolved?.id ?? '', coverage)
      return { block, sceneName, coverage }
    } catch (err) {
      // 静默降级为空块（既有约定：注入失败不阻断回合），但留可见诊断——
      // 否则"档案块凭空消失"（含 mock 缺导出这类编程错误）线上无从发现。
      if (process.env.KP_LLM_DEBUG === '1') {
        console.error(`[dossier-scene] room=${this.roomId} story=${this.storyId} 场景块解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return { block: '' }
    }
  }

  /** 房间知识注入（workflow 分派）：rag → 检索上下文；dossier → 静态场景块 + 场景 id。
   *  覆盖度随块一并回传（P27 预取判定复用，同一回合不重复读 gaps）。 */
  private async fetchKnowledge(): Promise<{ ragContext: string; sceneBlock: string; sceneName?: string; coverage?: SceneCoverage | null }> {
    if (!this.storyId) return { ragContext: '', sceneBlock: '' }
    if (this.workflow === 'dossier') {
      const d = await this.fetchDossierContext()
      return { ragContext: '', sceneBlock: d.block, sceneName: d.sceneName, coverage: d.coverage }
    }
    return { ragContext: await this.fetchRagContext(OPENING_RAG_QUERY), sceneBlock: '' }
  }
  /** 剧本名（rag 索引清单 / dossier 档案；失败回退 ''）。 */
  private async fetchStoryName(): Promise<string> {
    if (!this.storyId) return ''
    try {
      if (this.workflow === 'dossier') {
        const { loadDossier } = await import('../rag/dossier/dossierCore.js')
        const dossier = await loadDossier(this.ownerId, this.storyId)
        if (dossier?.storyName) return dossier.storyName
      }
      const { listStories } = await import('./ragService.js')
      return listStories(this.ownerId).find((s) => s.storyId === this.storyId)?.name ?? ''
    } catch {
      return ''
    }
  }

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
  private async rememberTurn(content: string): Promise<void> {
    this.kpMemory = [...this.kpMemory, `${content.slice(0, 80)}…`].slice(-MAX_MEMORY_ENTRIES)
    try {
      const { extractMemoryPoints } = await import('./roomMemory.js')
      const points = await extractMemoryPoints(this.ownerId, content)
      this.kpMemory = [...this.kpMemory.slice(0, -1), ...points].slice(-MAX_MEMORY_ENTRIES)
    } catch {
      // 兜底条目已在
    }
    this.turnCount += 1
    if (this.turnCount % LONG_TERM_SUMMARY_EVERY_TURNS === 0) void this.refreshLongTermSummary()
  }

  /** 长期摘要刷新（fire-and-forget；失败保持原摘要）。 */
  private async refreshLongTermSummary(): Promise<void> {
    if (this.summarizing) return
    this.summarizing = true
    try {
      const { summarizeLongTerm } = await import('./roomMemory.js')
      const recent = this.messages
        .slice(-20)
        .map((m) => `${m.role === 'kp' ? '守密人' : '调查员'}: ${String((m as { content?: unknown }).content ?? '')}`)
        .join('\n')
      const summary = await summarizeLongTerm(this.ownerId, {
        recentMessagesText: recent.slice(0, 4000),
        currentSummary: this.longTermSummary,
        storyContextText: `当前场景：${this.scene ?? '未知'}；已获线索 ${this.clues.length} 条。`,
      })
      if (summary) this.longTermSummary = summary
    } catch {
      // 摘要失败保持原值
    } finally {
      this.summarizing = false
    }
  }

  /** opening（ADR-0002）：startRoom / 首次 join 时触发一次，失败不阻塞进入。 */
  beginOpeningIfPending(): void {
    if (this.openingStarted || this.phase !== 'playing' || this.messages.length > 0) return
    this.openingStarted = true
    void this.runOpeningTurn()
  }

  /**
   * opening 回合真实执行：串行入队（与后续 flushTurn 共享队列，避免与玩家
   * 首条消息并发跑两个回合）。失败不阻塞进入——首回合不是门闩，玩家消息
   * 照常触发回合（flushTurn 路径独立）。快照恢复时角色组（characters map）
   * 由 getOrCreateRoom 的 syncFromDb 装载后才会调用本方法（懒激活顺序保证）。
   */
  private async runOpeningTurn(): Promise<void> {
    try {
      const [knowledge, storyName] = await Promise.all([
        this.workflow === 'dossier'
          ? this.fetchKnowledge()
          : this.fetchRagContext(OPENING_RAG_QUERY).then((ragContext) => ({ ragContext, sceneBlock: '', sceneName: undefined })),
        this.fetchStoryName(),
      ])
      const ragContext = knowledge.ragContext
      // opening 也走补充层（M1-T6）：无玩家文本 → query 退化为纯场景名（T4 契约）
      const openingSupplement = await this.fetchTurnSupplement('', knowledge)
      const chatMessages = buildRoomOpeningMessages(this.promptInput(storyName, this.messages), ragContext, {
        workflow: this.workflow,
        sceneBlock: knowledge.sceneBlock,
        supplement: openingSupplement,
      })
      const firstCharacterId = [...this.characters.keys()][0] ?? null
      await this.enqueue(() =>
        this.runKpTurnForRoom(
          this.ownerId,
          chatMessages,
          this.storyId ? { scriptId: this.storyId, sceneId: this.scene ?? undefined, workflow: this.workflow } : null,
          firstCharacterId,
          (chunk) => {
            // 实验（KP_CHUNK_STREAM=1）：同 flushTurn 的流式增量帧（TTFT 测量）
            if (isKpChunkStreamEnabled() && chunk) this.emit({ type: 'kp_chunk', payload: { content: chunk } })
          },
          undefined,
          // wire 采样注入列：与 flushTurn 同口径（场景块 + 补充小节；rag 房回退情报块）
          [knowledge.sceneBlock, openingSupplement].filter((s) => !!s && s.trim().length > 0).join('\n\n') || ragContext,
        ),
      )
    } catch (err) {
      // opening 失败不阻塞（ADR-0002）——保留可见日志（此前全吞难排查）
      console.log('[opening] runOpeningTurn FAILED room=', this.roomId, 'err=', err instanceof Error ? err.message : String(err))
    }
  }

  /* ═══════════════ 快照 / 回收 ═══════════════ */

  private async maybeSnapshot(): Promise<void> {
    if (this.eventCountSinceSnapshot >= SNAPSHOT_EVERY_N_EVENTS || Date.now() - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      await this.persistSnapshot()
    }
  }

  /** 落库快照（rooms.state）。 */
  async persistSnapshot(): Promise<void> {
    this.eventCountSinceSnapshot = 0
    this.lastSnapshotAt = Date.now()
    roomStorage.updateRoomStateSnapshot(this.roomId, JSON.stringify(this.snapshot()))
  }

  /** 停止定时器（房间回收时调用）。 */
  dispose(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshotTimer = null
    this.clearTurnWindow()
    this.listeners.clear()
  }
}

/* ═══════════════ 房间注册表（进程内单例） ═══════════════ */

const roomRegistry = new Map<string, RoomService>()

/** 获取或创建房间（owner 建房）。 */
export function getOrCreateRoom(
  roomId: string,
  ownerId: number,
  ownerName: string,
  storyId?: string | null,
): RoomService {
  let room = roomRegistry.get(roomId)
  if (!room) {
    // DB 权威：列（story_id/phase）优先于 state 快照（审查修复 #1：
    // REST start 只更新列，实例 restore 必须拿到最新 storyId/phase）
    const r = roomStorage.getRoomRow(roomId)
    let restore: RoomSnapshot | null = null
    if (r?.state) {
      try { restore = JSON.parse(r.state) as RoomSnapshot } catch { restore = null }
    }
    if (restore) {
      // 列是权威：覆盖快照中的过期值
      if (typeof r?.story_id === 'string') restore.storyId = r.story_id
      if (r?.phase === 'lobby' || r?.phase === 'playing' || r?.phase === 'ended') restore.phase = r.phase
      // 旧数据自愈（#54）：修复前 end_game 只改内存不写列，库里留下的坏行是
      // 「列=playing + 快照 ending!=null」。ending 只有 setEnding 写、没有取消路径，
      // 故它非空即可反推 ended——否则这些房间重启后仍被复活成进行中。
      if (restore.ending != null && restore.phase === 'playing') {
        restore.phase = 'ended'
        try { roomStorage.updateRoomPhase(roomId, 'ended') } catch { /* 自愈失败不阻断物化 */ }
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
    room = new RoomService({ roomId, ownerId, ownerName, storyId, restore })
    roomRegistry.set(roomId, room)
    // 对账（ADR-0001）：物化即列优先同步——列（story_id/phase）已入 restore，
    // 绑定角色组从 DB 装载（createSoloRoom 先绑后 join、TTL 回收重进都依赖此步）。
    room.syncFromDb()
  }
  return room
}

/** 获取房间（不存在返回 null）。 */
export function getRoom(roomId: string): RoomService | null {
  return roomRegistry.get(roomId) ?? null
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

function ensureUniqueInviteCode(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateInviteCode()
    if (!roomStorage.inviteCodeExists(code)) return code
  }
  throw new Error('failed to generate unique invite code')
}

/** 若房间有活跃实例：DB 权威状态同步 + 成员广播（REST 写路径的领域内对账）。 */
function syncActiveRoom(roomId: string): void {
  const room = getRoom(roomId)
  if (!room) return
  room.syncFromDb()
  broadcastMemberMeta(roomId)
}

/** 广播 DB 权威成员列表（成员加入/绑定后）。 */
function broadcastMemberMeta(roomId: string): void {
  const room = getRoom(roomId)
  if (!room) return
  room.broadcastMembers(
    roomStorage.listMembers(roomId).map(memberRowToInfo),
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

/** 房主已索引的剧本 id 集（开局门闩用；防 KP 无原文静默空跑，ADR-0005）。
 * rag workflow 门闩：已有 embedding 索引即可。 */
function listIndexedStoriesForOwner(ownerId: number): string[] {
  try {
    return listIndexedStories(ownerId).map((s) => s.storyId)
  } catch {
    return []
  }
}

/** 房主已生成 dossiers 的剧本 id 集（dossier workflow 门闩）。 */
async function listDossiersForOwner(ownerId: number): Promise<string[]> {
  try {
    const { listDossiers } = await import('../rag/dossier/dossierCore.js')
    return (await listDossiers(ownerId)).map((d) => d.scriptId)
  } catch {
    return []
  }
}

/**
 * #55 产物期门闩判定：该剧本的降质开局提示（null = 放行）。
 * 判定走档案清单（readdir 磁盘扫描，文件名非请求输入）+ 纯函数
 * `dossierGateNotice`——REST 可达链上不引入"以请求 id 为键"的 fs 读；
 * 清单缺失/服务异常一律放行（不阻断开局，与既有 rag 分支容错风格一致）。
 */
async function dossierGateNoticeForOwner(ownerId: number, storyId: string): Promise<string | null> {
  try {
    const { listDossiers, dossierGateNotice } = await import('../rag/dossier/dossierCore.js')
    return dossierGateNotice(await listDossiers(ownerId), storyId)
  } catch {
    return null
  }
}

/** 房间行内 workflow（lobby 期由 createRoom 写入 state；列无 workflow 列，走 state JSON）。 */
function roomWorkflowFromRow(room: { state?: string | null }): StoryWorkflow {
  if (!room.state) return 'rag'
  try {
    const s = JSON.parse(room.state) as { workflow?: unknown }
    return sanitizeWorkflow(s.workflow)
  } catch {
    return 'rag'
  }
}

/** POST /api/rooms —— 创建房间（只持久化，不激活内存实例：懒激活，ADR-0001）。 */
export function createRoom(
  userId: number,
  storyId: string | null,
  opts: { workflow?: unknown } = {},
): { roomId: string; inviteCode: string } {
  const roomId = `room_${crypto.randomUUID().slice(0, 8)}`
  const inviteCode = ensureUniqueInviteCode()
  roomStorage.insertRoom(roomId, userId, inviteCode, storyId)
  roomStorage.insertMember(roomId, userId, 'owner')
  // lobby 期即定 workflow（开局门闩/实例物化按它校验），存 state。
  if (sanitizeWorkflow(opts.workflow) === 'dossier') {
    roomStorage.updateRoomStateSettings(roomId, JSON.stringify({ workflow: 'dossier' }))
  }
  return { roomId, inviteCode }
}

/** GET /api/rooms —— 我的房间列表。 */
export function listRoomsForUser(userId: number): roomStorage.RoomListItemRow[] {
  return roomStorage.listRoomsForUser(userId)
}

/** GET /api/rooms/solo —— 未结束单人局列表（继续游戏入口，ADR-0002）。 */
export function listSoloRoomsForUser(userId: number): roomStorage.SoloRoomListItemRow[] {
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
  if (workflow === 'dossier') {
    // 门闩（#55 产物期）：solo 出生即 playing、不经 startRoom——降质档案在此拦下，
    // 否则 A/B harness 与 API 调用方仍会静默拿到残档房。缺档案不在此拦（维持现状：
    // 多人 startRoom 已有「未生成」门闩，#55 只收窄「生成了但质量不足」的静默放行）。
    const notice = await dossierGateNoticeForOwner(userId, storyId)
    if (notice) return { ok: false, reason: 'conflict', message: notice }
  }
  const characterId = `char_${crypto.randomUUID().slice(0, 8)}`
  // 一体动作的六次写库包进事务：中途失败整体回滚，不留孤儿角色卡/房间
  const db = roomStorage.tx()
  db.exec('BEGIN')
  try {
    roomStorage.insertCharacter(characterId, userId, name, JSON.stringify(sheet))
    const roomId = `room_${crypto.randomUUID().slice(0, 8)}`
    const inviteCode = ensureUniqueInviteCode()
    roomStorage.insertRoom(roomId, userId, inviteCode, storyId, 'solo')
    roomStorage.insertMember(roomId, userId, 'owner')
    roomStorage.bindMemberCharacter(roomId, userId, characterId)
    // 出生即 playing（列权威）；turnWindowMs=0 进 state（ADR-0002：solo 恒严格排队，restore 时实例取 0）。
    // workflow（实验分支）一并进 state——实例物化时经 snapshot restore 读到。
    // 懒激活保持：REST 建房只持久化，不激活实例。
    roomStorage.updateRoomStart(roomId, storyId)
    roomStorage.updateRoomStateSettings(roomId, JSON.stringify(workflow === 'dossier' ? { turnWindowMs: 0, workflow: 'dossier' } : { turnWindowMs: 0 }))
    db.exec('COMMIT')
    return { ok: true, roomId, inviteCode, characterId }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** POST /api/rooms/join —— 邀请码加入（幂等：INSERT OR IGNORE）。
 *  ADR-0005：playing 后锁房——开局后邀请码不可再加入（observer 旁观留后续）。 */
export function joinRoomByInviteCode(
  userId: number,
  inviteCode: string,
): { ok: true; roomId: string } | { ok: false; reason: 'not-found' | 'conflict'; message: string } {
  const roomId = roomStorage.findRoomIdByInviteCode(inviteCode)
  if (!roomId) return { ok: false, reason: 'not-found', message: 'room not found' }
  const room = roomStorage.getRoomRow(roomId)
  if (room && room.phase !== 'lobby') {
    return { ok: false, reason: 'conflict', message: 'room already started' }
  }
  roomStorage.insertMember(roomId, userId, 'member')
  broadcastMemberMeta(roomId)
  return { ok: true, roomId }
}

/** GET /api/rooms/:id —— 房间详情（成员可见；非成员与不存在同样 404，语义同旧路由）。 */
export function getRoomDetail(
  userId: number,
  roomId: string,
): { ok: true; detail: Record<string, unknown> } | { ok: false; reason: 'not-found'; message: string } {
  if (!roomStorage.memberRole(roomId, userId)) return { ok: false, reason: 'not-found', message: 'room not found' }
  const room = roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  let state: unknown = {}
  try { state = JSON.parse(room.state) } catch { state = {} }
  return {
    ok: true,
    detail: {
      roomId: room.room_id,
      inviteCode: room.invite_code,
      storyId: room.story_id,
      phase: room.phase,
      ownerId: room.owner_id,
      members: roomStorage.listMembers(roomId).map((m) => ({
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
}

/** POST /api/rooms/:id/start —— 房主开始游戏。开局门闩（ADR-0005）：
 *  房主已选剧本 + 每名成员已绑定角色卡 → 否则 409 带缺项提示。
 *  剧本门闩按 workflow：rag 房须已索引（embedding）；dossier 房须已生成档案。
 *  就绪是软信号，开局不等待全员就绪。门闩通过 → 写库 + 活跃实例即时同步 + opening。 */
export async function startRoom(
  userId: number,
  roomId: string,
  storyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'not-owner' | 'conflict'; message: string }> {
  const g = governanceGate(userId, roomId)
  if (!g.ok) return g
  if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can start the game' }
  // 门闩 0（#54）：结束是终态——已结束的房间不得被 start 复活成 playing
  // （否则 updateRoomStart 会把 phase 列写回 playing，继续游戏入口重新列出该局）。
  if (g.room.phase === 'ended') return { ok: false, reason: 'conflict', message: '对局已结束，无法重新开始' }
  // 门闩 1：已选剧本（storyId 必填——房间创建时允许为空，开局前必须选定）
  if (!storyId) return { ok: false, reason: 'conflict', message: '请先在等待室选定剧本' }
  // 门闩 2：剧本可用（按 workflow：rag=已索引 / dossier=已生成档案）
  const workflow = roomWorkflowFromRow(g.room)
  if (workflow === 'dossier') {
    const dossiers = await listDossiersForOwner(g.room.owner_id)
    if (!dossiers.includes(storyId)) {
      return { ok: false, reason: 'conflict', message: '该剧本尚未生成档案，请先在「我的故事」中为剧本生成档案' }
    }
    // 门闩 2b（#55 产物期）：低覆盖/分节失败的残档不再静默放行。文案与「未生成
    // 档案」分开——缺档案指引生成，残档指引重生成。判定走档案清单（磁盘扫描）
    // + 纯函数：REST 可达链上不引入"以请求 id 为键"的 fs 读。
    const notice = await dossierGateNoticeForOwner(g.room.owner_id, storyId)
    if (notice) return { ok: false, reason: 'conflict', message: notice }
  } else {
    const indexed = listIndexedStoriesForOwner(g.room.owner_id)
    if (!indexed.includes(storyId)) {
      return { ok: false, reason: 'conflict', message: '该剧本尚未索引，请先在「我的故事」中完成索引' }
    }
  }
  // 门闩 3：每名成员已绑定角色卡（不等待就绪——软信号）
  const members = roomStorage.listMembers(roomId)
  const unbound = members.filter((m) => !m.character_id)
  if (unbound.length > 0) {
    return {
      ok: false,
      reason: 'conflict',
      message: `${unbound.length} 名成员未绑定角色卡${unbound.length > 0 ? `（${unbound.map((m) => m.username).join('、')}）` : ''}`,
    }
  }
  roomStorage.updateRoomStart(roomId, storyId)
  syncActiveRoom(roomId)
  // opening 回合（ADR-0002）：实例已激活则立即触发；未激活时随首次 join 触发（懒激活保持）。
  getRoom(roomId)?.beginOpeningIfPending()
  return { ok: true }
}

/** POST /api/rooms/:id/character —— 绑定角色卡（一人一卡，Phase B4）。 */
export function bindRoomCharacter(
  userId: number,
  roomId: string,
  characterId: string,
): { ok: true; roomId: string; characterId: string } | { ok: false; reason: 'not-found' | 'conflict'; message: string } {
  if (!roomStorage.memberRole(roomId, userId)) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (roomStorage.characterOwnerUserId(characterId) !== userId) {
    return { ok: false, reason: 'not-found', message: 'character not found' }
  }
  if (roomStorage.boundMemberOf(roomId, characterId, userId) !== null) {
    return { ok: false, reason: 'conflict', message: 'character already bound to another member' }
  }
  roomStorage.bindMemberCharacter(roomId, userId, characterId)
  syncActiveRoom(roomId)
  // T4 #31：换绑后广播新绑定卡 sheet（room_meta 只带 member.characterId；
  // characters.<id> 走 state_patch——客户端档案区/队友卡依赖此通道）。
  // 定向发本卡：幂等（绑同卡重复调用也只会同步一份权威 sheet）。
  const active = getRoom(roomId)
  const sheet = active?.getCharacter(characterId) ?? null
  if (active && sheet) {
    active.emitSheetPatch(characterId, sheet)
  }
  return { ok: true, roomId, characterId }
}

/** 校验回合窗口值（0..60000），非法返回 null。 */
function sanitizeTurnWindowMs(value: unknown): number | null {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return null
  return Math.floor(ms)
}

/** PUT /api/rooms/:id/settings —— 房主改 turnWindowMs（写库 + 活跃实例立即生效并广播）。 */
export function setRoomTurnWindow(
  userId: number,
  roomId: string,
  rawTurnWindowMs: unknown,
): { ok: true; turnWindowMs?: number } | { ok: false; reason: 'not-found' | 'not-owner' | 'bad-request'; message: string } {
  const room = roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (room.owner_id !== userId) return { ok: false, reason: 'not-owner', message: 'only the owner can change room settings' }
  // ADR-0002：solo 房间回合窗口恒为 0（单成员无需合并缓冲），不可设置
  if (room.kind === 'solo') return { ok: false, reason: 'bad-request', message: 'solo rooms have a fixed turn window of 0' }
  let state: Record<string, unknown> = {}
  try { state = JSON.parse(room.state) as Record<string, unknown> } catch { state = {} }
  let ms: number | undefined
  if (rawTurnWindowMs !== undefined) {
    const sanitized = sanitizeTurnWindowMs(rawTurnWindowMs)
    if (sanitized === null) return { ok: false, reason: 'bad-request', message: 'turnWindowMs must be 0..60000' }
    state.turnWindowMs = sanitized
    ms = sanitized
  }
  roomStorage.updateRoomStateSettings(roomId, JSON.stringify(state))
  const active = getRoom(roomId)
  if (active && typeof ms === 'number') active.setTurnWindowMs(ms)
  return { ok: true, turnWindowMs: ms }
}

/** DELETE /api/rooms/:id —— 房主解散。 */
export function deleteRoomAsOwner(
  userId: number,
  roomId: string,
): { ok: true } | { ok: false; reason: 'not-found' | 'not-owner'; message: string } {
  const room = roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (room.owner_id !== userId) return { ok: false, reason: 'not-owner', message: 'only the owner can dissolve the room' }
  roomStorage.deleteRoomRows(roomId)
  return { ok: true }
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
function governanceGate(
  userId: number,
  roomId: string,
  targetUserId?: number,
): { ok: true; room: roomStorage.RoomRow; callerRole: string | null } | { ok: false; reason: 'not-found' | 'not-owner' | 'conflict'; message: string } {
  const room = roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (room.kind !== 'multi') return { ok: false, reason: 'conflict', message: 'governance actions require a multiplayer room' }
  if (targetUserId !== undefined) {
    if (!roomStorage.memberRole(roomId, targetUserId)) return { ok: false, reason: 'not-found', message: 'member not found' }
  }
  const callerRole = roomStorage.memberRole(roomId, userId)
  if (!callerRole) return { ok: false, reason: 'not-found', message: 'room not found' }
  return { ok: true, room, callerRole }
}

/** POST /api/rooms/:id/ready —— 成员就绪/取消（ADR-0005 软信号；owner 不持有 ready）。
 *  role='member' 的 UPDATE 天然保护 owner；重复设置幂等。就绪在开局（playing）后无意义，忽略之。 */
export function setMemberReady(
  userId: number,
  roomId: string,
  ready: boolean,
): { ok: true } | RoomGovernanceFail {
  const g = governanceGate(userId, roomId)
  if (!g.ok) return g
  if (g.callerRole === 'owner') return { ok: false, reason: 'not-owner', message: 'only members can toggle ready' }
  if (g.room.phase !== 'lobby') return { ok: true } // playing 后就绪无意义：幂等成功
  roomStorage.setMemberReady(roomId, userId, ready)
  syncActiveRoom(roomId)
  return { ok: true }
}

/** POST /api/rooms/:id/leave —— 成员主动离开（删行 + 广播；owner 离开走转让/解散）。
 *  替代旧 ws room:leave 只退订不删行（成员列表只增不减的缺口，ADR-0005）。 */
export function leaveRoomAsMember(
  userId: number,
  roomId: string,
): { ok: true } | RoomGovernanceFail {
  const g = governanceGate(userId, roomId)
  if (!g.ok) return g
  if (g.callerRole === 'owner') return leaveRoomAsOwner(userId, roomId)
  roomStorage.deleteMemberRow(roomId, userId)
  broadcastMemberMeta(roomId)
  return { ok: true }
}

/** 房主离开的领域动作：还有成员 → 立即转让给最早成员（rowid 序）；否则解散（ADR-0005 无宽限）。 */
export function leaveRoomAsOwner(
  userId: number,
  roomId: string,
): { ok: true } | RoomGovernanceFail {
  const g = governanceGate(userId, roomId)
  if (!g.ok) return g
  if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can dissolve the room' }
  const members = roomStorage.listMembersOrdered(roomId)
  const successor = members.find((m) => m.user_id !== userId)
  if (!successor) {
    roomStorage.deleteRoomRows(roomId)
    return { ok: true }
  }
  transferOwnerRow(roomId, userId, successor.user_id)
  syncActiveRoom(roomId)
  return { ok: true }
}

/** 转让房主行写库（新 owner 行 role='owner' + ready 清零；旧 owner 行降为 member 且留在房内）。 */
function transferOwnerRow(roomId: string, oldOwnerId: number, newOwnerId: number): void {
  roomStorage.transferRoomOwnership(roomId, oldOwnerId, newOwnerId)
}

/** DELETE /api/rooms/:id/members/:userId —— 房主踢出成员（owner only；删行 + 广播；不可踢自己/owner）。 */
export function kickRoomMember(
  callerUserId: number,
  roomId: string,
  targetUserId: number,
): { ok: true } | RoomGovernanceFail {
  const g = governanceGate(callerUserId, roomId, targetUserId)
  if (!g.ok) return g
  if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can kick members' }
  if (callerUserId === targetUserId) return { ok: false, reason: 'bad-request', message: 'owner cannot kick themselves' }
  roomStorage.deleteMemberRow(roomId, targetUserId)
  broadcastMemberMeta(roomId)
  return { ok: true }
}

/** POST /api/rooms/:id/transfer —— 房主主动转让给指定成员（新 owner 获得治理权）。 */
export function transferOwnership(
  callerUserId: number,
  roomId: string,
  targetUserId: number,
): { ok: true } | RoomGovernanceFail {
  const g = governanceGate(callerUserId, roomId, targetUserId)
  if (!g.ok) return g
  if (g.callerRole !== 'owner') return { ok: false, reason: 'not-owner', message: 'only the owner can transfer ownership' }
  if (callerUserId === targetUserId) return { ok: false, reason: 'bad-request', message: 'target is already the owner' }
  transferOwnerRow(roomId, callerUserId, targetUserId)
  syncActiveRoom(roomId)
  return { ok: true }
}

/** 房主 WS 断线（无 REST 语义）：立即转让给最早成员 / 无其他成员解散（ADR-0005 无宽限）。
 *  供 ws 层断线事件调用——仅当脱机的正是当前 owner 时执行（非 owner 断线不动房间；
 *  刷新即易主是已知取舍）。solo 房主断线不转让（单人房主=唯一成员，solo 无等待室）。 */
export function handleOwnerWsDisconnect(roomId: string, userId: number): void {
  const room = roomStorage.getRoomRow(roomId)
  if (!room || room.phase === 'ended') return
  if (room.kind !== 'multi' || room.owner_id !== userId) return
  const members = roomStorage.listMembersOrdered(roomId)
  const successor = members.find((m) => m.user_id !== userId)
  if (!successor) {
    roomStorage.deleteRoomRows(roomId)
    return
  }
  transferOwnerRow(roomId, userId, successor.user_id)
  syncActiveRoom(roomId)
}

/** WS join：校验成员资格并返回活跃实例（不存在则 materialize——懒激活）。 */
export function joinRoom(roomId: string, userId: number, username: string): RoomService | null {
  if (!roomStorage.isRoomMember(roomId, userId)) return null
  const room = getRoom(roomId) ?? getOrCreateRoom(roomId, userId, username)
  room.beginOpeningIfPending()
  return room
}

/** WS 成员资格 gate（sync/action 帧用）。 */
export function isRoomMember(roomId: string, userId: number): boolean {
  return roomStorage.isRoomMember(roomId, userId)
}

/** 回收过期房间（TTL 扫描，进程启动时定期调用）。 */
export function reapStaleRooms(): void {
  const now = Date.now()
  for (const [id, room] of roomRegistry) {
    if (room.isStale()) {
      void room.persistSnapshot().finally(() => {
        room.dispose()
        roomRegistry.delete(id)
      })
    }
  }
}

/** 定期回收（测试可注入间隔；默认 60s）。 */
export function startRoomReaper(intervalMs = 60_000): NodeJS.Timeout {
  const t = setInterval(reapStaleRooms, intervalMs)
  t.unref?.()
  return t
}

/** 供测试：清空注册表。 */
export function _clearRoomRegistryForTests(): void {
  for (const room of roomRegistry.values()) room.dispose()
  roomRegistry.clear()
}

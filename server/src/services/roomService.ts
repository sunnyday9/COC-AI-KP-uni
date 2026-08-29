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
import * as roomStorage from './roomStorage.js'
import { createCharacterMutatorFactory } from '../rule-engine/characterMutators.js'
import { buildRoomTurnMessages, buildRoomOpeningMessages, OPENING_RAG_QUERY, MAX_MEMORY_ENTRIES, type RoomPromptInput } from './kpPromptService.js'
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
  readonly ownerId: number
  readonly ownerName: string

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
      this.kpMemory = Array.isArray(opts.restore.kpMemory) ? opts.restore.kpMemory : []
      this.longTermSummary = typeof opts.restore.longTermSummary === 'string' ? opts.restore.longTermSummary : ''
    }
    this.snapshotTimer = setInterval(() => void this.maybeSnapshot(), SNAPSHOT_EVERY_MS)
    this.snapshotTimer.unref?.()
  }

  /* ═══════════════ 查询（只读，无需入队） ═══════════════ */

  getPhase(): RoomPhase { return this.phase }
  getSeq(): number { return this.seq }
  getStoryId(): string | null { return this.storyId }
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
    this.emit({ type: 'state_patch', payload: { path: 'ending', value: ending } })
    this.emit({ type: 'room_meta', payload: { phase: 'ended', turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  /** 设置房间阶段（room_meta）。 */
  setPhase(phase: RoomPhase): void {
    this.phase = phase
    this.emit({ type: 'room_meta', payload: { phase, turnWindowMs: this.turnWindowMs, members: this.membersFromDb() } })
  }

  /** 广播成员列表（room_meta）——成员加入/离开/绑定角色后调用（Phase C2）。 */
  broadcastMembers(members: RoomMember[]): void {
    this.emit({ type: 'room_meta', payload: { phase: this.phase, turnWindowMs: this.turnWindowMs, members } })
  }

  /** 从 DB 加载成员列表（room_meta 事件携带真实 members，避免清空客户端列表——审查修复）。 */
  private membersFromDb(): RoomMember[] {
    return roomStorage.listMembers(this.roomId).map((r) => ({
      userId: r.user_id,
      username: r.username,
      role: r.role as MemberRole,
      characterId: r.character_id,
    }))
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

  /** 角色卡归属查询（D5：工具 characterId 归属校验）。 */
  characterOwnerOf(characterId: string): number | null {
    return this.characterOwner.get(characterId) ?? null
  }

  /** 取房间角色组（characterId → sheet，供 KP 回合）。 */
  getCharacterMap(): Record<string, COCCharacterSheet> {
    return Object.fromEntries(this.characters)
  }

  /* ═══════════════ 回合窗口合并（D4） ═══════════════ */

  /** 玩家聊天（领域方法，ADR-0001）：解析身份 → 消息流广播 → 回合缓冲。 */
  submitPlayerChat(userId: number, content: string): void {
    const username = roomStorage.usernameOf(userId) ?? `user_${userId}`
    const characterId = roomStorage.memberCharacterId(this.roomId, userId)
    this.appendMessage(
      { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'player', playerName: username, content },
      { userId, roleName: username },
    )
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
      const [ragContext, storyName] = await Promise.all([this.fetchRagContext(merged), this.fetchStoryName()])
      const chatMessages = buildRoomTurnMessages(
        this.promptInput(storyName, this.messages.slice(0, historyEnd)),
        ragContext,
        merged,
      )
      await this.runKpTurnForRoom(
        this.ownerId,
        chatMessages,
        this.storyId ? { scriptId: this.storyId, sceneId: this.scene ?? undefined } : null,
        activeCharacterId,
        () => { /* 流式块：可扩展为 kp:chunk 帧 */ },
        allowedCharacterIds,
      )
    } finally {
      this.turnFlushing = false
      // 审查修复：flush 期间到达的新消息补触发（否则挂起到下一条消息）
      if (this.turnBuffer.length > 0) {
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
  async runKpTurnForRoom(
    ownerUserId: number,
    messages: unknown[],
    storyContext: Record<string, unknown> | null,
    activeCharacterId: string | null,
    onChunk: (chunk: string) => void,
    allowedCharacterIds?: Set<string>,
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
          onError: () => { /* 回合错误由调用方处理（不中断房间） */ },
        },
      },
    )
  }

  /* ═══════════════ 上下文注入与记忆（ADR-0002，服务端收口） ═══════════════ */

  /** RAG 检索上下文（失败回退 ''——回合不因检索中断）。 */
  private async fetchRagContext(query: string): Promise<string> {
    if (!this.storyId) return ''
    try {
      const { context } = await import('./ragService.js')
      const res = await context(this.ownerId, { query, scriptId: this.storyId, sceneId: this.scene ?? undefined, topK: 8 })
      return res?.context || ''
    } catch {
      return ''
    }
  }

  /** 剧本名（rag 索引清单；失败回退 ''）。 */
  private async fetchStoryName(): Promise<string> {
    if (!this.storyId) return ''
    try {
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

  /**
   * opening 回合（ADR-0002）：startRoom / 首次 join 时触发一次。
   * 失败不阻塞进入——首回合不是门闩，玩家消息照常触发回合（flushTurn 路径独立）。
   */
  beginOpeningIfPending(): void {
    if (this.openingStarted || this.phase !== 'playing' || this.messages.length > 0) return
    this.openingStarted = true
    void this.runOpeningTurn()
  }

  private async runOpeningTurn(): Promise<void> {
    try {
      const [ragContext, storyName] = await Promise.all([this.fetchRagContext(OPENING_RAG_QUERY), this.fetchStoryName()])
      const chatMessages = buildRoomOpeningMessages(this.promptInput(storyName, this.messages), ragContext)
      const firstCharacterId = [...this.characters.keys()][0] ?? null
      await this.runKpTurnForRoom(
        this.ownerId,
        chatMessages,
        this.storyId ? { scriptId: this.storyId, sceneId: this.scene ?? undefined } : null,
        firstCharacterId,
        () => { /* 流式块：可扩展为 kp:chunk 帧 */ },
      )
    } catch {
      // opening 失败不阻塞（ADR-0002）
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
    roomStorage.listMembers(roomId).map((m) => ({
      userId: m.user_id,
      username: m.username,
      role: m.role as MemberRole,
      characterId: m.character_id,
    })),
  )
}

/** POST /api/rooms —— 创建房间（只持久化，不激活内存实例：懒激活，ADR-0001）。 */
export function createRoom(userId: number, storyId: string | null): { roomId: string; inviteCode: string } {
  const roomId = `room_${crypto.randomUUID().slice(0, 8)}`
  const inviteCode = ensureUniqueInviteCode()
  roomStorage.insertRoom(roomId, userId, inviteCode, storyId)
  roomStorage.insertMember(roomId, userId, 'owner')
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

/** POST /api/rooms/solo —— 单人开局一体领域动作（ADR-0002）：落角色卡 + 建 solo 房 + 绑卡 + start。 */
export function createSoloRoom(
  userId: number,
  input: { storyId: unknown; name: unknown; sheet: unknown },
): { ok: true; roomId: string; inviteCode: string; characterId: string } | { ok: false; reason: 'bad-request'; message: string } {
  const storyId = typeof input?.storyId === 'string' ? input.storyId.trim() : ''
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const sheet = input?.sheet as COCCharacterSheet | undefined
  if (!storyId) return { ok: false, reason: 'bad-request', message: 'storyId required' }
  if (!name) return { ok: false, reason: 'bad-request', message: 'name required' }
  if (!sheet || typeof sheet !== 'object' || !sheet.derived) {
    return { ok: false, reason: 'bad-request', message: 'sheet required (COCCharacterSheet)' }
  }
  const characterId = `char_${crypto.randomUUID().slice(0, 8)}`
  roomStorage.insertCharacter(characterId, userId, name, JSON.stringify(sheet))
  const roomId = `room_${crypto.randomUUID().slice(0, 8)}`
  const inviteCode = ensureUniqueInviteCode()
  roomStorage.insertRoom(roomId, userId, inviteCode, storyId, 'solo')
  roomStorage.insertMember(roomId, userId, 'owner')
  roomStorage.bindMemberCharacter(roomId, userId, characterId)
  // 出生即 playing（列权威）；turnWindowMs=0 进 state（ADR-0002：solo 恒严格排队，restore 时实例取 0）。
  // 懒激活保持：REST 建房只持久化，不激活实例。
  roomStorage.updateRoomStart(roomId, storyId)
  roomStorage.updateRoomStateSettings(roomId, JSON.stringify({ turnWindowMs: 0 }))
  return { ok: true, roomId, inviteCode, characterId }
}

/** POST /api/rooms/join —— 邀请码加入（幂等：INSERT OR IGNORE）。 */
export function joinRoomByInviteCode(
  userId: number,
  inviteCode: string,
): { ok: true; roomId: string } | { ok: false; reason: 'not-found'; message: string } {
  const roomId = roomStorage.findRoomIdByInviteCode(inviteCode)
  if (!roomId) return { ok: false, reason: 'not-found', message: 'room not found' }
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
      })),
      state,
      createdAt: room.created_at,
    },
  }
}

/** POST /api/rooms/:id/start —— 房主开始游戏（绑定剧本 + 活跃实例即时同步）。 */
export function startRoom(
  userId: number,
  roomId: string,
  storyId: string,
): { ok: true } | { ok: false; reason: 'not-found' | 'not-owner' | 'bad-request'; message: string } {
  const room = roomStorage.getRoomRow(roomId)
  if (!room) return { ok: false, reason: 'not-found', message: 'room not found' }
  if (room.owner_id !== userId) return { ok: false, reason: 'not-owner', message: 'only the owner can start the game' }
  if (!storyId) return { ok: false, reason: 'bad-request', message: 'storyId required' }
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

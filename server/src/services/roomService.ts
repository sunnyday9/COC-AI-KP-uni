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
import { getDb } from '../db/index.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'

/** 房间阶段。 */
export type RoomPhase = 'lobby' | 'playing' | 'ended'

/** 房间成员角色。 */
export type MemberRole = 'owner' | 'member' | 'observer'

export interface RoomMember {
  userId: number
  username: string
  role: MemberRole
  characterId: string | null
}

/** 房间事件（全序，seq 由 RoomService 串行分配）。 */
export type RoomEvent =
  | { type: 'message_appended'; payload: { pendingId?: string; author: { userId: number; roleName: string }; content: string; kind: string } }
  | { type: 'state_patch'; payload: { path: string; value: unknown } }
  | { type: 'dice_result'; payload: { rolls: number[]; expr: string; displayText: string } }
  | { type: 'room_meta'; payload: { phase: RoomPhase; turnWindowMs: number; members: RoomMember[] } }
  | { type: 'trace'; payload: { traceEvents: unknown[] } }

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
  private seq = 0
  private eventCountSinceSnapshot = 0
  private lastSnapshotAt = Date.now()
  private lastActivityAt = Date.now()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(event: RoomEvent) => void>()
  /** 事件日志（Phase C1）：带 seq 的增量事件，环形保留最近 MAX_EVENT_LOG 条。 */
  private eventLog: { seq: number; event: RoomEvent }[] = []
  private eventLogStartSeq = 0
  private snapshotTimer: NodeJS.Timeout | null = null
  /** 回合窗口（D4）：缓冲窗口内玩家消息，超时合并进一次 KP 回合。 */
  private turnBuffer: { username: string; content: string; characterId: string | null }[] = []
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
      updatedAt: Date.now(),
    }
  }

  /** 订阅房间事件（增量广播）。返回取消函数。 */
  subscribe(listener: (event: RoomEvent) => void): () => void {
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
      try { l(event) } catch { /* 监听器错误不影响广播 */ }
    }
  }

  /** 增量事件（lastSeq 之后；返回 null 表示缺口过大需全量快照）。
   * lastSeq=0（客户端无状态）或 < 日志起始 seq → 全量。 */
  getEventsSince(lastSeq: number): { seq: number; event: RoomEvent }[] | null {
    if (lastSeq < this.eventLogStartSeq) return null
    return this.eventLog.filter((e) => e.seq > lastSeq)
  }

  /* ═══════════════ 动作处理 ═══════════════ */

  /** 追加玩家/KP 消息并广播（message_appended）。 */
  appendMessage(msg: Message, author: { userId: number; roleName: string }): void {
    this.messages.push(msg)
    this.emit({
      type: 'message_appended',
      payload: { pendingId: msg.id, author, content: msg.content, kind: msg.role },
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

  /** 场景切换（state_patch）。 */
  setScene(sceneName: string): void {
    this.scene = sceneName
    this.emit({ type: 'state_patch', payload: { path: 'scene', value: sceneName } })
  }

  /** 结局（state_patch + phase 变更）。 */
  setEnding(ending: unknown): void {
    this.ending = ending
    this.phase = 'ended'
    this.emit({ type: 'state_patch', payload: { path: 'ending', value: ending } })
    this.emit({ type: 'room_meta', payload: { phase: 'ended', turnWindowMs: this.turnWindowMs, members: [] } })
  }

  /** 设置房间阶段（room_meta）。 */
  setPhase(phase: RoomPhase): void {
    this.phase = phase
    this.emit({ type: 'room_meta', payload: { phase, turnWindowMs: this.turnWindowMs, members: [] } })
  }

  /** 广播成员列表（room_meta）——成员加入/离开/绑定角色后调用（Phase C2）。 */
  broadcastMembers(members: RoomMember[]): void {
    this.emit({ type: 'room_meta', payload: { phase: this.phase, turnWindowMs: this.turnWindowMs, members } })
  }

  /** 开始游戏（lobby → playing，绑定剧本）。 */
  startGame(storyId: string): void {
    this.storyId = storyId
    this.phase = 'playing'
    this.emit({ type: 'room_meta', payload: { phase: 'playing', turnWindowMs: this.turnWindowMs, members: [] } })
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

  /** 玩家消息进回合缓冲（聊天即时广播；KP 回合等窗口超时合并执行）。 */
  bufferPlayerChat(username: string, content: string, characterId: string | null): void {
    this.turnBuffer.push({ username, content, characterId })
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
      await this.runKpTurnForRoom(
        this.ownerId,
        [
          { role: 'system', content: '你是这个房间的守秘人（KP）。房间内有多名调查员，请分别回应他们的行动。' },
          { role: 'user', content: merged },
        ],
        this.storyId ? { scriptId: this.storyId, sceneId: this.scene ?? undefined } : null,
        activeCharacterId,
        () => { /* 流式块：可扩展为 kp:chunk 帧 */ },
      )
    } finally {
      this.turnFlushing = false
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
  ): Promise<void> {
    const { runKpTurn } = await import('./kpTurnService.js')
    const characterMap = this.getCharacterMap()

    // mutators：按 characterId 路由到目标角色卡（D5）；缺省 → 行动者
    const mutate = (characterId: string | null, fn: (sheet: COCCharacterSheet) => void): void => {
      const target = characterId ?? activeCharacterId
      const sheet = target ? this.characters.get(target) : null
      if (sheet) {
        fn(sheet)
        this.emit({ type: 'state_patch', payload: { path: `characters.${target}`, value: sheet } })
      }
    }
    const makeCharacterMutators = (characterId: string | null) => ({
      updateCharacterHP: (delta: number) => mutate(characterId, (s) => { if (s.derived) s.derived.hp = Math.max(0, (s.derived.hp ?? 0) + delta) }),
      updateCharacterMP: (delta: number) => mutate(characterId, (s) => { if (s.derived) s.derived.mp = Math.max(0, (s.derived.mp ?? 0) + delta) }),
      updateCharacterSAN: (delta: number) => mutate(characterId, (s) => { if (s.derived) s.derived.san = Math.max(0, (s.derived.san ?? 0) + delta) }),
      updateCharacterLuck: (delta: number) => mutate(characterId, (s) => { if (s.attributes) s.attributes.luck = Math.max(0, (s.attributes.luck ?? 0) + delta) }),
      addCharacterDailySanLoss: (amount: number) => mutate(characterId, (s) => { s.dailySanLoss = (s.dailySanLoss ?? 0) + amount }),
      resetCharacterDailySanLoss: () => mutate(characterId, (s) => { s.dailySanLoss = 0 }),
      updateCharacterInsanityState: (state: 'normal' | 'temporary' | 'indefinite' | 'permanent', phobias?: string[], manias?: string[]) =>
        mutate(characterId, (s) => {
          s.insanityState = state
          if (phobias) s.phobias = phobias
          if (manias) s.manias = manias
        }),
      setCharacterMajorWound: (v: boolean) => mutate(characterId, (s) => { s.hasMajorWound = v }),
      setCharacterDying: (v: boolean) => mutate(characterId, (s) => { s.isDying = v }),
      growCharacterSkill: (skillId: string, newValue: number) => mutate(characterId, (s) => { if (s.skills) s.skills[skillId] = newValue }),
      increaseCthulhuMythos: (gain: number) => mutate(characterId, (s) => { s.cthulhuMythos = (s.cthulhuMythos ?? 0) + gain }),
      transitionToScene: (sceneName: string) => this.setScene(sceneName),
      addClue: (description: string, clueId?: string) => this.addClue(description, clueId),
      endGame: (ending: { outcome: string; title: string; summary: string; epilogueOptions?: string[]; keyFacts?: string[]; keyTurnIds?: string[] }) => this.setEnding(ending),
      generateId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    })

    const activeSheet = activeCharacterId ? this.characters.get(activeCharacterId) ?? null : null
    await runKpTurn(
      ownerUserId,
      { messages, storyContext },
      characterMap,
      activeCharacterId,
      makeCharacterMutators(activeCharacterId),
      {
        onChunk,
        onEnd: (result) => {
          // KP 回复追加消息流
          if (result.content?.trim()) {
            this.appendMessage(
              { id: `kp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), role: 'kp', content: result.content },
              { userId: ownerUserId, roleName: 'KP' },
            )
          }
          // 工具展示消息（骰子/系统提示）追加消息流
          for (const dm of result.displayMessages ?? []) {
            this.appendMessage(dm as Message, { userId: ownerUserId, roleName: 'KP' })
          }
          void activeSheet
        },
        onError: () => { /* 回合错误由调用方处理（不中断房间） */ },
      },
      makeCharacterMutators, // D5：按 characterId 分派变更应用器
    )
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
    const snap = this.snapshot()
    getDb()
      .prepare(`UPDATE rooms SET state = ?, version = version + 1, updated_at = ? WHERE room_id = ?`)
      .run(JSON.stringify(snap), Date.now(), this.roomId)
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
    const row = getDb()
      .prepare(`SELECT state FROM rooms WHERE room_id = ?`)
      .get(roomId) as { state: string } | undefined
    let restore: RoomSnapshot | null = null
    if (row?.state) {
      try { restore = JSON.parse(row.state) as RoomSnapshot } catch { restore = null }
    }
    room = new RoomService({ roomId, ownerId, ownerName, storyId, restore })
    roomRegistry.set(roomId, room)
  }
  return room
}

/** 获取房间（不存在返回 null）。 */
export function getRoom(roomId: string): RoomService | null {
  return roomRegistry.get(roomId) ?? null
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

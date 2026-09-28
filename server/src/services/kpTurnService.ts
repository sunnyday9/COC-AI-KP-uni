/**
 * kpTurnService — 服务端图内工具循环（Phase A2，架构方案 v2.0 D3）。
 *
 * 将原来客户端 kpSessionService.runKpAgentLoop 的多轮「invoke → 客户端执行工具
 * → 回传结果」循环整体下沉到服务端：
 *   - 图执行：复用 kpAgentService.buildInvokeLLM / getSharedGraph（图缓存命中，
 *     工具链不再每次重建图）；
 *   - 工具执行：复用 rule-engine（processToolCalls + buildToolContext），角色卡
 *     更新回调由本服务维护（sessionCharacter 快照）；
 *   - 一次 runKpTurn 调用内完成 ≤8 轮，LLM 工具结果不再经网络往返；
 *   - 工具结果摘要/截断策略原样保留（防长链劣化）。
 */
import { isKpChunkStreamEnabled } from '../config.js'
import { getAiConfig } from './settingsService.js'
import { processToolCalls } from '../rule-engine/orchestrator.js'
import { buildToolContext } from '../rule-engine/toolContextFactory.js'
import { COC_KP_TOOLS } from '../../../shared/tools/cocTools.js'
import { STORY_LOOKUP_TOOLS, STORY_LOOKUP_TOOL_NAMES } from '../../../shared/tools/storyLookupTools.js'
import type { InvokeLLM, KpMessage, KpToolCall } from '../agent/kpGraph.js'
import type { ToolCall } from '../rule-engine/types.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import { recordKpWireSample, type KpWireSampleIteration, type KpWireSamplingMeta } from './wireSampleService.js'
import { injectCharacterRoster } from './kpPromptService.js'
// 工具循环上限 + 结果回填/工具调用 wire 形态单源：离线 distill replay 直引同一实现（票 #75/#83）
import { MAX_TOOL_ITERATIONS, summarizeToolResult, toOpenAiToolCall, truncateToolResult } from './kpTurnWireShape.js'

/** 把角色花名册注入 messages 的 system 消息（B5）——实现随花名册块迁入 kpPromptService，此处再导出保持原导入面。 */
export { buildCharacterRosterPrompt, injectCharacterRoster } from './kpPromptService.js'

/** 服务端执行工具回调：角色卡更新通过 mutators 应用到 session 持有的快照。 */
export interface TurnCharacterMutators {
  updateCharacterHP(delta: number): void
  updateCharacterMP(delta: number): void
  updateCharacterSAN(delta: number): void
  updateCharacterLuck(delta: number): void
  addCharacterDailySanLoss(amount: number): void
  resetCharacterDailySanLoss(): void
  updateCharacterInsanityState(
    state: 'normal' | 'temporary' | 'indefinite' | 'permanent',
    phobias?: string[],
    manias?: string[],
  ): void
  setCharacterMajorWound(hasMajorWound: boolean): void
  setCharacterDying(isDying: boolean): void
  growCharacterSkill(skillId: string, newValue: number): void
  increaseCthulhuMythos(gain: number): void
  transitionToScene(sceneName: string): void
  addClue(description: string, clueId?: string): void
  endGame(ending: {
    outcome: string
    title: string
    summary: string
    epilogueOptions?: string[]
    keyFacts?: string[]
    keyTurnIds?: string[]
  }): void
  /** 生成消息/骰子展示 id。 */
  generateId(): string
}

export interface KpTurnHandlers {
  /** 流式叙事块（WS chunk 帧）。 */
  onChunk: (chunk: string) => void
  /** 工具执行事件（trace 帧/日志）。 */
  onToolExecuted?: (info: { name: string; args: Record<string, unknown>; resultSummary: string; success: boolean; durationMs: number }) => void
  /** 循环结束（end 帧）：content + 工具展示消息 + 执行过的工具调用 + 世界增量 + 更新后的角色卡。 */
  onEnd: (result: {
    content: string
    displayMessages: Message[]
    toolCalls: { id: string; name: string; arguments: string }[]
    /** 服务端工具执行产生的世界增量（线索/场景/结局），客户端据此对账。 */
    worldDeltas: {
      cluesAdded: { description: string; clueId?: string }[]
      sceneChanged?: string
      ending?: { outcome: string; title: string; summary: string; epilogueOptions?: string[]; keyFacts?: string[]; keyTurnIds?: string[] }
    }
    characterSheet: COCCharacterSheet | null
  }) => void
  onError: (error: string) => void
}

/**
 * 运行一整个回合：图执行 + 服务端工具循环。
 * @param characters 房间角色组（characterId → sheet；多人模式多卡，单人单卡）
 * @param activeCharacterId 当前行动者（工具缺省 characterId 的回退目标；null = 无角色）
 * @param mutators 角色卡变更应用器（由会话/房间执行器实现）
 * @param characterMutatorFactory 按 characterId 构造变更应用器（D5 多角色分派）；
 *        缺省时全部工具作用于 mutators（单卡/兼容路径）
 * @param allowedCharacterIds 归属校验（D5）：工具 characterId 必须在此集内，
 *        否则回退行动者（防跨角色篡改）；缺省 = 不限制（单卡路径）
 */
/** 一个回合的执行依赖（评审候选 1：8 位置参收窄为对象）。 */
export interface KpTurnDeps {
  /** 角色组（characterId → sheet；多人多卡，单人单卡） */
  characters: Record<string, COCCharacterSheet> | null
  /** 当前行动者（工具缺省 characterId 的回退目标；null = 无角色） */
  activeCharacterId: string | null
  /** 变更应用器工厂（characterMutators.createCharacterMutatorFactory 产出——15 个变更语义的唯一实现） */
  mutatorFactory: (characterId: string | null) => TurnCharacterMutators
  /** 归属校验（D5）：工具 characterId 必须在此集内，否则回退行动者（防跨角色篡改）；缺省 = 不限制（单卡路径） */
  allowedCharacterIds?: Set<string>
  /** wire 采样元数据（T1，spec #36「唯一新缝」）：提供且回合完整完成（图未中断、
   *  产生了最终叙事）时，把完整 wire 消息序列落库（见 wireSampleService）。 */
  sampling?: KpWireSamplingMeta
  /** dossier workflow（实验分支）：注入剧本档案查证函数。提供时查证工具
   *  (scene_list / scene_dossier / lexical_search) 在工具循环内特判执行，
   *  并把它们并入下发 LLM 的工具集。缺省 = rag workflow（无查证工具）。 */
  storyLookup?: (toolName: string, args: Record<string, unknown>) => Promise<{ content: string }>
  /** Guard each graph call and discard stale results if ownership changes mid-turn. */
  isOwnerCurrent?: () => boolean
  /** Preserve the player's action and retry it with the successor's AI identity. */
  onOwnerChanged?: () => void
  handlers: KpTurnHandlers
}

function getObtainedClueIds(storyContext: Record<string, unknown> | null | undefined): string[] {
  const openClues = storyContext?.openClues
  if (!Array.isArray(openClues)) return []
  const ids: string[] = []
  for (const clue of openClues) {
    const id = typeof clue === 'string'
      ? clue
      : clue && typeof clue === 'object' ? (clue as { id?: unknown }).id : undefined
    if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

type StructuredTerminalEnding = {
  name?: unknown
  condition?: unknown
  outcome?: unknown
  relatedTruths?: unknown
}

const TERMINAL_COMPLETION_SIGNALS = [
  { phrase: /(?:真相大白|真相揭晓)/, metadata: /真相|揭晓|秘密/, outcome: 'victory' },
  { phrase: /(?:破坏|摧毁|阻止|终止)(?:了)?仪式/, metadata: /仪式/, outcome: 'victory' },
  { phrase: /(?:成功逃离|成功逃出|逃出生天)/, metadata: /逃离|逃出|逃生|脱出/, outcome: 'survival' },
  { phrase: /(?:团灭|全员死亡|调查员全灭)/, metadata: /团灭|全灭|全员死亡|调查员.{0,6}(?:死亡|阵亡)/, outcome: 'defeat' },
  { phrase: /(?:永久疯狂|永久性精神错乱|永久失去理智)/, metadata: /永久.{0,4}(?:疯狂|精神错乱|失去理智)/, outcome: 'defeat' },
  { phrase: /(?:结束冒险|冒险完结|故事结束|故事完结|调查结束|终止游戏|到此为止)/, metadata: /结束|完结|结局|终止|封存/, outcome: 'unknown' },
] as const

const PREMATURE_ENDING_PREFIX = /(?:没有成功|还没有|并没有|并未|从未|未曾|不曾|没能|未能|尚未|还没|没有|不可能|无法|不能|未|没|不|准备|打算|计划|尝试|试图|希望|想(?:要)?|要(?:去)?|必须|需要|如果|未完成)$/
const PREMATURE_ENDING_SUFFIX = /^(?:(?:但是|不过|可是|但|却|而)?(?:没有|没能|没|未能|未|无法|不能|不可能)(?:成功)?|失败|未遂)/
const HYPOTHETICAL_ENDING_PREFIX = /(?:如果|假如|假设|假使|要是|倘若|万一|就算|即使|哪怕)/
const TERMINAL_CLAUSE_SEPARATORS = ['，', ',', '。', '.', '；', ';', '：', ':', '\n'] as const
const QUESTION_ENDING_PREFIX = /(?:想知道|想问|请问|怎样|怎么|如何|是否|能否|能不能|可否|可不可以)[^，,。.;；：:\n]{0,8}$/
const QUESTION_ENDING_SUFFIX = /^(?:[^，,。.;；：:\n]{0,8}(?:需要|要满足|需要满足|必须满足|得满足|要|得|具备|满足)[^，,。.;；：:\n]{0,6}(?:什么|哪些|哪种|何种|条件|要求|办法|方法)|[^，,。.;；：:\n]{0,8}(?:吗|呢)(?:[?？])?)/

function getTerminalMatchClause(userText: string, start: number, end: number): { prefix: string; suffix: string } {
  let clauseStart = 0
  let clauseEnd = userText.length
  for (const separator of TERMINAL_CLAUSE_SEPARATORS) {
    const previous = userText.lastIndexOf(separator, start)
    const next = userText.indexOf(separator, end)
    if (previous >= 0) clauseStart = Math.max(clauseStart, previous + separator.length)
    if (next >= 0) clauseEnd = Math.min(clauseEnd, next)
  }
  return {
    prefix: userText.slice(clauseStart, start),
    suffix: userText.slice(end, clauseEnd),
  }
}

function findStructuredTerminalEnding(
  userText: string,
  rawEndings: unknown,
): { ending: StructuredTerminalEnding; outcome: string } | null {
  if (!userText || !Array.isArray(rawEndings)) return null
  const candidates: { ending: StructuredTerminalEnding; outcome: string }[] = []

  for (const rawEnding of rawEndings) {
    if (!rawEnding || typeof rawEnding !== 'object') continue
    const ending = rawEnding as StructuredTerminalEnding
    const metadata = [ending.name, ending.condition, ending.outcome]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    if (!metadata) continue

    for (const signal of TERMINAL_COMPLETION_SIGNALS) {
      const match = signal.phrase.exec(userText)
      if (!match || !signal.metadata.test(metadata)) continue
      const { prefix, suffix } = getTerminalMatchClause(userText, match.index, match.index + match[0].length)
      if (
        PREMATURE_ENDING_PREFIX.test(prefix.slice(-14))
        || PREMATURE_ENDING_SUFFIX.test(suffix.slice(0, 10))
        || HYPOTHETICAL_ENDING_PREFIX.test(prefix)
        || QUESTION_ENDING_PREFIX.test(prefix)
        || QUESTION_ENDING_SUFFIX.test(suffix)
      ) continue
      candidates.push({ ending, outcome: signal.outcome })
    }
  }

  // Ambiguous metadata must not be guessed. A single story ending and outcome
  // must be supported by both the player's wording and the structured dossier.
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.ending === candidate.ending && other.outcome === candidate.outcome) === index,
  )
  return unique.length === 1 ? unique[0]! : null
}

function structuredEndGameCall(ending: StructuredTerminalEnding, outcome: string, id: string): KpToolCall {
  const title = typeof ending.name === 'string' && ending.name.trim() ? ending.name.trim() : '结局'
  const summary = typeof ending.outcome === 'string' && ending.outcome.trim()
    ? ending.outcome.trim()
    : typeof ending.condition === 'string' ? ending.condition.trim() : ''
  return {
    id,
    name: 'end_game',
    arguments: JSON.stringify({ outcome, title, summary, keyFacts: Array.isArray(ending.relatedTruths) ? ending.relatedTruths : [] }),
  }
}

export async function runKpTurn(
  userId: number,
  body: { messages: unknown; storyContext?: Record<string, unknown> | null },
  turn: KpTurnDeps,
): Promise<void> {
  // Keep the room-turn coordinator light: kpGraph pulls LangGraph and the
  // agent service pulls the provider stack. Load both only when a turn really
  // runs, which also lets knowledge-only consumers and room construction stay
  // independent from that heavy graph module.
  const [{ invokeKPAgent }, { buildInvokeLLM, normalizeMessages, getSharedGraph }] = await Promise.all([
    import('../agent/kpGraph.js'),
    import('./kpAgentService.js'),
  ])
  if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
    turn.onOwnerChanged?.()
    return
  }
  let messages: KpMessage[]
  try {
    messages = normalizeMessages(body?.messages)
  } catch (err) {
    turn.handlers.onError(errorMessage(err))
    return
  }
  let scriptContext: Awaited<ReturnType<typeof import('../agent/scriptContext.js').loadScriptContext>> = null
  let resolveStoryToolCall: typeof import('../agent/storyToolGate.js').resolveStoryToolCall | null = null
  const scriptId = typeof body.storyContext?.scriptId === 'string' ? body.storyContext.scriptId : ''
  const storyOwnerId = Number.isSafeInteger(body.storyContext?.storyOwnerId) && Number(body.storyContext?.storyOwnerId) > 0
    ? Number(body.storyContext?.storyOwnerId)
    : userId
  if (scriptId) {
    try {
      const [scriptContextModule, storyToolGateModule] = await Promise.all([
        import('../agent/scriptContext.js'),
        import('../agent/storyToolGate.js'),
      ])
      scriptContext = await scriptContextModule.loadScriptContext(storyOwnerId, scriptId)
      if (!scriptContext && body.storyContext?.workflow === 'dossier') {
        throw new Error('Dossier story context is unavailable')
      }
      resolveStoryToolCall = storyToolGateModule.resolveStoryToolCall
    } catch (err) {
      if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
        turn.onOwnerChanged?.()
        return
      }
      logger.error('kp:story condition context unavailable; cancelling turn', { userId, storyOwnerId, scriptId, error: errorMessage(err) })
      turn.handlers.onError('Story condition context is unavailable; this turn was cancelled to prevent unchecked scene or clue changes.')
      return
    }
  }
  const obtainedClueIds = getObtainedClueIds(body.storyContext)
  const currentSceneName = typeof body.storyContext?.sceneName === 'string'
    ? body.storyContext.sceneName
    : typeof body.storyContext?.sceneId === 'string' ? body.storyContext.sceneId : undefined
  // B5：多人模式注入房间内调查员花名册（id + 名称 + 关键属性），LLM 据此用 characterId 调工具
  messages = injectCharacterRoster(messages, turn.characters)
  const latestPlayerText = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const rawTerminalEndings = body.storyContext?.terminalEndings
  const hasStructuredTerminalMetadata = Array.isArray(rawTerminalEndings) && rawTerminalEndings.length > 0
  const terminalEnding = findStructuredTerminalEnding(latestPlayerText, rawTerminalEndings)
  const activeSheet = (turn.characters && turn.activeCharacterId ? turn.characters[turn.activeCharacterId] : null) ?? null
  if (messages.length === 0) {
    turn.handlers.onEnd({ content: '', displayMessages: [], toolCalls: [], worldDeltas: { cluesAdded: [] }, characterSheet: activeSheet })
    return
  }

  if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
    turn.onOwnerChanged?.()
    return
  }
  const ai = getAiConfig(userId)
  const invokeBase = buildInvokeLLM(userId, ai, {
    stream: true,
    onChunk: turn.handlers.onChunk,
    // dossier workflow: append story-lookup tools to the base COC tool set.
    tools: turn.storyLookup
      ? (COC_KP_TOOLS as unknown[]).concat(STORY_LOOKUP_TOOLS) as typeof COC_KP_TOOLS
      : undefined,
  })
  const invokeLLM: InvokeLLM = async (llmMessages) => {
    if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
      throw new Error('Room ownership changed during KP turn')
    }
    return invokeBase(llmMessages)
  }

  let fullContent = ''
  let msgs: KpMessage[] = messages
  // wire 采样累积（T1）：初始消息 + 各工具循环轮的 assistant/tool 消息（与 msgs 追加同源）
  const wireInitialMessages: KpMessage[] = messages
  const wireIterations: KpWireSampleIteration[] = []
  let graphFailed = false
  const allDisplayMessages: Message[] = []
  const executedToolCalls: { id: string; name: string; arguments: string }[] = []
  const worldDeltas: {
    cluesAdded: { description: string; clueId?: string }[]
    sceneChanged?: string
    ending?: { outcome: string; title: string; summary: string; epilogueOptions?: string[]; keyFacts?: string[]; keyTurnIds?: string[] }
  } = { cluesAdded: [] }
  const generateId = (): string => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  let ownerChangeHandled = false
  const recoverForOwnerChange = (): void => {
    if (ownerChangeHandled) return
    ownerChangeHandled = true
    turn.onOwnerChanged?.()
  }

  for (let loop = 0; loop < MAX_TOOL_ITERATIONS; loop++) {
    if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
      recoverForOwnerChange()
      return
    }
    const base = fullContent
    let iter = ''
    const genStart = Date.now()
    let r: Awaited<ReturnType<typeof invokeKPAgent>>
    try {
      // chunk 流开启时禁用图缓存：缓存 key 取自 String(invokeLLM)，不含 onChunk 回调身份——
      // 跨回合命中会带走上一回合（跨房间同理）的叙事流回调，导致 chunk 广播错房/漏播。
      r = await invokeKPAgent(
        msgs,
        invokeLLM,
        body?.storyContext ?? null,
        userId,
        await getSharedGraph(invokeLLM, userId, isKpChunkStreamEnabled()),
      )
    } catch (err) {
      if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
        recoverForOwnerChange()
        return
      }
      logger.warn('kp:turn graph iteration failed', { userId, loop, error: errorMessage(err) })
      graphFailed = true
      break
    }
    if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
      // The dispatched request cannot be recalled, but its stale narrative and
      // tool calls must not be applied after ownership has transferred.
      recoverForOwnerChange()
      return
    }
    const iterFinal = r?.content || ''
    if (iterFinal.trim()) {
      fullContent = base ? base + '\n\n' + iterFinal : iterFinal
    }
    // 服务端执行工具：结果注入消息（摘要 + 截断），角色卡变更通过 mutators 应用。
    // 多人模式（D5）：每个 toolCall 按 args.characterId 选择角色卡（缺省 → 当前行动者）；
    // characterId 不存在于角色组 → 回退行动者（归属校验）。逐调用构造上下文，
    // 使同批工具可作用于多个角色卡。
    const toolCalls = ((r?.toolCalls ?? []) as KpToolCall[]).filter(
      (call) => !hasStructuredTerminalMetadata || call.name !== 'end_game',
    )
    if (terminalEnding) {
      toolCalls.push(structuredEndGameCall(terminalEnding.ending, terminalEnding.outcome, `terminal_${Date.now()}_${loop}`))
    }
    // A terminal tool ends this turn. Keep one end_game call and run it last so
    // tool calls returned alongside it cannot execute after the game is ended.
    const endGameCall = toolCalls.find((call) => call.name === 'end_game')
    const endsTurn = endGameCall !== undefined
    if (endGameCall) {
      const otherCalls = toolCalls.filter((call) => call.name !== 'end_game')
      toolCalls.splice(0, toolCalls.length, ...otherCalls, endGameCall)
    }
    // Structured stories are gated by their dossier endings and a matched
    // completed signal. Stories without that metadata retain the legacy
    // model-selected end_game behavior. A matched structured ending is
    // synthesized above without waiting for another model decision.
    if (toolCalls.length === 0) break

    const results: { role: 'tool'; tool_call_id: string; content: string }[] = []
    const iterDisplay: Message[] = []
    for (const tc of toolCalls) {
      if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
        recoverForOwnerChange()
        return
      }
      // dossier workflow 查证工具：只读、不进 rule-engine（同步 handler 无异步缝），
      // 由注入的 storyLookup 特判执行（结果同样经摘要+截断回填）。
      if (turn.storyLookup && STORY_LOOKUP_TOOL_NAMES.indexOf(tc.name) >= 0) {
        try {
          const args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          const res = await turn.storyLookup(tc.name, args)
          if (turn.isOwnerCurrent && !turn.isOwnerCurrent()) {
            recoverForOwnerChange()
            return
          }
          results.push({ role: 'tool', tool_call_id: tc.id, content: res.content })
        } catch (e) {
          results.push({ role: 'tool', tool_call_id: tc.id, content: `error: ${e instanceof Error ? e.message : String(e)}` })
        }
        continue
      }
      let targetId = turn.activeCharacterId
      try {
        const args = JSON.parse(tc.arguments || '{}') as { characterId?: unknown }
        if (typeof args.characterId === 'string' && args.characterId && turn.characters && turn.characters[args.characterId]) {
          // 归属校验（D5）：显式 characterId 必须在本回合行动者可用的角色集内，
          // 否则回退行动者（防跨角色篡改他人角色卡）
          if (!turn.allowedCharacterIds || turn.allowedCharacterIds.has(args.characterId)) {
            targetId = args.characterId
          }
        }
      } catch { /* 参数解析失败 → 行动者 */ }
      const targetSheet = (targetId && turn.characters ? turn.characters[targetId] : null) ?? null
      const m = turn.mutatorFactory(targetId)
      // 评审候选 1 / Q4：worldDeltas 收集统一在内层——对工厂产出同样生效
      //（房间路径的 end 帧 worldDeltas 从恒空变为有值；房间客户端走 state_patch，不受影响）
      const ctxMutators: TurnCharacterMutators = {
        ...m,
        addClue: (description, clueId) => {
          worldDeltas.cluesAdded.push({ description, clueId })
          if (clueId && !obtainedClueIds.includes(clueId)) obtainedClueIds.push(clueId)
          m.addClue(description, clueId)
        },
        transitionToScene: (sceneName) => {
          worldDeltas.sceneChanged = sceneName
          m.transitionToScene(sceneName)
        },
        endGame: (ending) => {
          m.endGame(ending)
          worldDeltas.ending = ending
        },
      }
      const ctx = buildToolContext({
        characterSheet: targetSheet,
        ...ctxMutators,
        generateId,
        resolveNarrativeToolCall: scriptContext && resolveStoryToolCall
          ? (toolName, args) => resolveStoryToolCall!(toolName, args, scriptContext!, obtainedClueIds, currentSceneName)
          : undefined,
      })
      const { toolResults: tr, displayMessages: dm } = processToolCalls([tc], ctx, {
        onToolExecuted: turn.handlers.onToolExecuted,
      })
      results.push(...tr)
      iterDisplay.push(...dm)
    }
    const toolResults = results
    const displayMessages = iterDisplay
    allDisplayMessages.push(...displayMessages)

    // wire 采样：回填进会话的 tool 消息与追加进 msgs 的完全同源（摘要+截断 = LLM 实际看到的 wire）
    const wireToolMessages = toolResults.map((tr) => ({
      ...tr,
      content: summarizeToolResult(tr.content) + truncateToolResult(tr.content),
    }))
    const rawToolCalls = toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }))
    wireIterations.push({
      assistantContent: iterFinal,
      toolCalls: rawToolCalls,
      toolResults: wireToolMessages,
    })
    executedToolCalls.push(...rawToolCalls)
    msgs = [
      ...msgs,
      {
        role: 'assistant',
        content: iterFinal,
        tool_calls: toolCalls.map(toOpenAiToolCall),
      },
      ...wireToolMessages,
    ]
    // Invalid end_game arguments (for example, a missing summary) produce an
    // error tool result without an ending delta; let the model recover once.
    if (endsTurn && worldDeltas.ending) break
  }

  // wire 采样收口（T1）：只收完整回合——图中断或无最终叙事（兜底文案）不进 SFT 语料。
  // recordKpWireSample 内部处理开关/MOCK_AI gate，且绝不抛错（采样不影响回合）。
  const narrativeProduced = fullContent.trim().length > 0
  if (turn.sampling && !graphFailed && narrativeProduced) {
    recordKpWireSample({
      roomId: turn.sampling.roomId,
      ownerId: userId,
      storyId: turn.sampling.storyId,
      ragContext: turn.sampling.ragContext,
      initialMessages: wireInitialMessages,
      iterations: wireIterations,
      finalContent: fullContent,
    })
  }
  if (!narrativeProduced) {
    fullContent = '守密人正在思考……请稍候再试，或换一种方式描述你的行动。'
  }
  turn.handlers.onEnd({ content: fullContent, displayMessages: allDisplayMessages, toolCalls: executedToolCalls, worldDeltas, characterSheet: activeSheet })
}

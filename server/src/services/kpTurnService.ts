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
import { invokeKPAgent } from '../agent/kpGraph.js'
import { buildInvokeLLM, normalizeMessages, GRAPH_TIMEOUT_MS, getSharedGraph } from './kpAgentService.js'
import { getAiConfig } from './settingsService.js'
import { processToolCalls } from '../rule-engine/orchestrator.js'
import { buildToolContext } from '../rule-engine/toolContextFactory.js'
import type { KpMessage } from '../agent/kpGraph.js'
import type { ToolCall } from '../rule-engine/types.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import { recordKpWireSample, toOpenAiToolCall, type KpWireSampleIteration, type KpWireSamplingMeta } from './wireSampleService.js'
import { injectCharacterRoster } from './kpPromptService.js'

const MAX_TOOL_ITERATIONS = 8

/** Cap the tool-result payload echoed back into the conversation (long-chain
 * degradation guard): the trace bus already keeps the full result, so the
 * LLM only needs the head of the JSON. */
const MAX_TOOL_RESULT_CHARS = 600
/** Head of a tool result: first-level key/value pairs, for the LLM to see the
 * outcome at a glance without the full JSON (long tool chains echo history). */
const MAX_TOOL_RESULT_SUMMARY_CHARS = 120

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
}

/** 把角色花名册注入 messages 的 system 消息（B5）——实现随花名册块迁入 kpPromptService，此处再导出保持原导入面。 */
export { buildCharacterRosterPrompt, injectCharacterRoster } from './kpPromptService.js'

/** Build a compact `{success, skillName, roll, …}` summary head for tool results. */
function summarizeToolResult(content: string): string {
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    if (data === null || typeof data !== 'object') return ''
    const pairs: string[] = []
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      pairs.push(`${k}: ${s.slice(0, 40)}`)
      if (pairs.length >= 6) break
    }
    if (pairs.length === 0) return ''
    let head = `【结果摘要】${pairs.join('；')}`
    if (head.length > MAX_TOOL_RESULT_SUMMARY_CHARS) {
      head = `${head.slice(0, MAX_TOOL_RESULT_SUMMARY_CHARS)}…`
    }
    return head + '\n'
  } catch {
    return ''
  }
}

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
  handlers: KpTurnHandlers
}

export async function runKpTurn(
  userId: number,
  body: { messages: unknown; storyContext?: Record<string, unknown> | null },
  turn: KpTurnDeps,
): Promise<void> {
  let messages: KpMessage[]
  try {
    messages = normalizeMessages(body?.messages)
  } catch (err) {
    turn.handlers.onError(errorMessage(err))
    return
  }
  // B5：多人模式注入房间内调查员花名册（id + 名称 + 关键属性），LLM 据此用 characterId 调工具
  messages = injectCharacterRoster(messages, turn.characters)
  const activeSheet = (turn.characters && turn.activeCharacterId ? turn.characters[turn.activeCharacterId] : null) ?? null
  if (messages.length === 0) {
    turn.handlers.onEnd({ content: '', displayMessages: [], toolCalls: [], worldDeltas: { cluesAdded: [] }, characterSheet: activeSheet })
    return
  }

  const ai = getAiConfig(userId)
  const invokeLLM = buildInvokeLLM(userId, ai, { stream: true, onChunk: turn.handlers.onChunk })

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

  for (let loop = 0; loop < MAX_TOOL_ITERATIONS; loop++) {
    const base = fullContent
    let iter = ''
    const genStart = Date.now()
    let r: Awaited<ReturnType<typeof invokeKPAgent>>
    try {
      r = await invokeKPAgent(msgs, invokeLLM, body?.storyContext ?? null, userId, getSharedGraph(invokeLLM, userId, false))
    } catch (err) {
      logger.warn('kp:turn graph iteration failed', { userId, loop, error: errorMessage(err) })
      graphFailed = true
      break
    }
    const iterFinal = r?.content || ''
    if (iterFinal.trim()) {
      fullContent = base ? base + '\n\n' + iterFinal : iterFinal
    }
    if (!r?.toolCalls?.length) break

    // 服务端执行工具：结果注入消息（摘要 + 截断），角色卡变更通过 mutators 应用。
    // 多人模式（D5）：每个 toolCall 按 args.characterId 选择角色卡（缺省 → 当前行动者）；
    // characterId 不存在于角色组 → 回退行动者（归属校验）。逐调用构造上下文，
    // 使同批工具可作用于多个角色卡。
    const toolCalls = r.toolCalls as ToolCall[]
    const results: { role: 'tool'; tool_call_id: string; content: string }[] = []
    const iterDisplay: Message[] = []
    for (const tc of toolCalls) {
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
          m.addClue(description, clueId)
        },
        transitionToScene: (sceneName) => {
          worldDeltas.sceneChanged = sceneName
          m.transitionToScene(sceneName)
        },
        endGame: (ending) => {
          worldDeltas.ending = ending
          m.endGame(ending)
        },
      }
      const ctx = buildToolContext({ characterSheet: targetSheet, ...ctxMutators, generateId })
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

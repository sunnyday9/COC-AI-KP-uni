/**
 * kpTurnService — 服务端图内工具循环（Phase A2，架构方案 v2.0 D3）。
 *
 * 将原来客户端 kpSessionService.runKpAgentLoop 的多轮「invoke → 客户端执行工具
 * → 回传结果」循环整体下沉到服务端：
 *   - 图执行：复用 kpAgentService.buildInvokeLLM / getSharedGraph（图缓存命中，
 *     工具链不再每次重建图）；
 *   - 工具执行：复用 rule-engine（processToolCalls + buildToolContext），角色卡
 *     更新回调由本服务维护（sessionCharacter 快照）；
 *   - 一次 kp:turn 调用内完成 ≤8 轮，LLM 工具结果不再经网络往返；
 *   - 工具结果摘要/截断策略从 kpSessionService 原样迁移（防长链劣化）。
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

/**
 * 构建「房间内调查员花名册」prompt 块（B5 多角色卡 prompt 注入）。
 * 让 LLM 知道房间内有哪些调查员（id + 名称 + 关键属性），并提示用 characterId 调工具。
 * 单角色时返回空串（单人模式不注入，保持 prompt 精简）。
 */
export function buildCharacterRosterPrompt(characters: Record<string, COCCharacterSheet> | null): string {
  if (!characters) return ''
  const entries = Object.entries(characters)
  if (entries.length <= 1) return ''
  const lines: string[] = []
  for (const [id, sheet] of entries) {
    const name = sheet?.playerName || id
    const derived = sheet?.derived
    const attrs = sheet?.attributes
    const hp = derived?.hp != null ? `HP ${derived.hp}/${derived.hpMax ?? '?'}` : ''
    const san = derived?.san != null ? `SAN ${derived.san}/${derived.sanMax ?? '?'}` : ''
    const luck = attrs?.luck != null ? `幸运 ${attrs.luck}` : ''
    const stats = [hp, san, luck].filter(Boolean).join(' ')
    lines.push(`- ${name}（id: ${id}）${stats ? ' — ' + stats : ''}`)
  }
  return (
    '\n\n### 房间内调查员（多人模式）\n' +
    lines.join('\n') +
    '\n当某个调查员行动时，调用工具必须在参数中带上对应 characterId（如 "characterId": "' +
    (entries[0]?.[0] ?? '') +
    '"）。若工具缺省 characterId，将作用于最后行动的调查员。'
  )
}

/** 把角色花名册注入 messages 的 system 消息（B5）。 */
export function injectCharacterRoster(messages: KpMessage[], characters: Record<string, COCCharacterSheet> | null): KpMessage[] {
  const roster = buildCharacterRosterPrompt(characters)
  if (!roster) return messages
  const out = messages.slice()
  let systemIdx = out.findIndex((m) => m.role === 'system')
  if (systemIdx >= 0) {
    out[systemIdx] = { ...out[systemIdx], content: (out[systemIdx]?.content ?? '') + roster }
  } else {
    out.unshift({ role: 'system', content: roster })
  }
  return out
}

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
 */
export async function runKpTurn(
  userId: number,
  body: { messages: unknown; storyContext?: Record<string, unknown> | null },
  characters: Record<string, COCCharacterSheet> | null,
  activeCharacterId: string | null,
  mutators: TurnCharacterMutators,
  handlers: KpTurnHandlers,
  characterMutatorFactory?: (characterId: string | null) => TurnCharacterMutators,
): Promise<void> {
  let messages: KpMessage[]
  try {
    messages = normalizeMessages(body?.messages)
  } catch (err) {
    handlers.onError(errorMessage(err))
    return
  }
  // B5：多人模式注入房间内调查员花名册（id + 名称 + 关键属性），LLM 据此用 characterId 调工具
  messages = injectCharacterRoster(messages, characters)
  const activeSheet = (characters && activeCharacterId ? characters[activeCharacterId] : null) ?? null
  if (messages.length === 0) {
    handlers.onEnd({ content: '', displayMessages: [], toolCalls: [], worldDeltas: { cluesAdded: [] }, characterSheet: activeSheet })
    return
  }

  const ai = getAiConfig(userId)
  const invokeLLM = buildInvokeLLM(userId, ai, { stream: true, onChunk: handlers.onChunk })

  let fullContent = ''
  let msgs: KpMessage[] = messages
  const allDisplayMessages: Message[] = []
  const executedToolCalls: { id: string; name: string; arguments: string }[] = []
  const worldDeltas: {
    cluesAdded: { description: string; clueId?: string }[]
    sceneChanged?: string
    ending?: { outcome: string; title: string; summary: string; epilogueOptions?: string[]; keyFacts?: string[]; keyTurnIds?: string[] }
  } = { cluesAdded: [] }
  const generateId = (): string => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  // 包装调用方 mutators：世界增量（线索/场景/结局）收集到 worldDeltas，随 end 帧回传
  const wrappedMutators: TurnCharacterMutators = {
    ...mutators,
    addClue: (description, clueId) => {
      worldDeltas.cluesAdded.push({ description, clueId })
      mutators.addClue(description, clueId)
    },
    transitionToScene: (sceneName) => {
      worldDeltas.sceneChanged = sceneName
      mutators.transitionToScene(sceneName)
    },
    endGame: (ending) => {
      worldDeltas.ending = ending
      mutators.endGame(ending)
    },
  }

  for (let loop = 0; loop < MAX_TOOL_ITERATIONS; loop++) {
    const base = fullContent
    let iter = ''
    const genStart = Date.now()
    let r: Awaited<ReturnType<typeof invokeKPAgent>>
    try {
      r = await invokeKPAgent(msgs, invokeLLM, body?.storyContext ?? null, userId, getSharedGraph(invokeLLM, userId, false))
    } catch (err) {
      logger.warn('kp:turn graph iteration failed', { userId, loop, error: errorMessage(err) })
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
      let targetId = activeCharacterId
      try {
        const args = JSON.parse(tc.arguments || '{}') as { characterId?: unknown }
        if (typeof args.characterId === 'string' && args.characterId && characters && characters[args.characterId]) {
          targetId = args.characterId
        }
      } catch { /* 参数解析失败 → 行动者 */ }
      const targetSheet = (targetId && characters ? characters[targetId] : null) ?? null
      const m = characterMutatorFactory ? characterMutatorFactory(targetId) : wrappedMutators
      const ctx = buildToolContext({
        characterSheet: targetSheet,
        updateCharacterHP: m.updateCharacterHP,
        updateCharacterMP: m.updateCharacterMP,
        updateCharacterSAN: m.updateCharacterSAN,
        updateCharacterLuck: m.updateCharacterLuck,
        addCharacterDailySanLoss: m.addCharacterDailySanLoss,
        resetCharacterDailySanLoss: m.resetCharacterDailySanLoss,
        updateCharacterInsanityState: m.updateCharacterInsanityState,
        setCharacterMajorWound: m.setCharacterMajorWound,
        setCharacterDying: m.setCharacterDying,
        growCharacterSkill: m.growCharacterSkill,
        increaseCthulhuMythos: m.increaseCthulhuMythos,
        transitionToScene: m.transitionToScene,
        addClue: m.addClue,
        endGame: m.endGame,
        generateId,
      })
      const { toolResults: tr, displayMessages: dm } = processToolCalls([tc], ctx, {
        onToolExecuted: handlers.onToolExecuted,
      })
      results.push(...tr)
      iterDisplay.push(...dm)
    }
    const toolResults = results
    const displayMessages = iterDisplay
    allDisplayMessages.push(...displayMessages)
    executedToolCalls.push(...toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })))

    msgs = [
      ...msgs,
      {
        role: 'assistant',
        content: iterFinal,
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments },
        })),
      },
      ...toolResults.map((tr) => ({
        ...tr,
        content: summarizeToolResult(tr.content) + truncateToolResult(tr.content),
      })),
    ]
  }

  if (!fullContent.trim()) {
    fullContent = '守密人正在思考……请稍候再试，或换一种方式描述你的行动。'
  }
  handlers.onEnd({ content: fullContent, displayMessages: allDisplayMessages, toolCalls: executedToolCalls, worldDeltas, characterSheet: activeSheet })
}

/**
 * MOCK_AI deterministic provider (Task 11, Phase 10).
 *
 * When `MOCK_AI=1` (see `config.isMockAiMode()`), every AI/LLM entry point in
 * aiService is short-circuited into this module instead of dispatching to a
 * real provider. It is a **script**, not a stub of the graph: the KP LangGraph
 * state machine (`kpGraph.ts`) still runs for real, and each LLM node call is
 * answered with a deterministic response driven by the conversation content.
 *
 * Behavior contract (used by the H5 E2E journey `e2e/h5.journey.mjs`):
 *  - intent classifier call → keyword → intent word (combat/investigate/…)
 *  - fresh-turn generate call → keyword → matching toolCalls sequence:
 *      "战斗/攻击/…"      → skill_check(格斗) → roll_dice → adjust_hp (-2 HP)
 *      "侦查/搜索/检查…"  → skill_check(侦查) → grant_clue(铜钥匙)
 *      "撬锁/开锁"        → skill_check(机械维修)
 *      otherwise          → fixed narrative text
 *  - tool-continuation call → previous tool result → next tool in the chain
 *    (skill_check with combat skill → roll_dice → adjust_hp), so the full
 *    client-side tool-execution loop is exercised end-to-end deterministically.
 *  - force-tools call (validation retry) → one toolCall per requested name
 *  - plain chat() / chatForRag() → fixed content (+ streaming chunks)
 *  - listModels() → one fixed "mock-model" option
 *
 * Zero impact on the non-mock path: nothing in this module is imported by any
 * code that runs without MOCK_AI=1.
 */
import type { ChatBody, ChatMessage, ChatResult, ToolCallResult } from './aiService.js'
import type { ModelOption } from '../../../shared/constants/providers.js'

/* ═══════════════════ Constants ═══════════════════ */

/** Fixed narrative used for plain chat() and default narrative turns. */
export const MOCK_NARRATIVE = '（测试模式）守秘人回应：你听到了远处的脚步声。'

/** Keyword → intent word for the classifier call (parseIntent-compatible). */
const INTENT_RULES: [RegExp, string][] = [
  [/战斗|攻击|开枪|射击|格斗|挥拳|扑向/, 'combat'],
  [/撬锁|开锁/, 'skill_check'],
  // 调查(?!员): the word 调查员 (investigator) must NOT trigger an action.
  [/侦查|搜索|检查|查看|搜寻|翻找|调查(?!员)/, 'investigate'],
  [/恐怖|疯狂|尖叫|理智/, 'san_encounter'],
  [/对话|询问|交谈|打听|说服|恐吓/, 'talk_npc'],
  [/移动|前往|走到|进入/, 'move'],
  [/使用|掏出|拿出/, 'use_item'],
]

/** Combat skills whose successful check chains into roll_dice (kpGraph logic). */
const COMBAT_SKILLS = ['格斗', '射击', '手枪', '步枪', '投掷', '弓术', '斧', '刀', '矛', '鞭', '拳']

/** Deterministic arguments for each tool name (used by fresh-turn & force calls). */
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  skill_check: { skillName: '侦查', skillValue: 65, difficulty: 'regular' },
  roll_dice: { sides: 6 },
  adjust_hp: { delta: -2 },
  grant_clue: { description: '书架后的暗格里藏着一把铜钥匙' },
  transition_scene: { sceneName: '旧图书馆' },
  san_check: { currentSan: 60, successLoss: '1', failureLoss: '1d6' },
  opposed_check: { sideAName: '调查员格斗', sideAValue: 60, sideBName: 'NPC闪避', sideBValue: 45, tieBreaker: 'attacker' },
  melee_attack: { weapon: '匕首', damage: '1d4+2' },
  ranged_attack: { weapon: '手枪', damage: '1d10' },
  first_aid: { target: '自己' },
  medicine: { target: '自己' },
  apply_major_wound: {},
  trigger_insanity: {},
  spend_luck: { amount: 5 },
  adjust_mp: { delta: -1 },
  adjust_san: { delta: -1 },
  end_game: { outcome: 'survival', title: '真相大白', summary: '调查员揭开了真相。' },
  investigation_progress: {},
}

/* ═══════════════════ Helpers ═══════════════════ */

function makeToolCall(name: string, args: Record<string, unknown>, idx: number): ToolCallResult {
  return {
    id: `mock_tc_${idx}`,
    name,
    arguments: JSON.stringify(args),
  }
}

function findLastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content ?? '')
  }
  return ''
}

function parseJsonContent(content: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(content) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isClassifierCall(messages: ChatMessage[]): boolean {
  return (
    messages.length > 0 &&
    messages[0]?.role === 'system' &&
    typeof messages[0].content === 'string' &&
    messages[0].content.includes('只回复一个英文意图关键词')
  )
}

function isForceToolCall(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return (
    last?.role === 'user' &&
    typeof last.content === 'string' &&
    last.content.includes('请立即调用以下工具')
  )
}

/** Classifier: keyword → intent word (deterministic). */
function classifyIntent(userText: string): string {
  for (const [re, intent] of INTENT_RULES) {
    if (re.test(userText)) return intent
  }
  return 'narrative'
}

/** Force-tools retry call: one toolCall per requested tool name. */
function mockForceTools(messages: ChatMessage[]): { content: string; toolCalls: ToolCallResult[] } {
  const text = findLastUserText(messages)
  const toolCalls: ToolCallResult[] = []
  let idx = 0
  for (const name of Object.keys(TOOL_ARGS)) {
    if (text.includes(name)) {
      toolCalls.push(makeToolCall(name, TOOL_ARGS[name] ?? {}, idx++))
    }
  }
  return { content: '', toolCalls }
}

/**
 * Tool-continuation generate call: decide the next tool from the previous
 * tool result (mirrors kpGraph.analyzeToolContinuation's follow-up logic so
 * the real graph accepts the mock output).
 */
function mockContinuation(messages: ChatMessage[]): { content: string; toolCalls?: ToolCallResult[] } {
  const last = messages[messages.length - 1]
  if (last?.role !== 'tool') return { content: MOCK_NARRATIVE }

  const raw = String(last.content ?? '')
  const parsed = parseJsonContent(raw)
  if (parsed) {
    const skillName = typeof parsed.skillName === 'string' ? parsed.skillName : ''
    if (skillName && COMBAT_SKILLS.some((s) => skillName.includes(s))) {
      // combat skill check → roll damage dice
      return { content: '', toolCalls: [makeToolCall('roll_dice', TOOL_ARGS.roll_dice ?? { sides: 6 }, 0)] }
    }
    if (typeof parsed.roll === 'number' && typeof parsed.sides === 'number' && !skillName && parsed.currentSan === undefined) {
      // roll_dice result → deduct HP
      return { content: '', toolCalls: [makeToolCall('adjust_hp', TOOL_ARGS.adjust_hp ?? { delta: -2 }, 0)] }
    }
    if (skillName) {
      // non-combat check result → hand the investigator a clue (E2E asserts
      // the clue panel appears after a 侦查 turn)
      return { content: '', toolCalls: [makeToolCall('grant_clue', TOOL_ARGS.grant_clue ?? { description: '书架后的暗格里藏着一把铜钥匙' }, 0)] }
    }
    if (parsed.success === true && typeof parsed.description === 'string' && parsed.description) {
      // grant_clue / transition_scene result → conclude the investigation beat
      return { content: '（测试模式）你获得了线索。' }
    }
    if (parsed.currentSan !== undefined) {
      return { content: '（测试模式）你挺过了这次恐惧。' }
    }
    return { content: MOCK_NARRATIVE }
  }
  if (raw.startsWith('HP adjusted') || raw.startsWith('Clue granted')) {
    return { content: raw.startsWith('HP adjusted') ? '（测试模式）你受到了伤害，HP 下降。' : '（测试模式）线索已记录。' }
  }
  return { content: MOCK_NARRATIVE }
}

/** Fresh-turn generate call: keyword → first tool of the chain. */
function mockFreshTurn(messages: ChatMessage[]): { content: string; toolCalls?: ToolCallResult[] } {
  const userText = findLastUserText(messages)
  // 调查(?!员): the word 调查员 (investigator) must NOT trigger an action.
  if (/战斗|攻击|开枪|射击|格斗|挥拳|扑向/.test(userText)) {
    return { content: '', toolCalls: [makeToolCall('skill_check', { skillName: '格斗', skillValue: 60, difficulty: 'regular' }, 0)] }
  }
  if (/撬锁|开锁/.test(userText)) {
    return { content: '', toolCalls: [makeToolCall('skill_check', { skillName: '机械维修', skillValue: 50, difficulty: 'regular' }, 0)] }
  }
  if (/侦查|搜索|检查|查看|搜寻|翻找|调查(?!员)/.test(userText)) {
    return { content: '', toolCalls: [makeToolCall('skill_check', TOOL_ARGS.skill_check ?? { skillName: '侦查', skillValue: 65, difficulty: 'regular' }, 0)] }
  }
  if (/恐怖|疯狂|尖叫|理智/.test(userText)) {
    return { content: '', toolCalls: [makeToolCall('san_check', TOOL_ARGS.san_check ?? { currentSan: 60 }, 0)] }
  }
  return { content: MOCK_NARRATIVE }
}

/* ═══════════════════ Public mock entry points ═══════════════════ */

/**
 * Deterministic agent-path LLM (mirrors the `chatForAgent` result shape):
 * classifier → keyword; force-tools → requested tools; continuation → next
 * chain tool; fresh turn → keyword tool; otherwise narrative. Streaming
 * (stream=true) invokes `onChunk` for the narrative parts, like the real
 * adapters do.
 */
export function mockChatForAgent(
  messages: ChatMessage[],
  stream: boolean,
  onChunk?: (chunk: string) => void,
): { content: string; toolCalls?: ToolCallResult[] } {
  if (isClassifierCall(messages)) {
    // The user message here is the full classifier prompt (intent examples
    // contain keywords like 战斗/攻击/射击) — classify ONLY the player's
    // message after the '玩家消息: ' marker, not the prompt itself.
    const promptText = findLastUserText(messages)
    const marker = '玩家消息: '
    const playerText = promptText.lastIndexOf(marker) >= 0 ? promptText.slice(promptText.lastIndexOf(marker) + marker.length) : promptText
    return { content: classifyIntent(playerText) }
  }
  if (isForceToolCall(messages)) {
    return mockForceTools(messages)
  }

  const last = messages[messages.length - 1]
  const result = last?.role === 'tool' ? mockContinuation(messages) : mockFreshTurn(messages)

  if (stream && onChunk && result.content) {
    // Emit content in two chunks so the WS streaming path is exercised.
    const mid = Math.ceil(result.content.length / 2)
    onChunk(result.content.slice(0, mid))
    onChunk(result.content.slice(mid))
  }
  return result
}

/** Plain chat (api-contract §3): fixed content, streaming chunks when asked. */
export function mockChat(body: ChatBody): ChatResult {
  const stream = !!body.stream
  if (stream) {
    const chunks = [MOCK_NARRATIVE.slice(0, 12), MOCK_NARRATIVE.slice(12)]
    return { stream: true, chunks }
  }
  return { stream: false, content: MOCK_NARRATIVE }
}

/** RAG-path chat (graph extraction / summaries): fixed, parseable text. */
export function mockChatForRag(): { content: string } {
  return { content: '（测试模式）' }
}

/** Model listing: one deterministic option so the settings page picker works. */
export function mockListModels(): ModelOption[] {
  return [{ value: 'mock-model', label: 'mock-model (E2E 测试)' }]
}

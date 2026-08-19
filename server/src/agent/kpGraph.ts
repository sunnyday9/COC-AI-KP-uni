/**
 * COC KP AI Agent — Enhanced LangGraph Workflow (ReAct + Validation)
 *
 * Architecture:
 *   analyzeInput → planTools → generate → validate ──→ END
 *                                            ↓ (missing tools)
 *                                       forceTools ──→ validate (max 1 retry)
 *
 * Improvements over simple linear flow:
 *  1. Explicit tool planning based on classified intent
 *  2. Text-simulation detection (catches KP faking dice/HP in prose)
 *  3. Force-retry node: tool-only LLM call when validation fails
 *  4. Tool-continuation awareness (multi-turn tool chains)
 *  5. Conditional edges for retry loop with max-retry guard
 *
 * Migrated line-by-line from
 * `original/ai-trpg-web/electron/agent/kpGraph.mjs` (Task 3).
 * State-machine topology, intent constants and prompt texts are preserved
 * verbatim; only type annotations were added. Known quirks/bugs of the
 * original are intentionally kept (see task-3-report.md).
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import {
  findScene,
  getAvailableClues,
  getSceneNpcs,
  loadScriptContext,
  sceneUnlocked,
} from './scriptContext.js'

/* ================================================================== */
/*  Types (annotations only — no behavior change)                      */
/* ================================================================== */

export interface KpMessage {
  role: string
  content: string
  tool_calls?: {
    id?: string
    function?: { name?: string; arguments?: unknown }
    _thoughtSignature?: unknown
  }[]
  tool_call_id?: string
}

export interface KpToolCall {
  id: string
  name: string
  arguments: string
  _thoughtSignature?: string
}

export type InvokeLLMResult = string | { content?: string; toolCalls?: KpToolCall[] }

/** The LLM function injected by the caller (kpAgentService builds it). */
export type InvokeLLM = (msgs: KpMessage[]) => Promise<InvokeLLMResult>

export interface KpTraceEvent {
  span: string
  type: string
  data: Record<string, unknown>
}

export interface KpGraphResult {
  content: string
  toolCalls?: KpToolCall[]
  _traceEvents?: KpTraceEvent[]
}

/* ================================================================== */
/*  State                                                              */
/* ================================================================== */

/**
 * KPState fields:
 * - messages: LangGraph message array
 * - playerIntent: current classified intent
 * - requiredTools: tools this turn must call
 * - toolPlan: natural-language tool plan
 * - response: assistant narrative text
 * - toolCalls: tools selected by the LLM this turn
 * - retryCount: validation retry counter
 * - validationResult: 'pending' | 'valid' | 'missing_tools' | 'max_retries'
 * - agentType: 'generic' | 'combat' | 'sanity' | 'narrative' | 'resource'
 * - storyContext: optional structured story state injected from Electron/front-end
 * - narrativeStallLevel: simple counter to detect long-term narrative stalling
 */
const KPState = Annotation.Root({
  messages:            Annotation<KpMessage[]>({ reducer: (_, r: unknown) => (Array.isArray(r) ? r : [r]), default: () => [] }),
  playerIntent:        Annotation<string>({ reducer: (_: unknown, r: string) => r, default: () => 'narrative' }),
  requiredTools:       Annotation<string[]>({ reducer: (_: unknown, r: string[]) => r, default: () => [] }),
  toolPlan:            Annotation<string>({ reducer: (_: unknown, r: string) => r, default: () => '' }),
  response:            Annotation<string>({ reducer: (_: unknown, r: string) => r, default: () => '' }),
  toolCalls:           Annotation<KpToolCall[] | undefined>({ reducer: (_: unknown, r: KpToolCall[] | undefined) => r, default: () => undefined }),
  retryCount:          Annotation<number>({ reducer: (_: unknown, r: number) => r, default: () => 0 }),
  validationResult:    Annotation<string>({ reducer: (_: unknown, r: string) => r, default: () => 'pending' }),
  agentType:           Annotation<string>({ reducer: (_: unknown, r: string) => r, default: () => 'generic' }),
  storyContext:        Annotation<Record<string, unknown> | null>({ reducer: (_: unknown, r: Record<string, unknown> | null) => r, default: () => null }),
  narrativeStallLevel: Annotation<number>({ reducer: (_: unknown, r: number) => r, default: () => 0 }),
  _traceEvents:        Annotation<KpTraceEvent[]>({ reducer: (prev: KpTraceEvent[], r: unknown) => (prev || []).concat(Array.isArray(r) ? r : [r]), default: () => [] }),
})

/** The typed shape of the graph state (mirrors KPState). */
export interface KpAgentState {
  messages: KpMessage[]
  playerIntent: string
  requiredTools: string[]
  toolPlan: string
  response: string
  toolCalls?: KpToolCall[]
  retryCount: number
  validationResult: string
  agentType: string
  storyContext: Record<string, unknown> | null
  narrativeStallLevel: number
  _traceEvents: KpTraceEvent[]
}

/* ================================================================== */
/*  Intent constants & helpers                                         */
/* ================================================================== */

const INTENT_TYPES = [
  'investigate', 'skill_check', 'talk_npc', 'move',
  'combat', 'explore', 'use_item', 'san_encounter', 'narrative',
]

/**
 * End-game intent: strong player expressions that the story has concluded.
 * The word list is deliberately narrow — ordinary movement ("离开房间") must
 * NOT match; only explicit endings / terminations do.
 */
const ENDGAME_PATTERNS = [
  /结束冒险/, /完结/, /封存/, /不玩了/, /团灭/, /永久疯狂/, /成功逃离/, /真相大白/, /终止游戏/, /结局吧/, /到此为止/,
]

function detectEndgameIntent(userText: string): boolean {
  const text = String(userText || '').trim()
  if (!text) return false
  for (let i = 0; i < ENDGAME_PATTERNS.length; i++) {
    if (ENDGAME_PATTERNS[i].test(text)) return true
  }
  return false
}

const INTENT_CLASSIFIER_PROMPT =
  '你是一个 COC 7th 跑团意图分类器。根据玩家最新一条消息，从以下意图中选出最匹配的，只回复一个英文关键词。\n\n' +
  '意图类型:\n' +
  '- investigate: 搜索、侦查、检查某物，图书馆/研究\n' +
  '- skill_check: 明确要进行技能检定或投骰\n' +
  '- talk_npc: 与NPC对话、询问、说服、恐吓\n' +
  '- move: 移动、前往某处\n' +
  '- combat: 战斗、攻击、格斗、射击、闪避\n' +
  '- explore: 探索环境、观察周围\n' +
  '- use_item: 使用道具或物品\n' +
  '- san_encounter: 目睹恐怖/超自然事件\n' +
  '- narrative: 一般叙事、角色扮演\n\n' +
  '玩家消息: '

function parseIntent(raw: string | null | undefined): string {
  const s = (raw || '').trim().toLowerCase()
  for (let i = 0; i < INTENT_TYPES.length; i++) {
    if (s.includes(INTENT_TYPES[i]) || s.startsWith(INTENT_TYPES[i])) return INTENT_TYPES[i]
  }
  if (/dice|roll|投骰|检定/.test(s)) return 'skill_check'
  if (/search|exam|look|搜|查|侦/.test(s)) return 'investigate'
  if (/talk|ask|speak|说|问|劝/.test(s)) return 'talk_npc'
  if (/go|move|walk|去|前往|走/.test(s)) return 'move'
  if (/fight|attack|hit|战|攻|打|射/.test(s)) return 'combat'
  return 'narrative'
}

/**
 * Rule-first intent classification (perf: skips the classifier LLM call when
 * a deterministic keyword match exists). The word table mirrors mockAi's
 * INTENT_RULES so MOCK_AI=1 and the real LLM path agree. Falls back to the
 * classifier LLM in analyzeInput when no rule matches.
 */
const INTENT_RULES_ORDER: Array<{ re: RegExp; intent: string }> = [
  { re: /战斗|攻击|开枪|射击|格斗|挥拳|扑向|砍|刺|开枪打/, intent: 'combat' },
  { re: /撬锁|开锁/, intent: 'skill_check' },
  // 调查(?!员): the word 调查员 (investigator) must NOT trigger an action.
  { re: /侦查|搜索|检查|查看|搜寻|翻找|搜查|调查(?!员)/, intent: 'investigate' },
  { re: /恐怖|疯狂|尖叫|理智|诡异|吓人|毛骨悚然/, intent: 'san_encounter' },
  { re: /对话|询问|交谈|打听|说服|恐吓|问.{0,6}(?:情况|消息|下落)/, intent: 'talk_npc' },
  { re: /移动|前往|走到|走进|进入|来到|离开|跑去|奔向/, intent: 'move' },
  { re: /使用|掏出|拿出|服用|佩戴/, intent: 'use_item' },
  { re: /骰|检定|投掷/, intent: 'skill_check' },
]

export function classifyIntentByRules(userText: string): string | null {
  const text = String(userText || '').trim()
  if (!text) return null
  for (let i = 0; i < INTENT_RULES_ORDER.length; i++) {
    const rule = INTENT_RULES_ORDER[i]
    if (rule.re.test(text)) return rule.intent
  }
  return null
}

/* ================================================================== */
/*  Text-simulation detection                                          */
/* ================================================================== */

const TEXT_SIMULATION_PATTERNS: RegExp[] = [
  /\bd\d+\s*[:=：]\s*\d+/i,
  /\d+d\d+\s*[:=：]\s*\d+/i,
  /投骰[结果]*\s*[:：]\s*\d+/,
  /HP\s*[降变至为低到].{0,8}\d+/,
  /SAN\s*[降损失至为低到].{0,8}\d+/,
  /MP\s*[降消耗至为低到].{0,8}\d+/,
  /受到\s*\d+\s*点.{0,4}伤害/,
  /伤害\s*\d+d\d+/,
  /d100\s*[:：]?\s*\d+/i,
  /目标[值≤]\s*\d+/,
]

function hasTextSimulation(text: string | null | undefined): boolean {
  if (!text) return false
  for (let i = 0; i < TEXT_SIMULATION_PATTERNS.length; i++) {
    if (TEXT_SIMULATION_PATTERNS[i].test(text)) return true
  }
  return false
}

function cleanTextSimulation(text: string | null | undefined): string {
  if (!text) return ''
  const cleaned = text
    .replace(/\*\*[^*]*(?:检定|伤害结算|d\d+|投骰|目标值)[^*]*\*\*/g, '')
    .replace(/[（(][^)）]*d\d+[^)）]*[)）]/g, '')
    .replace(/→\s*(?:成功|失败|大成功|大失败|极难成功|困难成功)/g, '')
    .replace(/HP\s*[降变至为].{0,15}\d+\/\d+/g, '')
    .replace(/SAN\s*[降损失].{0,15}\d+/g, '')
    .replace(/受到\s*\d+\s*点.{0,4}伤害[，。]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned || text
}

/* ================================================================== */
/*  Tool-continuation analysis                                         */
/* ================================================================== */

/**
 * Parse the JSON payload out of a tool-result message. The client prepends a
 * `【结果摘要】…` head to tool results (kpSessionService perf A4) before
 * echoing them back, so the JSON body starts at the first `{` — parse from
 * there instead of requiring the whole content to be JSON.
 */
export function parseToolResultContent(content: string | null | undefined): Record<string, unknown> | null {
  const s = String(content ?? '').trim()
  if (!s) return null
  const jsonStart = s.indexOf('{')
  const candidate = jsonStart >= 0 ? s.slice(jsonStart) : s
  try {
    const v = JSON.parse(candidate) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function analyzeToolContinuation(messages: KpMessage[]): { isContinuation: boolean; followUpTools: string[] } {
  const toolResults: KpMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') toolResults.unshift(messages[i])
    else break
  }
  if (toolResults.length === 0) return { isContinuation: false, followUpTools: [] }

  const followUp: string[] = []
  for (let j = 0; j < toolResults.length; j++) {
    try {
      const data = parseToolResultContent(toolResults[j].content)
      if (!data) continue
      if (data.success === true && data.skillName) {
        const combatSkills = ['格斗', '射击', '手枪', '步枪', '投掷', '弓术', '斧', '刀', '矛', '鞭', '拳']
        let isCombat = false
        for (let k = 0; k < combatSkills.length; k++) {
          if ((String(data.skillName) || '').indexOf(combatSkills[k]) >= 0) { isCombat = true; break }
        }
        if (isCombat) followUp.push('roll_dice')
      }
      if (data.roll !== undefined && data.sides !== undefined && !data.skillName && !data.currentSan) {
        followUp.push('adjust_hp')
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return { isContinuation: true, followUpTools: followUp }
}

/* ================================================================== */
/*  SAN state extraction from message history                          */
/* ================================================================== */

/**
 * Reconstruct the player's current SAN state from the trailing tool results
 * (the client no longer sends a structured storyContext, so the graph reads
 * the san_check results that are already part of the conversation).
 * Returns null when no san_check result exists in the recent history.
 */
export interface SanState {
  currentSan: number
  totalSanLost: number
}

export function extractSanStateFromHistory(messages: KpMessage[]): SanState | null {
  let currentSan: number | null = null
  let totalSanLost = 0
  // Walk the whole history: SAN is cumulative state, so every san_check
  // result counts (not just the last turn's chain).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool') {
      try {
        const data = parseToolResultContent(m.content)
        if (data && typeof data.currentSan === 'number' && currentSan === null) currentSan = data.currentSan
        if (data && typeof data.sanLost === 'number') totalSanLost += Math.max(0, data.sanLost)
      } catch {
        /* ignore parse errors */
      }
    }
  }
  if (currentSan === null && totalSanLost === 0) return null
  return { currentSan: currentSan ?? 99, totalSanLost }
}

/**
 * Matches the client sanityHandler thresholds: a single loss >= 5 warrants a
 * temporary-insanity INT check; cumulative daily loss >= 1/5 of current SAN
 * warrants indefinite insanity.
 */
export function shouldTriggerInsanity(state: SanState | null): boolean {
  if (!state) return false
  const oneFifth = Math.floor(state.currentSan / 5)
  return state.totalSanLost >= 5 || (oneFifth > 0 && state.totalSanLost >= oneFifth)
}

/* ================================================================== */
/*  Narrative progress analysis                                       */
/* ================================================================== */

/**
 * Stall detection over the message history.
 *
 * The counter-based approach in the original was broken: each kp:invoke runs
 * a fresh graph instance (stallLevel always starts at 0) and planTools runs
 * BEFORE generate (it can never see the current turn's toolCalls). Counting
 * is therefore derived from the conversation itself — the number of
 * consecutive recent assistant turns that produced no narrative-progress tool.
 *
 * Progress tools are grant_clue / transition_scene only: a lone skill_check
 * does NOT reset the counter, so "searching with checks but never receiving a
 * clue" escalates exactly as REPORT.md recommends (force grant_clue after 2
 * such turns, force transition_scene after 4).
 */
const STALL_PROGRESS_TOOLS = ['grant_clue', 'transition_scene']

export function computeStallLevelFromHistory(messages: KpMessage[]): number {
  let stall = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : []
      let hasProgress = false
      for (let j = 0; j < tcs.length; j++) {
        const name = tcs[j]?.function?.name
        if (name && STALL_PROGRESS_TOOLS.indexOf(name) >= 0) { hasProgress = true; break }
      }
      if (hasProgress) break
      stall += 1
    } else if (m.role === 'system') {
      break
    }
    // tool / user / other roles are skipped: tool results belong to the
    // previous assistant turn, user turns are the current prompt.
  }
  if (stall > 10) stall = 10
  return stall
}

/* ================================================================== */
/*  Node 1: Analyze Input                                              */
/* ================================================================== */

function createAnalyzeNode(invokeLLM: InvokeLLM) {
  return async function analyzeInput(state: KpAgentState) {
    const msgs = state.messages || []

    const continuation = analyzeToolContinuation(msgs)
    if (continuation.isContinuation) {
      return {
        playerIntent: 'tool_continuation',
        retryCount: 0,
      }
    }

    let lastUser: KpMessage | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUser = msgs[i]; break }
    }
    const userText = (lastUser && lastUser.content) ? lastUser.content.trim() : ''

    // Programmatic short-circuits (skip the classifier LLM call):
    // 1) Explicit end-game expressions → endgame intent (end_game required).
    if (detectEndgameIntent(userText)) {
      return {
        playerIntent: 'endgame',
        retryCount: 0,
        _traceEvents: [{ span: 'kp_agent', type: 'intent_classified', data: { intent: 'endgame', rawLLMOutput: '', source: 'detectEndgameIntent' } }],
      }
    }

    // 2) Recent SAN loss above the insanity threshold → san_encounter intent
    //    (planTools will force trigger_insanity).
    const sanState = extractSanStateFromHistory(msgs)
    if (shouldTriggerInsanity(sanState)) {
      return {
        playerIntent: 'san_encounter',
        retryCount: 0,
        _traceEvents: [{ span: 'kp_agent', type: 'intent_classified', data: { intent: 'san_encounter', rawLLMOutput: '', source: 'sanHistory', sanState } }],
      }
    }

    let playerIntent = 'narrative'
    let rawLLMOutput = ''
    if (userText) {
      // Rule-first short-circuit (perf): deterministic keyword match skips the
      // classifier LLM call. Fall back to the classifier when no rule hits.
      const ruleIntent = classifyIntentByRules(userText)
      if (ruleIntent) {
        playerIntent = ruleIntent
        rawLLMOutput = ''
        return {
          playerIntent: playerIntent,
          retryCount: 0,
          _traceEvents: [{ span: 'kp_agent', type: 'intent_classified', data: { intent: playerIntent, rawLLMOutput: rawLLMOutput, source: 'rule' } }],
        }
      }
      try {
        const result = await invokeLLM([
          { role: 'system', content: '只回复一个英文意图关键词，例如 narrative 或 investigate。不要解释。' },
          { role: 'user', content: INTENT_CLASSIFIER_PROMPT + userText },
        ])
        rawLLMOutput = typeof result === 'string' ? result : ((result && result.content) || '')
        playerIntent = parseIntent(rawLLMOutput)
      } catch {
        playerIntent = 'narrative'
      }
    }

    return {
      playerIntent: playerIntent,
      retryCount: 0,
      _traceEvents: [{ span: 'kp_agent', type: 'intent_classified', data: { intent: playerIntent, rawLLMOutput: rawLLMOutput } }],
    }
  }
}

/* ================================================================== */
/*  Node 1.5: Route By Intent (programmatic)                           */
/* ================================================================== */

function createRouteByIntentNode() {
  return async function routeByIntent(state: KpAgentState) {
    const intent = state.playerIntent || 'narrative'
    let agent = 'generic'
    if (intent === 'combat') agent = 'combat'
    else if (intent === 'san_encounter') agent = 'sanity'
    else if (intent === 'investigate' || intent === 'explore' || intent === 'talk_npc' || intent === 'move' || intent === 'tool_continuation' || intent === 'narrative' || intent === 'endgame') {
      agent = 'narrative'
    } else if (intent === 'use_item') {
      agent = 'resource'
    }
    return {
      agentType: agent,
      _traceEvents: [{ span: 'kp_agent', type: 'agent_routed', data: { agentType: agent, intent: intent } }],
    }
  }
}

/* ================================================================== */
/*  Node 2: Plan Tools (programmatic — no LLM call)                    */
/* ================================================================== */

const TOOL_PLANS: Record<string, { required: string[]; plan: string }> = {
  combat: {
    required: ['skill_check'],
    plan: '战斗行动。你必须调用 skill_check 工具进行攻击/防御检定。' +
      '命中后必须调用 roll_dice 投伤害骰，然后调用 adjust_hp 扣除伤害。' +
      'NPC 攻击调查员时同样必须完整调用工具链。' +
      '禁止在文字中编造任何骰子数字或 HP 变化。',
  },
  skill_check: {
    required: ['skill_check'],
    plan: '玩家请求检定。你必须调用 skill_check 工具执行检定，使用角色技能表中的技能值。' +
      '等待工具返回真实结果后再叙述后果。禁止在文字中编造投骰结果。',
  },
  san_encounter: {
    required: ['san_check'],
    plan: '恐怖/理智冲击。你必须调用 san_check 工具执行理智检定。' +
      '根据恐怖程度设定 successLoss 和 failureLoss。禁止在文字中编造 SAN 损失数字。',
  },
  investigate: {
    required: [],
    plan: '调查行动。如有隐藏线索需要检定，调用 skill_check（侦查/图书馆使用/聆听等）。' +
      '显明线索直接调用 grant_clue 给予。职业相关的常规调查可自动成功。',
  },
  talk_npc: {
    required: [],
    plan: 'NPC 对话。以 NPC 身份回应。如需社交检定（说服/恐吓/魅惑），调用 skill_check。' +
      'NPC 配合度取决于检定结果和玩家筹码。',
  },
  move: {
    required: [],
    plan: '场景移动。如果目标在故事情报中存在，调用 transition_scene(sceneName)。' +
      '如果目标不在故事中，告知无事发生并引导回到主线。',
  },
  explore: {
    required: [],
    plan: '探索环境。基本描述无需检定。如有隐藏细节可触发侦查检定。使用全感官描写，营造氛围。',
  },
  use_item: {
    required: [],
    plan: '使用物品。根据物品和情境决定是否需要检定（如急救需要 skill_check）。',
  },
  narrative: {
    required: [],
    plan: '一般叙事。推进剧情和氛围。若玩家未推动剧情，简短回应即可。不要重复已描述的内容。',
  },
  tool_continuation: {
    required: [],
    plan: '上一轮工具调用的结果已返回。根据结果继续叙事。' +
      '如果战斗中 skill_check 成功，你必须调用 roll_dice 投伤害骰。' +
      '如果 roll_dice 返回了伤害数字，你必须调用 adjust_hp 扣除伤害。' +
      '禁止在文字中编造任何数值，只能使用工具返回的真实结果。',
  },
  endgame: {
    required: ['end_game'],
    plan: '故事已明确结束（真相揭示、逃离成功/失败、团灭/永久疯狂等）。' +
      '你必须调用 end_game(outcome, title, summary) 给出结局并停止继续推进对话。' +
      '调用 end_game 后，为每个调查员写一段洛氏风格的简短结语（故事结束后他们的命运、回顾其贡献），不需要掷骰。' +
      '如果玩家想结束但剧情尚未到高潮，可让最高 INT 的调查员做灵感检定（inspiration_check）决定最终场景是否处于有利位置（快进收尾）。',
  },
}

function createPlanNode(agentKind: string, userId?: number) {
  return async function planTools(state: KpAgentState) {
    const intent = state.playerIntent || 'narrative'
    const plan = TOOL_PLANS[intent] || TOOL_PLANS.narrative

    const continuation = analyzeToolContinuation(state.messages || [])

    // Progress signal for the stall detector: the tools executed in the last
    // turn (assistant tool_calls) plus the follow-ups this turn must continue.
    let lastTurnProgressTools: string[] = []
    {
      const msgs = state.messages || []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          lastTurnProgressTools = m.tool_calls
            .map((tc) => tc?.function?.name)
            .filter((n): n is string => typeof n === 'string')
          break
        }
        if (m.role === 'user') break
      }
      for (const f of continuation.followUpTools) {
        if (lastTurnProgressTools.indexOf(f) < 0) lastTurnProgressTools.push(f)
      }
    }

    let stallInfo: { nextStallLevel: number; shouldForceClue: boolean; shouldForceScene: boolean } | null = null
    if (agentKind === 'narrative' || agentKind === 'generic') {
      const stallLevel = computeStallLevelFromHistory(state.messages || [])
      stallInfo = {
        nextStallLevel: stallLevel,
        shouldForceClue: stallLevel >= 2,
        shouldForceScene: stallLevel >= 4,
      }
    }

    let required = plan.required.slice()
    if (continuation.isContinuation && continuation.followUpTools.length > 0) {
      for (let i = 0; i < continuation.followUpTools.length; i++) {
        if (required.indexOf(continuation.followUpTools[i]) < 0) {
          required.push(continuation.followUpTools[i])
        }
      }
    }

    // Continuation hint: tell the LLM which tools the previous turn already
    // ran, so long tool chains don't re-run or drop steps (perf + reliability).
    let continuationHint = ''
    if (continuation.isContinuation) {
      const prevCalls = lastTurnProgressTools
      if (prevCalls.length > 0) {
        continuationHint = `【工具续接】上一轮已调用：${prevCalls.join('、')}。请依据其工具结果继续推进叙事；如流程需要后续步骤（如伤害骰、HP 扣除）再调用对应工具，不要重复调用已完成的工具。`
      }
    }

    // Phase 2: narrative/generic hard constraints based on stall analysis
    if (stallInfo && intent !== 'endgame') {
      if (stallInfo.shouldForceScene && agentKind === 'narrative') {
        if (required.indexOf('transition_scene') < 0) required.push('transition_scene')
      } else if (stallInfo.shouldForceClue) {
        if (required.indexOf('grant_clue') < 0) required.push('grant_clue')
      }
    }

    // Phase 2.4: endgame intent — end_game is mandatory (programmatic).
    if (intent === 'endgame' && required.indexOf('end_game') < 0) {
      required.push('end_game')
    }

    // Phase 2.5: narrative/generic SAN auto-check hint from storyContext
    if ((agentKind === 'narrative' || agentKind === 'generic') && state.storyContext && (state.storyContext.sanity as Record<string, unknown> | undefined)?.autoCheck) {
      if (required.indexOf('san_check') < 0) required.push('san_check')
    }

    // Phase 2.6: external anti-stall force transition flag (renderer side)
    if (agentKind === 'narrative' && state.storyContext && state.storyContext.forceTransitionScene) {
      if (required.indexOf('transition_scene') < 0) required.push('transition_scene')
    }

    // Phase 3: sanityAgent flow based on simple sanity context
    if (agentKind === 'sanity' && intent === 'san_encounter') {
      const sanityCtx = state.storyContext && (state.storyContext.sanity as Record<string, unknown> | undefined) ? state.storyContext.sanity as Record<string, unknown> : null
      if (sanityCtx) {
        const currentSan = typeof sanityCtx.currentSan === 'number' ? sanityCtx.currentSan : null
        const dailyLoss = typeof sanityCtx.dailySanLoss === 'number' ? sanityCtx.dailySanLoss : null
        const potentialLoss = typeof sanityCtx.potentialLoss === 'number' ? sanityCtx.potentialLoss : null

        const shouldConsiderTrigger =
          (potentialLoss !== null && potentialLoss >= 5) ||
          (currentSan !== null && currentSan > 0 && dailyLoss !== null && potentialLoss !== null &&
            (dailyLoss + potentialLoss) >= Math.floor(currentSan / 5))

        if (shouldConsiderTrigger && required.indexOf('trigger_insanity') < 0) {
          required.push('trigger_insanity')
        }
      }

      // Server-side fallback: the client no longer sends storyContext, so
      // derive the same threshold from the san_check results in history.
      if (required.indexOf('trigger_insanity') < 0 && shouldTriggerInsanity(extractSanStateFromHistory(state.messages || []))) {
        required.push('trigger_insanity')
      }
    }

    // Phase 3: resourceAgent structured tool mapping
    if (agentKind === 'resource' && intent === 'use_item') {
      const msgs = state.messages || []
      let lastUser: KpMessage | null = null
      for (let u = msgs.length - 1; u >= 0; u--) {
        if (msgs[u].role === 'user') { lastUser = msgs[u]; break }
      }
      const text = (lastUser && lastUser.content) ? String(lastUser.content).toLowerCase() : ''

      if (/luck|幸运/.test(text) && required.indexOf('spend_luck') < 0) {
        required.push('spend_luck')
      }
      if (/(mp|魔法值|法力)/.test(text) && required.indexOf('adjust_mp') < 0) {
        required.push('adjust_mp')
      }
      if (/(san|理智)/.test(text) && required.indexOf('adjust_san') < 0) {
        required.push('adjust_san')
      }
    }

    // Phase 3.5: script-gating (clue-driven story). Optional — when the
    // current script has structured requiredClues, planTools renders the
    // gate state into the plan text and refuses to force transition_scene
    // for locked scenes. Free-text scripts return null and behave as before.
    // Detection does NOT depend on the classifier: the player's text is
    // scanned for a known scene name (a different scene than the current one
    // is a move target); exploration turns get the scene's obtainable clues.
    let gatingHint = ''
    if (agentKind === 'narrative' && userId && state.storyContext?.scriptId) {
      try {
        const scriptCtx = await loadScriptContext(userId, String(state.storyContext.scriptId))
        const obtainedIds: string[] = []
        if (Array.isArray(state.storyContext.openClues)) {
          for (const c of state.storyContext.openClues) {
            const id = typeof c === 'string' ? c : ((c as { id?: unknown })?.id)
            if (typeof id === 'string' && id) obtainedIds.push(id)
          }
        }
        if (scriptCtx) {
          const msgs = state.messages || []
          let lastUser: KpMessage | null = null
          for (let u = msgs.length - 1; u >= 0; u--) {
            if (msgs[u].role === 'user') { lastUser = msgs[u]; break }
          }
          const userText = (lastUser && lastUser.content) ? String(lastUser.content) : ''
          const currentSceneName =
            (typeof state.storyContext.sceneName === 'string' && state.storyContext.sceneName) ||
            (typeof state.storyContext.sceneId === 'string' && state.storyContext.sceneId) ||
            ''
          const currentScene = currentSceneName ? findScene(scriptCtx, currentSceneName) : null

          // 1) Move-target gate: the player's text names a script scene that
          //    is NOT the current one → lock check + transition guard.
          const mentioned = findScene(scriptCtx, userText)
          if (mentioned && (!currentScene || mentioned.name !== currentScene.name)) {
            const gate = sceneUnlocked(mentioned, obtainedIds)
            if (gate.unlocked === false) {
              const missingDescriptions = gate.missing
                .map((id) => scriptCtx.clues.find((c) => c.id === id)?.description || id)
                .join('；')
              gatingHint = `【门控】目标场景「${mentioned.name}」尚未解锁，需要先获得线索：${missingDescriptions}。本轮不要调用 transition_scene，先引导玩家获取这些线索。`
              const idx = required.indexOf('transition_scene')
              if (idx >= 0) required.splice(idx, 1)
            } else if (gate.unlocked === true) {
              gatingHint = `【门控】目标场景「${mentioned.name}」已解锁（前置线索已获得），可以调用 transition_scene(sceneName: "${mentioned.name}")。`
            } else if (mentioned.transitionCondition) {
              gatingHint = `【门控参考】目标场景「${mentioned.name}」的转移条件（文本描述，供你判断）：${mentioned.transitionCondition}`
            }
          } else if (currentScene) {
            // 2) Exploration gate: list the scene's obtainable clues so the
            //    LLM stops defaulting to skill_check-only turns.
            const available = getAvailableClues(currentScene, obtainedIds, scriptCtx)
            if (available.length > 0) {
              const list = available.map((a) => `- ${a.clue.description}${a.reason === 'unlocked-by-clue' ? '（前置线索已满足，可授予）' : ''}`).join('\n')
              gatingHint = `【门控】当前场景「${currentScene.name}」中玩家尚未获得、且前置条件已满足的线索：\n${list}\n请通过 grant_clue 授予其中合适的线索（可带 clueId）。`
            } else {
              const allIds = currentScene.clueIds || []
              const pending = allIds.filter((id) => obtainedIds.indexOf(id) < 0)
              if (pending.length > 0) {
                gatingHint = `【门控】当前场景「${currentScene.name}」仍有 ${pending.length} 条线索未获得，但前置条件未满足（需要先在别处获得其他线索），不要强行授予。`
              }
            }
          }
        }
      } catch {
        gatingHint = '' // script load failure → proceed without gating
      }
    }

    // Phase 4: genericAgent guardrails — never force high-impact narrative tools
    if (agentKind === 'generic' && required.length > 0) {
      const filtered: string[] = []
      for (let g = 0; g < required.length; g++) {
        if (required[g] === 'transition_scene' || required[g] === 'grant_clue' || required[g] === 'end_game') continue
        filtered.push(required[g])
      }
      required = filtered
    }

    let finalPlan = plan.plan
    if (continuationHint) finalPlan += `\n\n${continuationHint}`
    if (gatingHint) finalPlan += `\n\n${gatingHint}`
    const nextStallLevel = stallInfo ? stallInfo.nextStallLevel : (state.narrativeStallLevel || 0)
    return {
      requiredTools: required,
      toolPlan: finalPlan,
      narrativeStallLevel: nextStallLevel,
      _traceEvents: [{ span: 'kp_agent', type: 'tool_plan_created', data: { requiredTools: required, plan: finalPlan, stallLevel: nextStallLevel, gatingHint: gatingHint || undefined } }],
    }
  }
}

/* ================================================================== */
/*  Node 3: Generate (main LLM call)                                   */
/* ================================================================== */

function createGenerateNode(invokeLLM: InvokeLLM, agentKind: string) {
  return async function generate(state: KpAgentState) {
    const msgs = state.messages || []
    const toolPlan = state.toolPlan || ''
    const requiredTools = state.requiredTools || []
    const storyContext = state.storyContext || null

    let toolInstruction = ''
    if (requiredTools.length > 0) {
      toolInstruction = '\n\n### 本次必须调用的工具\n' +
        '你在本次回复中 **必须** 调用以下工具（不调用将被系统拒绝）:\n'
      for (let i = 0; i < requiredTools.length; i++) {
        toolInstruction += '- ' + requiredTools[i] + '\n'
      }
      toolInstruction += '先调用工具，然后写简短的过渡叙事。不要在文字中编造工具应该返回的数值。\n'
    }

    let storyContextBlock = ''
    if (storyContext && (agentKind === 'narrative' || agentKind === 'generic')) {
      const sc = storyContext
      storyContextBlock = '\n\n### 当前故事上下文（仅供你参考，不要直白念出字段名）\n'
      if (sc.sceneName || sc.sceneId) {
        storyContextBlock += '- 场景: ' + String(sc.sceneName || sc.sceneId) + (sc.sceneType ? '（类型: ' + String(sc.sceneType) + '）' : '') + '\n'
      }
      if (typeof sc.act === 'string') {
        storyContextBlock += '- 当前幕次/阶段: ' + sc.act + '\n'
      }
      if (Array.isArray(sc.openClues) && sc.openClues.length > 0) {
        storyContextBlock += '- 未解决线索:\n'
        for (let oc = 0; oc < sc.openClues.length; oc++) {
          storyContextBlock += '  - ' + String(sc.openClues[oc]) + '\n'
        }
      }
      if (Array.isArray(sc.activeNPCs) && sc.activeNPCs.length > 0) {
        storyContextBlock += '- 场景中重要 NPC:\n'
        for (let an = 0; an < sc.activeNPCs.length; an++) {
          const npc = sc.activeNPCs[an] as Record<string, unknown> | null | undefined
          if (npc && (npc.name || npc.role)) {
            storyContextBlock += '  - ' + String(npc.name || 'NPC') + (npc.role ? '（' + String(npc.role) + '）' : '') + '\n'
          }
        }
      }
      storyContextBlock += '请让叙事和行动选项尽量围绕上述线索和 NPC 展开。玩家跑题时，可以简短回应，但需要把话题拉回当前场景或主线。\n'
    }

    let agentHint = ''
    if (agentKind === 'combat') {
      agentHint =
        '\n\n【战斗守则】所有攻击/防御/伤害必须通过工具链完成（skill_check → roll_dice → adjust_hp）。' +
        '禁止在文字中编造命中结果、伤害点数或 HP 变化。'
    } else if (agentKind === 'sanity') {
      agentHint =
        '\n\n【理智守则】所有 SAN 检定与疯狂状态变化必须通过 san_check / trigger_insanity / adjust_san 工具完成，' +
        '禁止在文字中编造 SAN 数值或疯狂状态变更。'
    } else if (agentKind === 'narrative' || agentKind === 'generic') {
      agentHint =
        '\n\n【叙事守则】在每一轮回复中，请：' +
        '1）先用 1～2 句通过视觉/听觉/气味等感官强化当前场景氛围；' +
        '2）明确反馈玩家上一行动的直接结果；' +
        '3）给出 2～3 个清晰的下一步可选行动（使用列表或显式提示“你可以选择：…”），引导玩家与场景中的线索或 NPC 互动。' +
      '如需要推进剧情或给出重要信息，请优先调用 transition_scene / grant_clue / skill_check 等工具，而不是单纯在文本中硬塞信息。' +
      '当你描述调查员首次目睹超自然现象、惨烈尸体、不可名状的恐怖、或任何足以撼动理智的场景时，**必须**调用 san_check，并根据恐怖程度设定 successLoss/failureLoss。' +
      '当故事已明确结束（真相揭示、逃离成功/失败、团灭/永久疯狂等），**必须**调用 end_game(outcome,title,summary)，然后停止继续推进对话。'
    }

    if (agentKind === 'generic') {
      agentHint +=
        '\n\n【genericAgent 限制】你主要负责规则问答、规则说明或简单闲聊：' +
        '1）简要回答后，应自动补上一句自然的过渡，把话题拉回当前场景或主线；' +
        '2）不要主动调用 transition_scene 或 grant_clue 等高影响剧情工具，把这些留给叙事 Agent；' +
        '3）如需要让玩家回到故事，请用自然语言提醒当前场景和可以采取的行动，而不是开启全新世界观或无关剧情。'
    }

    const hintBlock = '### 行动计划\n' + toolPlan + toolInstruction + storyContextBlock +
      '\n\n【输出规则】只输出给调查员看的剧情与对话。不要出现规则说明、意图分类、工具名称等内部内容。' +
      '绝对禁止在文字中编造骰子结果或数值变化，所有检定和数值变更必须通过工具实现。' +
      '【极度严厉警告】如果你需要使用工具（如 san_check 等），请直接触发底层的 Tool Call 机制！**绝对禁止**在回复的文本中写出“请调用xxx”或任何带有参数的代码指令。工具调用必须隐形！' +
      agentHint

    const enhancedMsgs = msgs.slice()
    let systemIdx = -1
    for (let j = 0; j < enhancedMsgs.length; j++) {
      if (enhancedMsgs[j].role === 'system') { systemIdx = j; break }
    }
    if (systemIdx >= 0) {
      enhancedMsgs[systemIdx] = {
        role: 'system',
        content: (enhancedMsgs[systemIdx].content || '') + '\n\n' + hintBlock,
      }
    } else {
      enhancedMsgs.unshift({ role: 'system', content: hintBlock })
    }

    const genStartTime = Date.now()
    const result = await invokeLLM(enhancedMsgs)
    const content = typeof result === 'string' ? result : ((result && result.content) || '')
    const toolCalls = (typeof result === 'object' && result && result.toolCalls) ? result.toolCalls : undefined
    const genDuration = Date.now() - genStartTime

    return {
      response: content || '',
      toolCalls: toolCalls,
      _traceEvents: [
        { span: 'kp_agent', type: 'llm_generate_start', data: { messageCount: enhancedMsgs.length, agentType: agentKind } },
        { span: 'kp_agent', type: 'llm_generate_end', data: { responseLength: (content || '').length, hasToolCalls: !!(toolCalls && toolCalls.length), toolCallCount: toolCalls ? toolCalls.length : 0, durationMs: genDuration } },
      ],
    }
  }
}

/* ================================================================== */
/*  Node 4: Validate (programmatic — no LLM call)                      */
/* ================================================================== */

// Unidirectional: calling the key tool implicitly satisfies all value tools.
// e.g. melee_attack internally performs skill_check + roll_dice + adjust_hp.
// Reverse does NOT hold — calling skill_check+roll_dice+adjust_hp won't satisfy melee_attack.
const TOOL_EQUIVALENTS: Record<string, string[]> = {
  'melee_attack': ['skill_check', 'roll_dice', 'adjust_hp'],
  'ranged_attack': ['skill_check', 'roll_dice', 'adjust_hp'],
}

function createValidateNode() {
  return async function validate(state: KpAgentState) {
    const response = state.response || ''
    const toolCalls = state.toolCalls
    const required = state.requiredTools || []
    const retryCount = state.retryCount || 0

    const calledNames: string[] = []
    if (toolCalls && toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        calledNames.push(toolCalls[i].name || '')
      }
    }

    const expandedNames = calledNames.slice()
    for (let e = 0; e < calledNames.length; e++) {
      const equiv = TOOL_EQUIVALENTS[calledNames[e]]
      if (equiv) {
        for (let q = 0; q < equiv.length; q++) {
          if (expandedNames.indexOf(equiv[q]) < 0) expandedNames.push(equiv[q])
        }
      }
    }

    const missingTools: string[] = []
    for (let j = 0; j < required.length; j++) {
      if (expandedNames.indexOf(required[j]) < 0) {
        missingTools.push(required[j])
      }
    }

    const simulated = hasTextSimulation(response)

    const traceData: KpTraceEvent = { span: 'kp_agent', type: 'validation_result', data: { result: 'valid', hasSimulation: simulated, missingTools: missingTools, retryCount: retryCount } }

    if (missingTools.length === 0 && !simulated) {
      traceData.data.result = 'valid'
      return { validationResult: 'valid', _traceEvents: [traceData] }
    }

    if (retryCount >= 1) {
      const cleanedResponse = simulated ? cleanTextSimulation(response) : response
      traceData.data.result = 'max_retries'
      return { validationResult: 'max_retries', response: cleanedResponse, _traceEvents: [traceData] }
    }

    const cleanedForRetry = simulated ? cleanTextSimulation(response) : response
    traceData.data.result = 'missing_tools'
    return {
      validationResult: 'missing_tools',
      response: cleanedForRetry,
      _traceEvents: [traceData],
    }
  }
}

/* ================================================================== */
/*  Node 5: Force Tool Call (tool-only LLM call)                       */
/* ================================================================== */

function createForceToolNode(invokeLLM: InvokeLLM) {
  return async function forceTools(state: KpAgentState) {
    const msgs = state.messages || []
    const required = state.requiredTools || []
    const retryCount = state.retryCount || 0

    const toolList = required.join(', ')
    const forcePrompt =
      '你是 COC 7th 守密人 AI 的工具调度模块。\n' +
      '你必须根据当前对话上下文调用以下工具: ' + toolList + '\n\n' +
      '规则:\n' +
      '1. 只输出工具调用，不要输出任何叙事文字\n' +
      '2. 根据对话中的角色技能信息确定参数\n' +
      '3. 如果需要 skill_check，从角色技能表找到对应技能值\n' +
      '4. 如果需要 roll_dice，根据武器/情境确定骰子面数\n' +
      '5. 如果需要 adjust_hp，使用之前 roll_dice 的结果作为负数 delta\n'

    const forceMsgs: KpMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'system') {
        forceMsgs.push({ role: 'system', content: msgs[i].content + '\n\n' + forcePrompt })
      } else if (msgs[i].role === 'assistant' && Array.isArray(msgs[i].tool_calls)) {
        // Normalize malformed tool_calls before they reach the upstream LLM
        // again — bad arguments JSON would otherwise turn into an upstream
        // 400 in the retry path (test-agent AW-R-09).
        const prevCalls = msgs[i].tool_calls!
        const toolCalls: KpMessage['tool_calls'] = prevCalls.map((tc) => {
          const fn = (tc.function || {}) as { name?: string; arguments?: unknown }
          if (typeof fn.arguments === 'string') {
            try {
              JSON.parse(fn.arguments)
            } catch {
              return { ...tc, function: { ...fn, arguments: '{}' } }
            }
          }
          return tc
        })
        forceMsgs.push({ ...msgs[i], tool_calls: toolCalls })
      } else {
        forceMsgs.push(msgs[i])
      }
    }
    if (forceMsgs.length === 0 || forceMsgs[0].role !== 'system') {
      forceMsgs.unshift({ role: 'system', content: forcePrompt })
    }

    forceMsgs.push({
      role: 'user',
      content: '请立即调用以下工具: ' + toolList + '。不要输出文字，只调用工具。',
    })

    let result: InvokeLLMResult
    try {
      result = await invokeLLM(forceMsgs)
    } catch (err) {
      console.error('[kpGraph forceTools] LLM call failed:', (err as Error | undefined)?.message || String(err))
      return {
        retryCount: retryCount + 1,
        validationResult: 'max_retries',
      }
    }

    const newToolCalls = (typeof result === 'object' && result && result.toolCalls) ? result.toolCalls : undefined

    const merged: KpToolCall[] = state.toolCalls ? state.toolCalls.slice() : []
    if (newToolCalls && newToolCalls.length > 0) {
      for (let j = 0; j < newToolCalls.length; j++) {
        merged.push(newToolCalls[j])
      }
    }

    return {
      toolCalls: merged.length > 0 ? merged : undefined,
      retryCount: retryCount + 1,
      _traceEvents: [{ span: 'kp_agent', type: 'force_tools_invoked', data: { requiredTools: required, newToolCount: newToolCalls ? newToolCalls.length : 0 } }],
    }
  }
}

/* ================================================================== */
/*  Routing function                                                   */
/* ================================================================== */

function routeByIntentEdge(state: KpAgentState): string {
  const intent = state.playerIntent || 'narrative'
  if (intent === 'combat') return 'combat'
  if (intent === 'san_encounter') return 'sanity'
  if (intent === 'investigate' || intent === 'explore' || intent === 'talk_npc' || intent === 'move' || intent === 'tool_continuation' || intent === 'narrative' || intent === 'endgame') return 'narrative'
  if (intent === 'use_item') return 'resource'
  return 'generic'
}

function routeAfterValidation(state: KpAgentState): string {
  const result = state.validationResult || 'valid'
  if (result === 'valid' || result === 'max_retries') return 'end'
  return 'forceTools'
}

/* ================================================================== */
/*  Graph assembly                                                     */
/* ================================================================== */

export function createKPGraph(invokeLLM: InvokeLLM, userId?: number) {
  const graph = new StateGraph(KPState)
    .addNode('analyzeInput', createAnalyzeNode(invokeLLM))
    .addNode('routeByIntent', createRouteByIntentNode())
    // generic agent
    .addNode('genericPlan', createPlanNode('generic', userId))
    .addNode('genericGenerate', createGenerateNode(invokeLLM, 'generic'))
    // combat agent
    .addNode('combatPlan', createPlanNode('combat', userId))
    .addNode('combatGenerate', createGenerateNode(invokeLLM, 'combat'))
    // sanity agent
    .addNode('sanityPlan', createPlanNode('sanity', userId))
    .addNode('sanityGenerate', createGenerateNode(invokeLLM, 'sanity'))
    // narrative agent
    .addNode('narrativePlan', createPlanNode('narrative', userId))
    .addNode('narrativeGenerate', createGenerateNode(invokeLLM, 'narrative'))
    // resource agent
    .addNode('resourcePlan', createPlanNode('resource', userId))
    .addNode('resourceGenerate', createGenerateNode(invokeLLM, 'resource'))
    // shared validation / force-tools
    .addNode('validate', createValidateNode())
    .addNode('forceTools', createForceToolNode(invokeLLM))
    // edges
    .addEdge(START, 'analyzeInput')
    .addEdge('analyzeInput', 'routeByIntent')
    .addConditionalEdges('routeByIntent', routeByIntentEdge, {
      combat: 'combatPlan',
      sanity: 'sanityPlan',
      narrative: 'narrativePlan',
      resource: 'resourcePlan',
      generic: 'genericPlan',
    })
    .addEdge('genericPlan', 'genericGenerate')
    .addEdge('combatPlan', 'combatGenerate')
    .addEdge('sanityPlan', 'sanityGenerate')
    .addEdge('narrativePlan', 'narrativeGenerate')
    .addEdge('resourcePlan', 'resourceGenerate')
    .addEdge('genericGenerate', 'validate')
    .addEdge('combatGenerate', 'validate')
    .addEdge('sanityGenerate', 'validate')
    .addEdge('narrativeGenerate', 'validate')
    .addEdge('resourceGenerate', 'validate')
    .addConditionalEdges('validate', routeAfterValidation, {
      end: END,
      forceTools: 'forceTools',
    })
    .addEdge('forceTools', 'validate')

  return graph.compile()
}

/* ================================================================== */
/*  Public entry point                                                 */
/* ================================================================== */

/**
 * Run the KP Agent graph.
 * @param graph Optional pre-built graph instance (perf: kpAgentService caches
 *   non-streaming graphs; when omitted the graph is built per call).
 * @returns {Promise<{content: string, toolCalls?: Array<{id, name, arguments}>}>}
 */
export async function invokeKPAgent(
  messages: KpMessage[],
  invokeLLM: InvokeLLM,
  storyContext?: Record<string, unknown> | null,
  userId?: number,
  graph?: ReturnType<typeof createKPGraph>,
): Promise<KpGraphResult> {
  const instance = graph ?? createKPGraph(invokeLLM, userId)
  const initialState: Partial<KpAgentState> = { messages: messages }
  if (storyContext !== undefined && storyContext !== null) {
    initialState.storyContext = storyContext
  }
  const result = (await instance.invoke(initialState as KpAgentState)) as KpAgentState
  return {
    content: result.response || '',
    toolCalls: (result.toolCalls && result.toolCalls.length > 0) ? result.toolCalls : undefined,
    _traceEvents: result._traceEvents || [],
  }
}

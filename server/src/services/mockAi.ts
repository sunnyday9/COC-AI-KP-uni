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
  // The client prepends a `【结果摘要】…` head to echoed tool results
  // (kpSessionService perf A4); parse from the first `{` so the JSON body
  // is still readable.
  const s = String(content ?? '').trim()
  const jsonStart = s.indexOf('{')
  const candidate = jsonStart >= 0 ? s.slice(jsonStart) : s
  try {
    const v = JSON.parse(candidate) as unknown
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
  const trimmed = raw.trimStart()
  // dossier workflow 查证链（与 roomService.buildStoryLookup 的文本输出形态对齐）：
  // scene_list（"- 场景名：…" 行）→ scene_dossier → 叙事收尾。
  if (trimmed.startsWith('- ')) {
    return { content: '', toolCalls: [makeToolCall('scene_dossier', { sceneName: '旧图书馆' }, 0)] }
  }
  if (trimmed.startsWith('场景：')) {
    return { content: '（测试模式）你确认了旧图书馆的档案：管理员阿洛伊斯在借阅台后，青瓷花瓶有夹层。' }
  }
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
  if (raw.includes('HP adjusted') || raw.includes('Clue granted')) {
    return { content: raw.includes('HP adjusted') ? '（测试模式）你受到了伤害，HP 下降。' : '（测试模式）线索已记录。' }
  }
  return { content: MOCK_NARRATIVE }
}

/** Fresh-turn generate call: keyword → first tool of the chain. */
function mockFreshTurn(messages: ChatMessage[]): { content: string; toolCalls?: ToolCallResult[] } {
  const userText = findLastUserText(messages)
  // dossier workflow：查证型消息 → scene_list（查证工具链起点）
  if (/打听|查证|查阅档案|剧本里|故事里|确认一下|情报/.test(userText)) {
    return { content: '', toolCalls: [makeToolCall('scene_list', {}, 0)] }
  }
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
export function mockChatForRag(messages?: ChatMessage[]): { content: string } {
  // Dossier generation prompt (server/src/rag/dossier/prompts.ts) → return a
  // deterministic, valid dossier JSON matching e2e/fixtures/demo-story.txt
  // (3 scenes / 3 clues / 2 NPCs) so the dossier workflow runs end-to-end
  // under MOCK_AI without an LLM.
  const system = messages?.find((m) => m.role === 'system')
  if (system && typeof system.content === 'string' && system.content.includes('结构整理器')) {
    return {
      content: JSON.stringify({
        scenes: [
          {
            id: 'scene_library',
            name: '旧图书馆',
            sceneText:
              '旧图书馆常年笼罩在灰尘与霉味之中。管理员阿洛伊斯站在借阅台后，谨慎地打量着来访者。他不愿谈论地下室，只说"那里已经被封了很多年"。书架角落放着一只青瓷花瓶。花瓶旁边的桌上摊着一本破损日记，其中一页写道："铜钥匙藏在地板下，但我不知道它打开的是什么。"',
            description: '市立图书馆旧馆，管理员阿洛伊斯在此看守，青瓷花瓶暗藏夹层。',
            npcIds: ['npc_aloysius'],
            clueIds: ['clue_vase'],
            requiredClues: [],
            hooks: ['与管理员阿洛伊斯交谈', '检查青瓷花瓶', '翻阅桌上的破损日记'],
            keywords: ['图书馆', '花瓶', '日记', '阿洛伊斯'],
          },
          {
            id: 'scene_basement',
            name: '地下室',
            sceneText:
              '地下室的门被铁链锁住。锁头看起来很旧，但并非无法撬开。门后传来水滴落下的声音，以及若有若无的低语。',
            description: '被铁链封锁的地下室，门后传来水滴与低语。',
            npcIds: [],
            clueIds: [],
            requiredClues: ['clue_key'],
            hooks: ['尝试撬开铁链锁', '倾听门后的声音'],
            keywords: ['地下室', '铁链', '低语'],
          },
          {
            id: 'scene_archive',
            name: '档案室',
            sceneText:
              '档案室里堆满了泛黄的卷宗。其中一份卷宗记载：1920 年，图书馆前馆长失踪，他的办公室后来被封存，钥匙不知所终。',
            description: '堆满卷宗的档案室，记载前馆长失踪与黑星教团的线索。',
            npcIds: [],
            clueIds: ['clue_archive'],
            requiredClues: [],
            hooks: ['翻阅泛黄的卷宗'],
            keywords: ['档案室', '卷宗', '馆长', '黑星教团'],
          },
        ],
        clues: [
          { id: 'clue_vase', description: '青瓷花瓶是空心的，底部有夹层。', location: 'scene_library', requiredClues: [] },
          { id: 'clue_key', description: '前馆长办公室的钥匙是一把黄铜钥匙，带有鸢尾花纹。', location: '旧图书馆地板下', requiredClues: ['clue_vase'] },
          { id: 'clue_archive', description: '档案室卷宗提到，馆长失踪前曾收到一封信，署名是"黑星教团"。', location: 'scene_archive', requiredClues: [] },
        ],
        npcs: [
          {
            id: 'npc_aloysius',
            name: '阿洛伊斯',
            role: '图书馆管理员',
            description: '谨慎、健谈但回避地下室话题。',
            details: '管理员，不愿谈论地下室，只说"那里已经被封了很多年"。',
          },
          {
            id: 'npc_mary',
            name: '玛丽',
            role: '前馆长的女儿',
            description: '住在图书馆对面的公寓，愿意谈论父亲的失踪。',
            details: '前馆长的女儿，住在图书馆对面的公寓。',
          },
        ],
        meta: { title: '旧图书馆的铜钥匙' },
      }),
    }
  }
  return { content: '（测试模式）' }
}

/** Model listing: one deterministic option so the settings page picker works. */
export function mockListModels(): ModelOption[] {
  return [{ value: 'mock-model', label: 'mock-model (E2E 测试)' }]
}

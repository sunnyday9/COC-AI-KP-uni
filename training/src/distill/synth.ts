/**
 * Phase A——合成玩家批次 + rollout 状态演化（T4）。
 *
 * rollout 状态（场景/线索/近窗历史/记忆/角色卡）跨回合演化，与 roomService 的
 * 线上语义逐条对齐：
 *  - 记忆 = rememberTurn 的截断兜底形态（finalContent 前 80 字 + …；LLM 抽取点
 *    不可离线复现，兜底路径是同一函数的确定性分支）；
 *  - 场景/线索 = 工具执行 worldDeltas 应用（replay.ts 回传）；
 *  - 长期摘要 = 恒空（rollout ≤9 回合 < roomService 的 10 回合刷新阈值）。
 *
 * 教师只生成「玩家行动批次」（局面与行动，绝不代写 KP 回应或骰子结果）——KP 侧
 * 响应由 Phase B 重放产出，两侧职责不可混淆，否则样本自我污染。
 */
import {
  OPENING_USER_REQUEST,
  OPENING_RAG_QUERY,
} from '../../../server/src/services/kpPromptService.js'
import type { Message } from '../../../shared/types/game.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import { buildRagContext, type CorpusChunk, type LexicalIndex } from './corpus.js'
import { SLIM_MEMORY_ENTRIES, SLIM_RAG_SECTIONS, type DistillSkeleton, type SynthBatch, type TurnType } from './types.js'
import { TURN_TYPE_SPECS } from './turnTypes.js'
import type { RolloutPlan } from './pool.js'
import type { EvalEndpoint } from '../../eval/lib/client.js'
import { callTeacherJson } from './teacher.js'

/** rollout 运行态（deep-clone 的角色卡在工具执行中被 mutator 原地修改）。 */
export interface RolloutState {
  plan: RolloutPlan
  characters: Record<string, COCCharacterSheet>
  activeCharacterId: string | null
  scene: string | null
  clues: { id: string; description: string }[]
  history: Message[]
  kpMemory: string[]
}

export function initRolloutState(plan: RolloutState['plan']): RolloutState {
  const characters: Record<string, COCCharacterSheet> = {}
  for (const entry of plan.party) {
    characters[entry.characterId] = structuredClone(entry.sheet)
  }
  return {
    plan,
    characters,
    activeCharacterId: plan.party[0]?.characterId ?? null,
    scene: null,
    clues: [],
    history: [],
    kpMemory: [],
  }
}

/** 线上 rememberTurn 的确定性兜底分支（finalContent 前 80 字 + …；上限 30 同值）。 */
function rememberTurn(state: RolloutState, finalContent: string): void {
  state.kpMemory = [...state.kpMemory, `${finalContent.slice(0, 80)}…`].slice(-30)
}

/** 回合前快照（被过滤拒绝的回合必须回滚——状态演化只来自被接受的回合）。 */
export function snapshotState(state: RolloutState): RolloutState {
  return {
    ...state,
    characters: structuredClone(state.characters),
    clues: state.clues.map((c) => ({ ...c })),
    history: state.history.map((m) => ({ ...m })),
    kpMemory: [...state.kpMemory],
  }
}

export function restoreState(state: RolloutState, snapshot: RolloutState): void {
  state.characters = structuredClone(snapshot.characters)
  state.scene = snapshot.scene
  state.clues = snapshot.clues.map((c) => ({ ...c }))
  state.history = snapshot.history.map((m) => ({ ...m }))
  state.kpMemory = [...snapshot.kpMemory]
}

/** 回合产出应用（replay.ts 调用）：世界增量 + 消息流追加。 */
export function applyTurnOutcome(
  state: RolloutState,
  outcome: {
    batchContent: string
    batchPlayers: string[]
    finalContent: string
    worldDeltas: { cluesAdded: { description: string; clueId?: string }[]; sceneChanged?: string }
  },
  makeId: () => string,
): void {
  if (outcome.worldDeltas.sceneChanged) state.scene = outcome.worldDeltas.sceneChanged
  for (const clue of outcome.worldDeltas.cluesAdded) {
    state.clues.push({ id: clue.clueId ?? `clue_${makeId()}`, description: clue.description })
  }
  const batch = outcome.batchContent.split('\n')
  batch.forEach((line, i) => {
    const name = outcome.batchPlayers[i] ?? '调查员'
    state.history.push({ id: makeId(), timestamp: Date.now() + i, role: 'player', playerName: name, content: line.replace(/^【[^】]*】/, '') })
  })
  state.history.push({ id: makeId(), timestamp: Date.now(), role: 'kp', content: outcome.finalContent })
  rememberTurn(state, outcome.finalContent)
}

/** 小队速写（Phase A 提示词用）：名字/职业/关键属性——不含完整卡面，控提示词体积。 */
function partyBrief(state: RolloutState): string {
  return Object.values(state.characters)
    .map((s) => {
      const d = s.derived ?? { hp: 0, hpMax: 0, mp: 0, mpMax: 0, san: 0, sanMax: 0 }
      const topSkills = Object.entries(s.skills ?? {})
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 6)
        .map(([k, v]) => `${k}${v}%`)
        .join('、')
      return `- ${s.playerName}（${s.occupationName ?? '调查员'}）：HP ${d.hp}/${d.hpMax}，SAN ${d.san}/${d.sanMax}；擅长 ${topSkills || '（无突出技能）'}`
    })
    .join('\n')
}

const PHASE_A_SYSTEM = [
  '你是 COC 跑团数据管线的「玩家行动编排器」。你的职责：为一场克苏鲁的呼唤对局生成**调查员一方的行动批次**，供守密人（KP）在下一回合处理。',
  '硬性约束：',
  '- 只写调查员的行动/对话/意图，绝不替守密人叙事，绝不写骰子结果、伤害数值、检定成败。',
  '- 行动要贴合「故事情报」摘录的场景与线索，不发明摘录之外的关键地点/NPC。',
  '- 输出必须是合法 JSON 对象：{"batch": [{"playerName": "<调查员名>", "content": "<行动描述>"}]}。',
  '- 每条 content 一句话到三句话，具体、可被 KP 处理；1-3 条不等。',
  '- 严格遵守要求的回合类型与行动者人数配比。',
  '- 行动必须**果断指向该回合类型的戏剧行动**（如战斗类型必须写明确的攻击动作与目标；消耗幸运必须写明改判意图；追逐必须写明逃跑/追赶），让 KP 能自然做出该类型对应的规则结算。',
].join('\n')

/** Phase A：按当前 rollout 状态与目标回合类型生成玩家批次（opening 走固定请求不调用）。 */
export async function synthesizeBatch(options: {
  ep: EvalEndpoint
  state: RolloutState
  turnType: TurnType
  storyChunks: CorpusChunk[]
}): Promise<{ batch: SynthBatch[]; usage: { promptTokens: number; completionTokens: number; calls: number } }> {
  const { ep, state, turnType, storyChunks } = options
  const spec = TURN_TYPE_SPECS[turnType]
  const excerpt = storyChunks
    .slice(0, 3)
    .map((c) => c.content)
    .join('\n---\n')
    .slice(0, 2400)
  const stateParts = [
    state.scene ? `当前场景：${state.scene}` : '当前场景：（尚未确立）',
    state.clues.length ? `已获线索：\n${state.clues.map((c) => `- ${c.description}`).join('\n')}` : '已获线索：（无）',
    state.kpMemory.length ? `此前剧情梗概（KP 记忆）：\n${state.kpMemory.slice(-6).map((m) => `- ${m}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const userPrompt = [
    `【故事】${state.plan.storyName}`,
    `【故事情报摘录】\n${excerpt || '（无可用摘录——行动控制在氛围层面的日常推进）'}`,
    `【调查员小队】\n${partyBrief(state)}`,
    `【对局状态】\n${stateParts}`,
    `【本回合类型】${spec.label}：${spec.brief}`,
    turnType === 'multi_player_mixed'
      ? '要求：生成 2-3 名调查员的合并行动批次（各自独立行动，可在同处或分头）。'
      : '要求：生成 1-2 名调查员的行动批次（同一回合窗口内的连续行动）。',
    '现在输出 JSON（不要输出任何其他文字）。',
  ].join('\n\n')

  const { json, usage } = await callTeacherJson(ep, PHASE_A_SYSTEM, userPrompt)
  const rawBatch = Array.isArray(json.batch) ? json.batch : []
  const knownNames = new Set(Object.values(state.characters).map((s) => s.playerName))
  const batch: SynthBatch[] = []
  for (const item of rawBatch) {
    const playerName = typeof (item as { playerName?: unknown })?.playerName === 'string' ? String((item as { playerName?: unknown }).playerName).trim() : ''
    const content = typeof (item as { content?: unknown })?.content === 'string' ? String((item as { content?: unknown }).content).trim() : ''
    if (!playerName || !content) continue
    batch.push({ playerName: knownNames.has(playerName) ? playerName : [...knownNames][0] ?? playerName, content })
  }
  if (batch.length === 0) {
    // 教师输出不合格 → 退化为单条保守行动（保留管线连续性；过滤器与数据卡可见）
    const fallbackName = Object.values(state.characters)[0]?.playerName ?? '调查员'
    batch.push({ playerName: fallbackName, content: `（保守行动）${fallbackName}环顾四周，等待事态发展。` })
  }
  return { batch: batch.slice(0, 4), usage: { ...usage, calls: 1 } }
}

/** 当前回合的检索查询（线上 flushTurn 语义：合并批次文本；opening 用固定开场检索词）。 */
function retrievalQuery(turnType: TurnType, batchContent: string, scene: string | null): string {
  if (turnType === 'opening') return OPENING_RAG_QUERY
  return scene ? `${scene} ${batchContent}` : batchContent
}

/** 瘦身记忆（30→12）。 */
function slimMemory(state: RolloutState): string[] {
  return state.kpMemory.slice(-SLIM_MEMORY_ENTRIES)
}

/**
 * rollout 一步 → DistillSkeleton（context 侧完成，等 Phase B 重放）。
 * ragContext 在此注入（top4 瘦形态）；caveats 如实标注离线近似。
 */
export function buildSkeleton(options: {
  rolloutId: string
  state: RolloutState
  turnIndex: number
  turnType: TurnType
  batch: SynthBatch[] | null
  ragIndex: LexicalIndex | null
}): DistillSkeleton {
  const { rolloutId, state, turnIndex, turnType, batch, ragIndex } = options
  const isOpening = turnType === 'opening'
  const batchContent = isOpening ? OPENING_USER_REQUEST : (batch ?? []).map((b) => `【${b.playerName}】${b.content}`).join('\n')
  const query = retrievalQuery(turnType, batchContent, state.scene)
  const chunks = ragIndex ? ragIndex.search(query, SLIM_RAG_SECTIONS) : []
  const history = isOpening ? [] : state.history
  return {
    id: `${rolloutId}#${turnIndex}`,
    source: 'synthetic',
    kind: isOpening ? 'opening' : 'turn',
    turnType,
    storyName: state.plan.storyName,
    originId: rolloutId,
    batchContent,
    batchPlayers: isOpening ? [] : (batch ?? []).map((b) => b.playerName),
    characters: state.characters,
    activeCharacterId: state.activeCharacterId,
    promptInput: {
      scene: state.scene,
      clues: [...state.clues],
      history,
      kpMemory: slimMemory(state),
      longTermSummary: '',
    },
    ragContext: buildRagContext(chunks),
    caveats: chunks.length ? ['rag_lexical_approximation_offline'] : ['rag_context_unavailable_offline'],
  }
}

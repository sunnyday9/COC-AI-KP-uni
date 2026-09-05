/**
 * 蒸馏数据生成管线共享类型（T4，spec #36 / 票 #40 / ADR-0006 决策 4）。
 *
 * 数据形态 = OpenAI messages + tools JSONL（Hermes 风格，LLaMA-Factory 原生直吃）。
 * 样本 = #38 导出器的骨架（context 侧）+ 教师重放的理想回复（响应侧）：
 *   - seed 行：#38 导出器产出的真实骨架直接重放（真实玩家行动批次）；
 *   - synthetic 行：rollout 式合成——教师按剧本语料与回合类型生成玩家批次（Phase A），
 *     教师按项目提示词重放 KP 回复（Phase B），多步链的工具结果由离线 rule-engine
 *     真实执行回填（与线上一致，票 #40 开工对齐结论）。
 * 变量块瘦身在数据侧完成（ADR-0006 决策 3「训练集构建时」；票 #40 开工对齐结论）：
 *   对话窗 18→8、记忆 30→12、RAG 取前 4 节（线上 top8 的瘦形态）、序列 cap ~6k。
 */

/** 瘦身后的变量块参数（ADR-0006 决策 3：RAG top8→4、近窗 18→8、记忆 30→12）。 */
export const SLIM_RAG_SECTIONS = 4
export const SLIM_CONVERSATION_WINDOW = 8
export const SLIM_MEMORY_ENTRIES = 12
/** 序列上限（粗估 token ≈ chars / 1.6，中文为主）。 */
export const SLIM_SEQ_TOKEN_CAP = 6000
/** 工具循环上限（与线上 kpTurnService.MAX_TOOL_ITERATIONS 同值；replay/filter 共用）。 */
export const TOOL_LOOP_MAX = 8

/** 工具执行的世界增量（与 kpTurnService onEnd.worldDeltas 同形的最小集）。 */
export interface WorldDeltas {
  cluesAdded: { description: string; clueId?: string }[]
  sceneChanged?: string
  ending?: { outcome: string; title: string; summary: string }
}

/** 回合类型（蒸馏调度用；覆盖 24 工具的主组合，含纯叙事与多人合并行动）。 */
export type TurnType =
  | 'opening'
  | 'investigate_check'
  | 'combat_melee'
  | 'combat_ranged'
  | 'combat_stepwise'
  | 'npc_attack'
  | 'san_encounter'
  | 'insanity_bout'
  | 'clue_explicit'
  | 'scene_transition'
  | 'new_day'
  | 'luck_spend'
  | 'first_aid'
  | 'cast_spell'
  | 'chase'
  | 'environment_damage'
  | 'read_tome'
  | 'development_phase'
  | 'endgame'
  | 'multi_player_mixed'
  | 'narrative_pure'
  | 'seed_organic'

/** 回合类型的教师行为契约（过滤器的 required 依据；空数组 = 纯叙事不调工具）。 */
export interface TurnTypeSpec {
  /** 人类可读名（数据卡/抽检包展示）。 */
  label: string
  /** required 工具：coversRequiredTools（等价表展开）判定（kpValidation 单源）。
   *  null = 不设 required 约束（seed_organic——真实骨架的回合意图不可靠重推，
   *  只跑机械检查）。 */
  required: string[] | null
  /** true = 该类型天然多步（驱动 ≥500 多步工具链的调度权重）。 */
  chain: boolean
  /** 合成玩家批次的情境说明（Phase A 提示词用）。 */
  brief: string
}

/** Phase A 产出的一份玩家行动批次（合成情境）。 */
export interface SynthBatch {
  playerName: string
  content: string
}

/** 一个待重放的 context 骨架（本管线产出的 context 侧）。 */
export interface DistillSkeleton {
  /** 稳定 id：seed = export:<room|save>#<turnIndex>；synthetic = roll:<seq>。 */
  id: string
  source: 'seed' | 'synthetic'
  kind: 'opening' | 'turn'
  turnType: TurnType
  storyName: string
  /** 出处（数据卡/去重用）：seed = room_id|save_id；synthetic = rollout id。 */
  originId: string
  /** 批次玩家行动（opening = 固定开场请求）。 */
  batchContent: string
  /** 合成批次的玩家名（多人批次去重/抽检展示；seed 行从 batchContent 解析）。 */
  batchPlayers: string[]
  /** 在场调查员（characterId → sheet；工具上下文与花名册注入用）。 */
  characters: Record<string, import('../../../shared/types/character.js').COCCharacterSheet>
  /** 行动者（工具缺省 characterId 的回退目标）。 */
  activeCharacterId: string | null
  /** 提示词输入（瘦身前原文；buildRoomTurnMessages 调用前再按瘦身参数裁剪）。 */
  promptInput: {
    scene: string | null
    clues: { id: string; description: string }[]
    history: import('../../../shared/types/game.js').Message[]
    kpMemory: string[]
    longTermSummary: string
  }
  /** 离线 RAG 注入原文（线上 buildContext 同形；'' = 无注入）。 */
  ragContext: string
  /** 离线重建限制如实标注（沿用 #38 caveat 词汇 + 本票新增词）。 */
  caveats: string[]
}

/** 一个重放完成的候选样本（过滤前）。 */
export interface ReplayedTurn {
  skeleton: DistillSkeleton
  /** 工具循环各轮：assistant 原文 + 原始 tool_calls + 回填的 tool 消息（线上同形态）。 */
  iterations: {
    assistantContent: string
    toolCalls: { id: string; name: string; arguments: string }[]
    toolResults: { role: 'tool'; tool_call_id: string; content: string }[]
  }[]
  /** 最终叙事（多轮 narrative 以 '\n\n' 连接，与 kpTurnService.fullContent 同语义）。 */
  finalContent: string
  usage: { promptTokens: number; completionTokens: number; calls: number }
  /** 工具执行的世界增量（rollout 状态演化输入）。 */
  worldDeltas: WorldDeltas
  /** true = 打满 8 轮仍想调工具（未收口的半截回合，过滤器拒收）。 */
  hitCap: boolean
}

/** 过滤判定结果。 */
export interface FilterVerdict {
  ok: boolean
  /** 失败分类：text_dice / unknown_tool / bad_args / tool_error / missing_required / no_narrative / tool_overflow。 */
  category: 'pass' | 'text_dice' | 'unknown_tool' | 'bad_args' | 'tool_error' | 'missing_required' | 'no_narrative' | 'tool_overflow'
  detail: string
}

/** 样本来源（数据卡配比的四个桶；human = 用户提供的少量人工示范）。 */
export type SampleSource = 'seed' | 'synthetic' | 'anchor' | 'human'

/** 最终训练样本（messages+tools JSONL 行）。 */
export interface DistillSample {
  meta: {
    id: string
    source: SampleSource
    origin: string
    kind: 'opening' | 'turn'
    turnType: TurnType | 'anchor'
    storyName: string
    turnCount: number
    toolCallCount: number
    multiStep: boolean
    caveats: string[]
    batchPlayers: string[]
    usage: { promptTokens: number; completionTokens: number; calls: number }
  }
  /** 完整 wire 序列：system+近窗+本批 + 各轮 [assistant(tool_calls), tool 回填] + 最终叙事。 */
  messages: unknown[]
  tools: import('../../../shared/tools/cocTools.js').KpToolDef[]
}

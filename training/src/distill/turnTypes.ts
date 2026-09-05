/**
 * 回合类型行为契约（T4）：蒸馏调度与过滤器的 required 依据。
 *
 * required 数组交给 coversRequiredTools（shared/tools/kpValidation.ts 单源）判定——
 * melee_attack/ranged_attack 经 TOOL_EQUIVALENTS 展开隐含满足 skill_check+roll_dice+adjust_hp。
 * 空数组 = 纯叙事回合（要求零工具调用）。
 * brief 是 Phase A（合成玩家批次）的情境说明——只描述局面，不替教师决定叙事结果。
 */
import type { TurnType, TurnTypeSpec } from './types.js'

export const TURN_TYPE_SPECS: Record<TurnType, TurnTypeSpec> = {
  opening: {
    label: '开场',
    required: null,
    chain: false,
    brief: '游戏刚开始，KP 做开场白：交代背景、建立氛围、给出最初的调查方向。行动批次为空，教师直接产出开场叙事（可能伴随确立场景/给出线索的工具调用）。',
  },
  investigate_check: {
    label: '调查/技能检定',
    required: ['skill_check'],
    chain: true,
    brief: '调查员对一个有失败风险的行动做技能检定（侦查/图书馆/聆听/话术等）。检定成功后 KP 可以顺势授予线索。',
  },
  combat_melee: {
    label: '近战攻击',
    required: ['melee_attack'],
    chain: false,
    brief: '调查员向敌人发动近战攻击，必须通过 melee_attack 一次性结算对抗、伤害与重伤。',
  },
  combat_ranged: {
    label: '远程射击',
    required: ['ranged_attack'],
    chain: false,
    brief: '调查员用枪械射击，必须通过 ranged_attack 一次性结算命中、伤害与重伤。',
  },
  combat_stepwise: {
    label: '分步战斗链',
    required: ['opposed_check', 'roll_dice', 'adjust_hp'],
    chain: true,
    brief: '调查员发起对抗（如擒抱/格斗对抗），KP 选择分步调用：opposed_check 对抗检定 → roll_dice 伤害骰 → adjust_hp 结算伤害。',
  },
  npc_attack: {
    label: 'NPC 攻击调查员',
    required: ['melee_attack'],
    chain: true,
    brief: '敌人/NPC 向调查员发动攻击——KP 同样必须完整调用战斗工具链结算。',
  },
  san_encounter: {
    label: '恐怖遭遇（SAN 检定）',
    required: ['san_check'],
    chain: true,
    brief: '调查员目睹恐怖事物，必须先 san_check；若发生 SAN 损失，KP 视情况再调用 trigger_insanity 判定疯狂。',
  },
  insanity_bout: {
    label: '疯狂发作',
    required: ['trigger_insanity'],
    chain: false,
    brief: '调查员的理智已经崩溃（此前刚经历重大 SAN 损失），现在进入疯狂发作——行动表现出失控的恐惧/强迫行为，KP 调用 trigger_insanity 判定发作类型与症状。',
  },
  clue_explicit: {
    label: '显明线索',
    required: ['grant_clue'],
    chain: false,
    brief: '调查员发现了不需要检定的显明线索，KP 直接 grant_clue 记录。',
  },
  scene_transition: {
    label: '场景移动',
    required: ['transition_scene'],
    chain: false,
    brief: '调查员移动到新地点（场景名来自故事原文），KP 调用 transition_scene。',
  },
  new_day: {
    label: '新的一天',
    required: ['reset_day'],
    chain: false,
    brief: '调查员们睡了一觉/休整后迎来新的一天，行动明确写出「新的一天开始/整理行装继续调查」——KP 需调用 reset_day 重置当日 SAN 损失。',
  },
  luck_spend: {
    label: '消耗幸运改判',
    required: ['spend_luck'],
    chain: true,
    brief: '调查员刚刚经历一次失败的技能检定，明确宣布消耗幸运值把失败改成成功——行动必须明确写出「消耗幸运改判」的意图，回合里会出现 skill_check 失败 → spend_luck 的链。',
  },
  first_aid: {
    label: '急救/医药',
    required: ['first_aid'],
    chain: false,
    brief: '调查员（或同伴）对重伤/受伤者实施急救，KP 调用 first_aid（或 medicine）结算。',
  },
  cast_spell: {
    label: '施法',
    required: ['cast_spell'],
    chain: true,
    brief: '调查员施放一个法术，KP 调用 cast_spell 结算 MP/SAN 消耗。',
  },
  chase: {
    label: '追逐',
    required: ['chase_turn'],
    chain: true,
    brief: '追逐回合开始或推进（先做速度检定），KP 用 chase_turn 结算行动点与险境。',
  },
  environment_damage: {
    label: '环境伤害',
    required: ['environment_damage'],
    chain: false,
    brief: '调查员暴露在环境伤害下（坠落/火焰/溺水/毒气），KP 调用 environment_damage 按表结算。',
  },
  read_tome: {
    label: '阅读神话典籍',
    required: ['read_tome'],
    chain: false,
    brief: '调查员研读一本神话典籍，KP 调用 read_tome 结算神话增长与 SAN 损失。',
  },
  development_phase: {
    label: '幕间成长',
    required: ['development_phase'],
    chain: false,
    brief: '一幕结束进入幕间，KP 调用 development_phase 处理技能成长与 SAN 恢复奖励。',
  },
  endgame: {
    label: '结局',
    required: ['end_game'],
    chain: false,
    brief: '调查接近尾声，KP 调用 end_game 收束剧情（结局类型/标题/摘要）。',
  },
  multi_player_mixed: {
    label: '多人合并行动',
    required: ['skill_check'],
    chain: true,
    brief: '多名调查员在同一个回合窗口里各自行动（分头侦查/互相配合），KP 必须逐一指名回应。',
  },
  narrative_pure: {
    label: '纯叙事推进',
    required: [],
    chain: false,
    brief: '日常对话/氛围推进/无冲突行动——不需要检定，KP 纯叙事回应，绝不调用工具。',
  },
  seed_organic: {
    label: '真实骨架重放',
    required: null,
    chain: false,
    brief: '',
  },
}

/** 调度权重：chain 类型合计占比驱动「≥500 多步工具链」；narrative 类保持线上自然的纯叙事占比。 */
export const TURN_TYPE_WEIGHTS: [TurnType, number][] = [
  ['opening', 0], // opening 由 rollout 固定首回合产生，不参与权重抽样
  ['investigate_check', 14],
  ['combat_melee', 8],
  ['combat_ranged', 6],
  ['combat_stepwise', 7],
  ['npc_attack', 8],
  ['san_encounter', 10],
  ['insanity_bout', 3],
  ['clue_explicit', 5],
  ['scene_transition', 4],
  ['new_day', 2],
  ['luck_spend', 4],
  ['first_aid', 4],
  ['cast_spell', 4],
  ['chase', 4],
  ['environment_damage', 3],
  ['read_tome', 3],
  ['development_phase', 2],
  ['endgame', 1],
  ['multi_player_mixed', 10],
  ['narrative_pure', 14],
]

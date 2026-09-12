import type { Message, DiceMessage } from '../../../shared/types/game'

/**
 * T4：系统消息视觉分类（ADR-0004 消息类型体系）。
 *
 * 分类事实来源分两级（#79 收编显示接缝三分叉）：
 *  1. 字段优先：服务端 rule-engine displayMessages 以 DiceMessage 过 wire/快照
 *     （type:'dice'，检定类另带 result:{roll,target}）——带结构化检定事实的消息直判
 *     dice，不再依赖文本形态。等价性：当前 18 处 handler 产出中凡带 result.target 的
 *     形状（技能/对抗/投骰/近战/远程/SAN/灵感检定），文本正则亦判 dice，直读与旧文本
 *     路径对所有现存消息输出一致。
 *  2. 文本兜底：存量房间快照消息无 type/result；type:'dice' 无 result.target 的形状
 *     （SAN 损失/大失败惩罚/坠落/火焰，今日显示为 generic）也走文本形态——只分类，
 *     不改变消息模型（ticket #19 AC：沿用 roomStore messages 数据形态）。
 *
 * 文本形态优先级（服务器产生这些前缀，见 rule-engine/handlers/*）：
 *  1. 战斗伤害 = HP ±N（adjust_hp）
 *  2. 属性变更 = SAN/MP ±N（sanity/resource handlers）
 *  3. 场景切换 = `场景切换: X`（narrativeHandler）
 *  4. 线索获得 = `获得线索: X`（narrativeHandler）
 *  5. 掷骰卡 = `检定 d100:` 或 `d100:` 段（check/combat/rules/sanity handlers）
 */
export type SystemMessageKind =
  | 'damage' // 战斗伤害（血色调）：HP ±N
  | 'stat' // 属性变更：SAN/MP ±N
  | 'scene' // 场景分隔卡：场景切换
  | 'clue' // 线索获得（左缘绿光条）
  | 'dice' // 掷骰结果卡（d100/dN）
  | 'generic' // 其他系统文本

/** 结构化骰子事实单源读取（#79）：msg 为 DiceMessage 时返回 result，否则 undefined。
 *  分类与渲染层（SystemMessage diceGlow）共用，收窄谓词不重复。 */
export function diceResultOf(msg: Message): DiceMessage['result'] | undefined {
  return msg.role === 'system' && 'type' in msg && msg.type === 'dice' ? msg.result : undefined
}

export function classifySystemMessage(msg: Message): SystemMessageKind {
  // 字段优先（#79）：结构化检定事实（type:'dice' + result.target）直判 dice。
  // 无 target 的 dice 形状（SAN 损失等）与旧快照一律走下方文本形态，视觉不变。
  if (diceResultOf(msg)?.target != null) return 'dice'
  const content = msg.content ?? ''
  if (/^HP\s[+-]/.test(content)) return 'damage'
  if (/^(SAN|MP)\s[+-]/.test(content)) return 'stat'
  if (content.startsWith('场景切换')) return 'scene'
  if (content.startsWith('获得线索')) return 'clue'
  if (/检定\s*d100\s*:?\s*\d|d100\s*[:：]\s*\d|[dD]\d+[:：]\s*\d/.test(content)) return 'dice'
  if (/^对抗检定\b|^近战\s*:|^远程\s*:/.test(content)) return 'dice'
  return 'generic'
}

/**
 * KP 回合输出校验规则 — SINGLE SOURCE OF TRUTH（T3 #39）。
 *
 * 这组规则在产品里是质量门槛（server/src/agent/kpGraph.ts 的 validate 节点：
 * 缺 required 工具 → forceTools 重试；文字模拟骰子 → 清洗/重试），同时也是
 * 三层评测的客观评测器（spec #36 / ADR-0006：格式遵循率的判定基础，由
 * training/eval 的评测 harness 复用）。规则必须单源——两处各写一份必然漂移。
 *
 * 从 kpGraph.ts 原样搬出（内容逐字保留，行为不变）；kpGraph 从这里导入。
 */

/** 文字模拟检测：叙事正文里出现这些模式 = 在文字里编造骰子/数值变化。 */
export const TEXT_SIMULATION_PATTERNS: RegExp[] = [
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

export function hasTextSimulation(text: string | null | undefined): boolean {
  if (!text) return false
  for (let i = 0; i < TEXT_SIMULATION_PATTERNS.length; i++) {
    if (TEXT_SIMULATION_PATTERNS[i].test(text)) return true
  }
  return false
}

export function cleanTextSimulation(text: string | null | undefined): string {
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

/**
 * 单向等价：调用了 key 工具即隐含满足了全部 value 工具。
 * e.g. melee_attack 内部完成 skill_check + roll_dice + adjust_hp。
 * 反向不成立——调了 skill_check+roll_dice+adjust_hp 不算满足 melee_attack。
 */
export const TOOL_EQUIVALENTS: Record<string, string[]> = {
  'melee_attack': ['skill_check', 'roll_dice', 'adjust_hp'],
  'ranged_attack': ['skill_check', 'roll_dice', 'adjust_hp'],
}

/** requiredTools 满足判定：调用名按等价表展开后，required 逐一在场。 */
export function coversRequiredTools(calledNames: string[], required: string[]): { missing: string[] } {
  const expandedNames = calledNames.slice()
  for (let e = 0; e < calledNames.length; e++) {
    const equiv = TOOL_EQUIVALENTS[calledNames[e]]
    if (equiv) {
      for (let q = 0; q < equiv.length; q++) {
        if (expandedNames.indexOf(equiv[q]) < 0) expandedNames.push(equiv[q])
      }
    }
  }
  const missing: string[] = []
  for (let j = 0; j < required.length; j++) {
    if (expandedNames.indexOf(required[j]) < 0) {
      missing.push(required[j])
    }
  }
  return { missing }
}

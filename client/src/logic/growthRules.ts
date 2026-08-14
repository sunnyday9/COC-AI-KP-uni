/**
 * Placeholder for幕间成长/技能提升相关规则。
 *
 * TODO:
 * - 实现技能成长标记与发展检定：
 *   - 幕间阶段对已标记技能进行 D100 检定，大于当前值则 +1D10。
 *   - 技能达到 90% 时给予 2D6 SAN 奖励（配合 sanityHandler.adjust_san / Max SAN clamp）。
 *
 * 当前仅提供类型与占位函数，便于后续 TDD 与实现落地。
 */

export interface SkillGrowthMark {
  skillId: string
}

export interface DevelopmentResult {
  increasedSkills: Array<{ skillId: string; delta: number }>
}

export function applyDevelopmentPhase(_marks: SkillGrowthMark[]): DevelopmentResult {
  // Not implemented yet – see COC-KP-GAP-ANALYSIS.md Phase 2 规划。
  return { increasedSkills: [] }
}


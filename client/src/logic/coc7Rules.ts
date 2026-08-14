/**
 * COC 7th 规则公式（技能检定阈值与结果、成功等级）。
 * 与《守秘人规则书》第五章游戏系统一致，供 gameStore buildToolContext 与单元测试使用。
 */

export interface ResolveSkillCheckResult {
  threshold: number
  result: string
}

/** 技能检定：常规=技能值，困难=skill/2，极难=skill/5；大成功01，大失败 96+（skill<50）或 100（skill≥50） */
export function resolveSkillCheck(
  roll: number,
  skillValue: number,
  difficulty: string
): ResolveSkillCheckResult {
  const regular = skillValue
  const hard = Math.floor(skillValue / 2)
  const extreme = Math.floor(skillValue / 5)
  const threshold = difficulty === 'extreme' ? extreme : difficulty === 'hard' ? hard : regular
  const isFumble = skillValue < 50 ? roll >= 96 : roll === 100
  if (roll === 1) return { threshold, result: 'critical_success' }
  if (isFumble) return { threshold, result: 'fumble' }
  if (roll <= extreme) return { threshold, result: 'extreme_success' }
  if (roll <= hard) return { threshold, result: 'hard_success' }
  if (roll <= regular) return { threshold, result: 'regular_success' }
  return { threshold, result: 'failure' }
}

/** COC 成功等级（用于对抗检定比较，数值越大越优） */
export const SUCCESS_LEVEL_RANK: Record<string, number> = {
  critical_success: 6,
  extreme_success: 5,
  hard_success: 4,
  regular_success: 3,
  failure: 2,
  fumble: 1,
}

/** 技能检定结果中文标签 */
export const SKILL_CHECK_RESULT_TEXT: Record<string, string> = {
  critical_success: '大成功',
  extreme_success: '极难成功',
  hard_success: '困难成功',
  regular_success: '成功',
  failure: '失败',
  fumble: '大失败',
}

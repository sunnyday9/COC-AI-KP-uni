/**
 * COC7 自然恢复规则（简化实现）.
 *
 * 轻伤：每天自然恢复 1 HP（不超过 hpMax）。
 * 重伤：每“周”进行一次 CON 检定，成功时恢复 1D3 HP（不超过 hpMax）。
 *
 * 这里不做日历/时间管理，而是由调用方传入经过的天数/周数。
 */
export interface NaturalHealingState {
  hp: number
  hpMax: number
  con: number
  hasMajorWound: boolean
}

export interface NaturalHealingOptions {
  /** 经过的天数（用于轻伤每天 +1HP） */
  days?: number
  /** 经过的周数（用于重伤每周 CON 检定 1D3HP） */
  weeks?: number
  /**
   * 骰子与检定接口，由上层注入，方便在测试中替换为确定性的实现。
   */
  rollD100: () => number
  parseDiceExpr: (expr: string) => number
}

export interface NaturalHealingResult {
  hpBefore: number
  hpAfter: number
  totalHealed: number
}

export function applyNaturalHealing(
  state: NaturalHealingState,
  options: NaturalHealingOptions,
): NaturalHealingResult {
  const days = Math.max(0, Math.floor(options.days ?? 0))
  const weeks = Math.max(0, Math.floor(options.weeks ?? 0))
  let hp = Math.max(0, Math.min(state.hp, state.hpMax))
  const hpBefore = hp

  if (!state.hasMajorWound) {
    // 轻伤：每天 +1HP
    const heal = Math.min(days, state.hpMax - hp)
    hp += Math.max(0, heal)
  } else {
    // 重伤：每周一次 CON 检定，成功则 1D3 HP
    for (let i = 0; i < weeks; i++) {
      const roll = options.rollD100()
      if (roll <= state.con) {
        const gain = Math.max(0, options.parseDiceExpr('1d3'))
        const canHeal = state.hpMax - hp
        if (canHeal <= 0) break
        hp += Math.min(gain, canHeal)
      }
      if (hp >= state.hpMax) break
    }
  }

  const hpAfter = hp
  return {
    hpBefore,
    hpAfter,
    totalHealed: Math.max(0, hpAfter - hpBefore),
  }
}

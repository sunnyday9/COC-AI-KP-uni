import { describe, it, expect } from 'vitest'
import { applyNaturalHealing } from '../healingRules'

describe('healingRules natural healing', () => {
  it('轻伤角色在休息 1 天后自然恢复 1 HP（不超过 hpMax）', () => {
    const result = applyNaturalHealing(
      { hp: 5, hpMax: 10, con: 50, hasMajorWound: false },
      {
        days: 1,
        weeks: 0,
        rollD100: () => 50,
        parseDiceExpr: () => 1,
      },
    )
    expect(result.hpBefore).toBe(5)
    expect(result.hpAfter).toBe(6)
    expect(result.totalHealed).toBe(1)
  })

  it('轻伤角色多日休息时 HP 不会超过 hpMax', () => {
    const result = applyNaturalHealing(
      { hp: 9, hpMax: 10, con: 50, hasMajorWound: false },
      {
        days: 5,
        weeks: 0,
        rollD100: () => 50,
        parseDiceExpr: () => 1,
      },
    )
    expect(result.hpBefore).toBe(9)
    expect(result.hpAfter).toBe(10)
    expect(result.totalHealed).toBe(1)
  })

  it('重伤角色每周进行 CON 检定，成功时恢复 1D3 HP，失败时不恢复', () => {
    // 第一周成功 +2，第二周失败 0
    const rolls = [40, 80]
    let idx = 0
    const result = applyNaturalHealing(
      { hp: 3, hpMax: 10, con: 50, hasMajorWound: true },
      {
        days: 0,
        weeks: 2,
        rollD100: () => rolls[idx++],
        parseDiceExpr: () => 2,
      },
    )
    expect(result.hpBefore).toBe(3)
    expect(result.hpAfter).toBe(5)
    expect(result.totalHealed).toBe(2)
  })

  it('重伤角色在连续多周恢复中，HP 始终不会超过 hpMax', () => {
    const result = applyNaturalHealing(
      { hp: 8, hpMax: 10, con: 90, hasMajorWound: true },
      {
        days: 0,
        weeks: 10,
        rollD100: () => 10,
        parseDiceExpr: () => 3,
      },
    )
    expect(result.hpBefore).toBe(8)
    expect(result.hpAfter).toBe(10)
    expect(result.totalHealed).toBe(2)
  })
})


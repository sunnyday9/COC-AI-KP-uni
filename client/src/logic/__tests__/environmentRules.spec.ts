import { describe, it } from 'vitest'
import { computeEnvironmentDamage } from '../environmentRules'

describe('environmentRules (skeleton)', () => {
  it('computeEnvironmentDamage currently returns damageExpr \"0\" (placeholder)', () => {
    const result = computeEnvironmentDamage({ kind: 'fall', severity: 10 })
    // 占位断言：当前实现仅返回 \"0\"，后续实现规则后需更新此测试。
    if (result.damageExpr !== '0') {
      throw new Error('expected placeholder damageExpr to be \"0\"')
    }
  })
})


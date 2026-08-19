/**
 * growthRules (skeleton) — 迁自 client/src/logic/__tests__/growthRules.spec.ts（A1）
 */
import { describe, it } from 'vitest'
import { applyDevelopmentPhase } from '../../../shared/coc/growthRules'

describe('growthRules (skeleton)', () => {
  it('applyDevelopmentPhase currently returns empty increasedSkills (placeholder)', () => {
    const result = applyDevelopmentPhase([])
    // 占位断言：当前实现为空结果，便于未来按规则书替换为真实逻辑。
    if (result.increasedSkills.length !== 0) {
      throw new Error('expected no increased skills for placeholder implementation')
    }
  })
})

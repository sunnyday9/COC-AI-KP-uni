/**
 * 骰子服务 — rollD 范围
 * 迁自 client/src/services/__tests__/diceService.spec.ts（A1 规则引擎下沉）
 * （rollD100/cocResult/cocResultText 等死面已随 #90 删除：生产唯一消费方是本 spec 的
 *  自引用，且 cocResult 的固定 roll>=96 大失败与真源 coc7Rules.ts 的技能分档判定相悖——
 *  语义影子一并清除。）
 */
import { describe, it, expect } from 'vitest'
import { rollD } from '../../../shared/coc/diceService'

describe('rollD', () => {
  it('返回 1..sides 范围内', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollD(6)
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(6)
    }
    for (let i = 0; i < 20; i++) {
      const r = rollD(100)
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(100)
    }
  })
})

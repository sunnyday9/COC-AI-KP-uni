/**
 * 骰子服务 — rollD 范围、cocResult 大成功/大失败
 * 迁自 client/src/services/__tests__/diceService.spec.ts（A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import { rollD, rollD100, cocResult, cocResultText } from '../../../shared/coc/diceService'

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

describe('rollD100', () => {
  it('返回 1..100', () => {
    for (let i = 0; i < 30; i++) {
      const r = rollD100()
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(100)
    }
  })
})

describe('cocResult', () => {
  it('roll<=1 为 critical', () => {
    expect(cocResult(1, 50)).toBe('critical')
  })
  it('roll>=96 为 fumble（规则书大失败）', () => {
    expect(cocResult(96, 50)).toBe('fumble')
    expect(cocResult(100, 50)).toBe('fumble')
  })
  it('roll<=target 为 success', () => {
    expect(cocResult(50, 50)).toBe('success')
    expect(cocResult(25, 50)).toBe('success')
  })
  it('roll>target 且非 96+ 为 fail', () => {
    expect(cocResult(60, 50)).toBe('fail')
  })
})

describe('cocResultText', () => {
  it('返回中文标签', () => {
    expect(cocResultText('critical')).toBe('大成功')
    expect(cocResultText('fumble')).toBe('大失败')
    expect(cocResultText('success')).toBe('成功')
    expect(cocResultText('fail')).toBe('失败')
  })
})

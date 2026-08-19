/**
 * 第五章 幸运消耗、资源调整
 * 迁自 client/src/toolCalling/handlers/__tests__/resourceHandler.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import { resourceHandler } from '../../../src/rule-engine/handlers/resourceHandler.js'
import { createMockContext } from '../mockContext.js'

describe('resourceHandler spend_luck', () => {
  it('消耗 amount，角色 Luck 减少，返回 newLuck', () => {
    let luckDelta = 0
    const sheet = {
      attributes: { luck: 60 },
      derived: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      onUpdateLuck: (d) => { luckDelta = d },
    })
    const r = resourceHandler.handle('spend_luck', { amount: 15 }, ctx)
    expect(luckDelta).toBe(-15)
    const parsed = JSON.parse(r.content)
    expect(parsed.previousLuck).toBe(60)
    expect(parsed.newLuck).toBe(45)
    expect(parsed.spent).toBe(15)
  })

  it('adjust_mp 调用 updateCharacterMP', () => {
    let mpDelta = 0
    const ctx = createMockContext({ onUpdateMP: (d) => { mpDelta = d } })
    resourceHandler.handle('adjust_mp', { delta: -5 }, ctx)
    expect(mpDelta).toBe(-5)
  })

  it('adjust_mp 正数 delta 时 displayMessage 为 MP +N', () => {
    const ctx = createMockContext()
    const r = resourceHandler.handle('adjust_mp', { delta: 10 }, ctx)
    expect(r.displayMessages[0].content).toBe('MP +10')
  })
})

describe('resourceHandler spend_luck edge', () => {
  it('角色幸运为 0 时不调用 updateCharacterLuck 且 spent 为 0', () => {
    let luckDelta: number | undefined
    const sheet = {
      attributes: { luck: 0 },
      derived: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      onUpdateLuck: (d) => { luckDelta = d },
    })
    const r = resourceHandler.handle('spend_luck', { amount: 10 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.spent).toBe(0)
    expect(parsed.newLuck).toBe(0)
    expect(luckDelta).toBeUndefined()
  })
})

describe('resourceHandler unknown tool', () => {
  it('非 spend_luck/adjust_mp 等时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = resourceHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})

/**
 * 第五章 游戏系统 — 技能检定、对抗检定、投骰
 * 迁自 client/src/toolCalling/handlers/__tests__/checkHandler.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import { checkHandler } from '../../../src/rule-engine/handlers/checkHandler.js'
import { createMockContext } from '../mockContext.js'

describe('checkHandler skill_check', () => {
  it('常规难度 roll<=skill 为成功，返回 JSON 含 success、isPush', () => {
    const ctx = createMockContext({ rollSequence: [30] })
    const r = checkHandler.handle('skill_check', {
      skillName: '侦查',
      skillValue: 50,
      difficulty: 'regular',
    }, ctx)
    expect(r.displayMessages.length).toBe(1)
    const parsed = JSON.parse(r.content)
    expect(parsed.roll).toBe(30)
    expect(parsed.threshold).toBe(50)
    expect(parsed.success).toBe(true)
    expect(parsed.result).toBe('regular_success')
    expect(parsed.isPush).toBe(false)
  })

  it('isPush true 时返回中含 isPush', () => {
    const ctx = createMockContext({ rollSequence: [70] })
    const r = checkHandler.handle('skill_check', {
      skillName: '侦查',
      skillValue: 50,
      difficulty: 'regular',
      isPush: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.isPush).toBe(true)
  })

  it('roll_dice 返回 1..sides', () => {
    const ctx = createMockContext({ rollSequence: [4] })
    const r = checkHandler.handle('roll_dice', { sides: 6 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.roll).toBe(4)
    expect(parsed.sides).toBe(6)
    expect(r.displayMessages.length).toBe(1)
  })
})

describe('checkHandler opposed_check', () => {
  it('A 成功等级高于 B 时 winner 为 A', () => {
    const ctx = createMockContext({ rollSequence: [10, 80] })
    const r = checkHandler.handle('opposed_check', {
      sideAName: '攻击',
      sideAValue: 50,
      sideBName: '防御',
      sideBValue: 50,
      tieBreaker: 'attacker',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('A')
    expect(parsed.rollA).toBe(10)
    expect(parsed.rollB).toBe(80)
  })

  it('同级时按技能值，再同按 tieBreaker', () => {
    const ctx = createMockContext({ rollSequence: [50, 50] })
    const r = checkHandler.handle('opposed_check', {
      sideAName: 'A',
      sideAValue: 60,
      sideBName: 'B',
      sideBValue: 50,
      tieBreaker: 'attacker',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.resultA).toBe(parsed.resultB)
    expect(parsed.winner).toBe('A')
  })

  it('同级同技能值时按 tieBreaker 定胜者', () => {
    const ctx = createMockContext({ rollSequence: [50, 50] })
    const r = checkHandler.handle('opposed_check', {
      sideAName: 'A',
      sideAValue: 50,
      sideBName: 'B',
      sideBValue: 50,
      tieBreaker: 'defender',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.resultA).toBe(parsed.resultB)
    expect(parsed.winner).toBe('B')
  })

  it('双方同级失败（failure）时无人获胜（规则书 6238-6241）', () => {
    const ctx = createMockContext({ rollSequence: [70, 70] })
    const r = checkHandler.handle('opposed_check', {
      sideAName: 'A',
      sideAValue: 40,
      sideBName: 'B',
      sideBValue: 60,
      tieBreaker: 'attacker',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.resultA).toBe(parsed.resultB)
    expect(parsed.bothFailed).toBe(true)
    expect(parsed.winner).toBe('tie')
  })

  it('带奖惩骰时 displayMessage 含奖/惩标注', () => {
    const ctx = createMockContext({ rollSequence: [30, 70] })
    const r = checkHandler.handle('opposed_check', {
      sideAName: '攻',
      sideAValue: 50,
      sideABonusDice: 1,
      sideBName: '守',
      sideBValue: 50,
      sideBPenaltyDice: 1,
      tieBreaker: 'attacker',
    }, ctx)
    expect(r.displayMessages.length).toBe(1)
    expect(r.displayMessages[0].content).toMatch(/奖|惩/)
  })
})

describe('checkHandler unknown tool', () => {
  it('非 skill_check/opposed_check/roll_dice 时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = checkHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})

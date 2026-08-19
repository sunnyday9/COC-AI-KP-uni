/**
 * healing via combatHandler first_aid & medicine
 * 迁自 client/src/toolCalling/handlers/__tests__/healingHandler.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import { combatHandler } from '../../../src/rule-engine/handlers/combatHandler.js'
import { createMockContext } from '../mockContext.js'

describe('healing via combatHandler first_aid & medicine', () => {
  it('成功急救：受伤且濒死的角色被急救时，HP +1 并从濒死状态稳定为重伤', () => {
    let hpDelta = 0
    let dyingFlag: boolean | null = null
    const sheet: any = {
      derived: { hp: 0, hpMax: 10 },
      attributes: { con: 50 },
      hasMajorWound: true,
      isDying: true,
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateHP: (d) => {
        hpDelta += d
        sheet.derived.hp += d
      },
      onSetDying: (v) => {
        dyingFlag = v
        sheet.isDying = v
      },
    })

    const r = combatHandler.handle('first_aid', {}, ctx)
    const parsed = JSON.parse(r.content)

    expect(parsed.healed).toBe(1)
    expect(parsed.stabilized).toBe(true)
    expect(hpDelta).toBe(1)
    expect(sheet.derived.hp).toBe(1)
    expect(dyingFlag).toBe(false)
    expect(sheet.isDying).toBe(false)
  })

  it('急救失败：受伤且濒死的角色急救失败时，HP 与濒死状态不变，仅生成失败提示', () => {
    let hpDelta = 0
    let dyingFlag: boolean | null = null
    const sheet: any = {
      derived: { hp: 0, hpMax: 10 },
      attributes: { con: 50 },
      hasMajorWound: true,
      isDying: true,
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateHP: (d) => {
        hpDelta += d
        sheet.derived.hp += d
      },
      onSetDying: (v) => {
        dyingFlag = v
        sheet.isDying = v
      },
    })

    const r = combatHandler.handle('first_aid', { success: false }, ctx)
    const parsed = JSON.parse(r.content)

    expect(parsed.healed).toBe(0)
    expect(parsed.stabilized).toBe(false)
    expect(hpDelta).toBe(0)
    expect(sheet.derived.hp).toBe(0)
    expect(dyingFlag).toBeNull()
    expect(sheet.isDying).toBe(true)
    expect(r.displayMessages[0]?.content).toContain('急救失败')
  })

  it('医学成功：在医疗环境下，医学检定成功时 HP 增加 1D3（不超过 hpMax）', () => {
    let hpDelta = 0
    const sheet: any = {
      derived: { hp: 5, hpMax: 10 },
      attributes: { con: 50 },
      hasMajorWound: false,
      isDying: false,
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateHP: (d) => {
        hpDelta += d
        sheet.derived.hp += d
      },
    })

    const r = combatHandler.handle('medicine', { success: true, healExpr: '1d3' }, ctx)
    const parsed = JSON.parse(r.content)

    expect(parsed.healed).toBeGreaterThanOrEqual(1)
    expect(parsed.healed).toBeLessThanOrEqual(3)
    expect(sheet.derived.hp).toBeLessThanOrEqual(sheet.derived.hpMax)
    expect(hpDelta).toBe(parsed.healed)
    expect(r.displayMessages[0]?.content).toContain('医学治疗')
  })

  it('医学失败：医学检定失败时 HP 不变，仅生成失败提示', () => {
    let hpDelta = 0
    const sheet: any = {
      derived: { hp: 5, hpMax: 10 },
      attributes: { con: 50 },
      hasMajorWound: false,
      isDying: false,
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateHP: (d) => {
        hpDelta += d
        sheet.derived.hp += d
      },
    })

    const r = combatHandler.handle('medicine', { success: false }, ctx)
    const parsed = JSON.parse(r.content)

    expect(parsed.healed).toBe(0)
    expect(hpDelta).toBe(0)
    expect(sheet.derived.hp).toBe(5)
    expect(r.displayMessages[0]?.content).toContain('医学检定失败')
  })

  it('满血角色：HP 已等于 hpMax 时调用急救/医学不改变 HP，并提示无需治疗', () => {
    let hpDelta = 0
    const sheet: any = {
      derived: { hp: 10, hpMax: 10 },
      attributes: { con: 50 },
      hasMajorWound: false,
      isDying: false,
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateHP: (d) => {
        hpDelta += d
        sheet.derived.hp += d
      },
    })

    const r1 = combatHandler.handle('first_aid', { success: true }, ctx)
    const r2 = combatHandler.handle('medicine', { success: true }, ctx)

    expect(hpDelta).toBe(0)
    expect(sheet.derived.hp).toBe(10)
    expect(r1.displayMessages[0]?.content).toContain('无需急救')
    expect(r2.displayMessages[0]?.content).toContain('无需医学治疗')
  })
})

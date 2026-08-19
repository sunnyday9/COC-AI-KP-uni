/**
 * rulesHandler — 规则书补充工具单测：
 *  inspiration_check / cast_spell / read_tome / chase_turn / environment_damage / development_phase
 */
import { describe, it, expect } from 'vitest'
import { rulesHandler } from '../rulesHandler'
import { createMockContext } from '../../__tests__/mockContext'

describe('rulesHandler inspiration_check', () => {
  it('成功：无论成败都给出线索，成功无 setback', () => {
    const ctx = createMockContext({ rollSequence: [20] }) // INT 50 常规成功
    const r = rulesHandler.handle('inspiration_check', {
      skillValue: 50,
      difficulty: 'regular',
      clueDescription: '钥匙在书架的暗格里',
      setback: '被邪教徒发现',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.passed).toBe(true)
    expect(parsed.clueGiven).toBe('钥匙在书架的暗格里')
    expect(parsed.setback).toBe('')
  })

  it('失败：千钧一发 — 线索仍给出但伴随 setback', () => {
    const ctx = createMockContext({ rollSequence: [80] }) // INT 50 失败
    const r = rulesHandler.handle('inspiration_check', {
      skillValue: 50,
      difficulty: 'regular',
      clueDescription: '钥匙在书架的暗格里',
      setback: '被邪教徒发现',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.passed).toBe(false)
    expect(parsed.clueGiven).toBe('钥匙在书架的暗格里')
    expect(parsed.setback).toBe('被邪教徒发现')
  })
})

describe('rulesHandler cast_spell', () => {
  it('首次施放：困难 POW 检定成功，扣 MP+SAN', () => {
    let mp = 0
    let san = 0
    const ctx = createMockContext({
      rollSequence: [30], // POW 60 困难=30，成功
      characterSheet: {
        derived: { mp: 10, mpMax: 10, hp: 10, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onUpdateMP: (d) => { mp += d },
      onUpdateSAN: (d) => { san += d },
    })
    const r = rulesHandler.handle('cast_spell', {
      spellName: '克苏鲁之触',
      costMp: 3,
      costSan: 2,
      powValue: 60,
      firstCast: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.castResult).toBe('success')
    expect(parsed.mpPaid).toBe(3)
    expect(mp).toBe(-3)
    expect(san).toBe(-2)
  })

  it('MP 不足时溢出扣 HP（1:1）', () => {
    let mp = 0
    let hp = 0
    const ctx = createMockContext({
      rollSequence: [1], // 检定成功
      characterSheet: {
        derived: { mp: 2, mpMax: 10, hp: 8, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onUpdateMP: (d) => { mp += d },
      onUpdateHP: (d) => { hp += d },
    })
    const r = rulesHandler.handle('cast_spell', {
      spellName: '召唤',
      costMp: 5,
      costSan: 0,
      powValue: 60,
      firstCast: false,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.mpPaid).toBe(2)
    expect(parsed.mpOverflow).toBe(3)
    expect(parsed.hpDamage).toBe(3)
    expect(hp).toBe(-3)
  })

  it('首次施放失败未 push：法术未生效，提示可孤注一掷', () => {
    const ctx = createMockContext({ rollSequence: [80] }) // POW 60 困难=30，失败
    const r = rulesHandler.handle('cast_spell', {
      spellName: '变形术',
      costMp: 2,
      costSan: 1,
      powValue: 60,
      firstCast: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.castResult).toBe('failed_first_cast')
    expect(parsed.checkDetail).toContain('孤注一掷')
  })
})

describe('rulesHandler read_tome', () => {
  it('泛读成功：克苏鲁神话增长 + 自动 SAN 损失', () => {
    let mythosGain = 0
    let san = 0
    const ctx = createMockContext({
      rollSequence: [40], // 语言技能 60 成功
      characterSheet: {
        derived: { mp: 10, mpMax: 10, hp: 10, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onUpdateSAN: (d) => { san += d },
      onIncreaseCthulhuMythos: (g) => { mythosGain = g },
    })
    const r = rulesHandler.handle('read_tome', {
      tomeId: '死灵之书',
      mode: 'browse',
      languageSkill: 60,
      mythosCurrent: 5,
      mythosGain: 4,
      sanLossExpr: '1d6',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.mythosGained).toBe(4)
    expect(parsed.sanLost).toBeGreaterThan(0)
    expect(mythosGain).toBe(4)
    expect(san).toBeLessThan(0)
  })

  it('查资料：1D100 ≤ MR 找到神话知识', () => {
    const ctx = createMockContext({ rollSequence: [30] }) // MR 50
    const r = rulesHandler.handle('read_tome', {
      tomeId: '伊波恩之书',
      mode: 'consult',
      mythosCurrent: 50,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.consultFound).toBe(true)
  })
})

describe('rulesHandler chase_turn', () => {
  it('移动消耗行动点，险境失败扣行动点', () => {
    const ctx = createMockContext({ rollSequence: [90] }) // 险境检定失败
    const r = rulesHandler.handle('chase_turn', {
      participants: [{ name: '调查员', mov: 8, dex: 60, actionPoints: 2, location: 1 }],
      map: [{ id: 2, hazard: { skill: '敏捷', damageExpr: '1d6', difficulty: 'regular' } }],
      actions: [{ name: '调查员', action: 'move', targetLocation: 2, skillName: '敏捷', skillValue: 50 }],
      speedChecksDone: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.results[0].outcome).toContain('险境失败')
    expect(parsed.results[0].damageTaken).toBeGreaterThan(0)
  })
})

describe('rulesHandler environment_damage', () => {
  it('坠落按表Ⅲ 伤害', () => {
    const ctx = createMockContext({ rollSequence: [5] })
    const r = rulesHandler.handle('environment_damage', {
      kind: 'fall',
      severity: 'moderate',
      targetIsInvestigator: false,
    }, ctx)
    const parsed = JSON.parse(r.content)
    // mockContext parseDiceExpr 取 count*ceil(sides/2)：1d6 → 3
    expect(parsed.damageDealt).toBe(3)
  })

  it('溺水：CON 检定失败受伤害', () => {
    let hp = 0
    const ctx = createMockContext({
      rollSequence: [80],
      characterSheet: {
        derived: { mp: 10, mpMax: 10, hp: 10, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onUpdateHP: (d) => { hp += d },
    })
    const r = rulesHandler.handle('environment_damage', {
      kind: 'drowning',
      severity: 'moderate',
      conValue: 50,
      targetIsInvestigator: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.conPassed).toBe(false)
    expect(parsed.damageDealt).toBeGreaterThan(0)
    expect(hp).toBeLessThan(0)
  })
})

describe('rulesHandler development_phase', () => {
  it('成长检定：d100 > 当前值则 +1D10，可超 100%', () => {
    const grown: { id: string; v: number }[] = []
    const ctx = createMockContext({
      rollSequence: [80, 7], // 成长检定 80 > 70 → +7
      characterSheet: {
        derived: { mp: 10, mpMax: 10, hp: 10, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onGrowCharacterSkill: (id, v) => { grown.push({ id, v }) },
    })
    const r = rulesHandler.handle('development_phase', {
      growthSkills: [{ name: '侦查', value: 70 }],
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.growthResults[0].grew).toBe(true)
    expect(parsed.growthResults[0].gain).toBe(7)
    expect(parsed.growthResults[0].newValue).toBe(77)
    expect(grown[0]).toEqual({ id: '侦查', v: 77 })
  })

  it('技能达 90%+ 奖励 +2D6 SAN', () => {
    let san = 0
    const ctx = createMockContext({
      rollSequence: [99, 6, 4], // 99 > 95 → 成长；+1D10=6；90% 奖励 2D6=4
      characterSheet: {
        derived: { mp: 10, mpMax: 10, hp: 10, hpMax: 10, san: 60, sanMax: 60 },
        attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 50, luck: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      },
      onUpdateSAN: (d) => { san += d },
    })
    const r = rulesHandler.handle('development_phase', {
      growthSkills: [{ name: '格斗', value: 85 }],
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.growthResults[0].grew).toBe(true)
    expect(parsed.growthResults[0].newValue).toBe(91)
    expect(parsed.sanReward).toBeGreaterThan(0)
    expect(san).toBeGreaterThan(0)
  })
})

/**
 * 第六章 战斗 — 近战、远程、重伤/濒死/即死
 * 迁自 client/src/toolCalling/handlers/__tests__/combatHandler.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect, vi } from 'vitest'
import { combatHandler } from '../../../src/rule-engine/handlers/combatHandler.js'
import { createMockContext } from '../mockContext.js'

describe('combatHandler apply_major_wound', () => {
  it('单次伤害 > HP 最大值时为即死，设置 majorWound 与 dying', () => {
    let majorWound = false
    let dying = false
    const ctx = createMockContext({
      onSetMajorWound: (v) => { majorWound = v },
      onSetDying: (v) => { dying = v },
    })
    const r = combatHandler.handle('apply_major_wound', {
      hpMax: 10,
      damageDealt: 12,
      hpAfter: 0,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.instantDeath).toBe(true)
    expect(parsed.hasMajorWound).toBe(true)
    expect(parsed.isDying).toBe(true)
    expect(majorWound).toBe(true)
    expect(dying).toBe(true)
  })

  it('伤害 >= HP/2 且 hpAfter<=0 为重伤+濒死', () => {
    let dying = false
    const ctx = createMockContext({
      rollSequence: [99],
      onSetDying: (v) => { dying = v },
    })
    const r = combatHandler.handle('apply_major_wound', {
      hpMax: 10,
      damageDealt: 5,
      hpAfter: 0,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.instantDeath).toBe(false)
    expect(parsed.hasMajorWound).toBe(true)
    expect(parsed.isDying).toBe(true)
    expect(dying).toBe(true)
  })
})

describe('combatHandler melee_attack', () => {
  it('调查员为败方时扣 HP', () => {
    let hpDelta = 0
    const ctx = createMockContext({
      rollSequence: [10, 80, 3],
      characterSheet: {
        derived: { hp: 10, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      onUpdateHP: (d) => { hpDelta = d },
    })
    const r = combatHandler.handle('melee_attack', {
      sideAName: 'NPC',
      sideAValue: 50,
      sideBName: '调查员',
      sideBValue: 50,
      tieBreaker: 'attacker',
      damageExpr: '1d6',
      investigatorSide: 'B',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('A')
    expect(parsed.investigatorTookDamage).toBe(true)
    expect(parsed.damageDealt).toBeGreaterThanOrEqual(0)
    expect(hpDelta).toBe(-parsed.damageDealt)
  })

  it('B 胜时用 defenderDamageBonus 计算伤害', () => {
    const ctx = createMockContext({
      rollSequence: [80, 10, 2],
      characterSheet: {
        derived: { hp: 10, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
    })
    const r = combatHandler.handle('melee_attack', {
      sideAName: '怪物',
      sideAValue: 50,
      sideBName: '调查员',
      sideBValue: 50,
      tieBreaker: 'defender',
      damageExpr: '1d6',
      defenderDamageBonus: '0',
      investigatorSide: 'B',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('B')
    expect(parsed.investigatorTookDamage).toBe(false)
    expect(parsed.damageDealt).toBeGreaterThanOrEqual(0)
  })

  it('调查员败方且重伤时 CON 检定失败则昏迷', () => {
    let hpDelta = 0
    const ctx = createMockContext({
      rollSequence: [30, 80, 99], // rollA=30（技能50普通成功），rollB=80（失败），CON=99（失败）
      characterSheet: {
        derived: { hp: 5, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      onUpdateHP: (d) => { hpDelta = d },
    })
    const r = combatHandler.handle('melee_attack', {
      sideAName: 'NPC',
      sideAValue: 50,
      sideBName: '调查员',
      sideBValue: 50,
      damageExpr: '2d6',
      investigatorSide: 'B',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('A')
    expect(hpDelta).toBeLessThan(0)
    const hasConFail = r.displayMessages.some((m: { content?: string }) =>
      typeof m.content === 'string' && m.content.includes('CON') && m.content.includes('昏迷')
    )
    expect(hasConFail).toBe(true)
  })
})

describe('combatHandler unknown tool', () => {
  it('非 melee_attack/ranged_attack/adjust_hp/apply_major_wound 时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = combatHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})

describe('combatHandler ranged_attack', () => {
  it('命中、调查员受伤且重伤时 CON 检定失败则昏迷', () => {
    let dying = false
    const ctx = createMockContext({
      rollSequence: [25, 99],
      characterSheet: {
        derived: { hp: 4, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      onUpdateHP: vi.fn(),
      onSetMajorWound: vi.fn(),
      onSetDying: (v) => { dying = v },
    })
    const r = combatHandler.handle('ranged_attack', {
      skillName: '射击',
      skillValue: 50,
      difficulty: 'regular',
      damageExpr: '2d6',
      targetArmor: 0,
      targetIsInvestigator: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.hit).toBe(true)
    expect(parsed.damageDealt).toBeGreaterThanOrEqual(5)
    const hasConFail = r.displayMessages.some((m: { content?: string }) =>
      typeof m.content === 'string' && m.content.includes('CON') && m.content.includes('昏迷')
    )
    expect(hasConFail).toBe(true)
  })

  it('命中且 targetIsInvestigator 时扣 HP', () => {
    let hpDelta = 0
    const ctx = createMockContext({
      rollSequence: [30, 4],
      characterSheet: {
        derived: { hp: 10, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      onUpdateHP: (d) => { hpDelta = d },
    })
    const r = combatHandler.handle('ranged_attack', {
      skillName: '枪械',
      skillValue: 50,
      difficulty: 'regular',
      damageExpr: '1d6',
      targetArmor: 0,
      targetIsInvestigator: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.hit).toBe(true)
    if (parsed.damageDealt > 0) {
      expect(hpDelta).toBe(-parsed.damageDealt)
    }
  })

  it('近战双方都失败（failure）时无人受伤（规则书 6238-6241）', () => {
    let hpDelta = 0
    const ctx = createMockContext({
      rollSequence: [80, 90], // 双方普通失败（技能 50）
      characterSheet: {
        derived: { hp: 10, hpMax: 10 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      onUpdateHP: (d) => { hpDelta = d },
    })
    const r = combatHandler.handle('melee_attack', {
      sideAName: '调查员',
      sideAValue: 50,
      sideBName: 'NPC',
      sideBValue: 50,
      tieBreaker: 'attacker',
      damageExpr: '1d6',
      attackerDamageBonus: '0',
      defenderDamageBonus: '0',
      investigatorSide: 'A',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('tie')
    expect(parsed.damageDealt).toBe(0)
    expect(hpDelta).toBe(0)
  })

  it('近战极难成功 + 贯穿武器：伤害取满再骰一份（规则书 6263-6285）', () => {
    // rollA=1（critical，技能 10 → 极难阈值 2 命中），rollB=90（失败），
    // 贯穿额外骰 1d6；mockContext 的 parseDiceExpr 取 count*ceil(sides/2)=3
    const ctx = createMockContext({
      rollSequence: [1, 90, 3],
      characterSheet: null,
    })
    const r = combatHandler.handle('melee_attack', {
      sideAName: '调查员',
      sideAValue: 10,
      sideBName: 'NPC',
      sideBValue: 50,
      tieBreaker: 'attacker',
      damageExpr: '1d6',
      attackerDamageBonus: '+1d4',
      defenderDamageBonus: '0',
      investigatorSide: 'A',
      isImpaling: true,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.winner).toBe('A')
    // 极难/大成功：1d6 取满 6 + 贯穿额外 1d6(=3) + DB +1d4 取满 4 = 13
    expect(parsed.damageDealt).toBe(13)
  })
})

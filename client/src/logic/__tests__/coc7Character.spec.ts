/**
 * 调查员手册 — 角色创建与衍生数据（职业技能、兴趣技能、合并、衍生、伤害加值/体格）
 */
import { describe, it, expect } from 'vitest'
import {
  buildOccupationSkills,
  buildPersonalInterestSkills,
  mergeSkills,
  rollAttributes,
  getDerivedSkillValues,
  getDamageBonusAndBuild,
  computeDerivedStats,
  buildCharacterSheet,
  getSkillBase,
} from '../coc7Character'
import type { COCAttributes } from '../../types/character'

describe('职业技能 buildOccupationSkills', () => {
  it('9 项与 OCCUPATION_SKILL_VALUES 一一对应', () => {
    const keys = ['Fighting', 'Firearms', 'Spot Hidden', 'Dodge', 'Listen', 'Library Use', 'Credit Rating', 'Persuade', 'Psychology']
    const out = buildOccupationSkills(keys)
    expect(Object.keys(out)).toHaveLength(9)
    expect(out['Fighting']).toBe(70)
    expect(out['Firearms']).toBe(60)
    expect(out['Spot Hidden']).toBe(60)
    expect(out['Credit Rating']).toBe(40)
  })

  it('不足 9 项时只分配已有', () => {
    const out = buildOccupationSkills(['Fighting', 'Dodge'])
    expect(out['Fighting']).toBe(70)
    expect(out['Dodge']).toBe(60)
    expect(Object.keys(out)).toHaveLength(2)
  })

  it('可传入自定义 values', () => {
    const out = buildOccupationSkills(['Fighting', 'Dodge'], [80, 70])
    expect(out['Fighting']).toBe(80)
    expect(out['Dodge']).toBe(70)
  })
})

describe('兴趣技能 buildPersonalInterestSkills', () => {
  it('4 项在基础值上 +20，上限 99', () => {
    const out = buildPersonalInterestSkills(['Spot Hidden', 'Listen', 'Stealth', 'Climb'])
    expect(Object.keys(out)).toHaveLength(4)
    expect(out['Spot Hidden']).toBe(25 + 20)
    expect(out['Listen']).toBe(20 + 20)
    expect(out['Stealth']).toBe(20 + 20)
    expect(out['Climb']).toBe(20 + 20)
  })

  it('基础值 + 20 超过 99 时取 99', () => {
    const out = buildPersonalInterestSkills(['Fighting']) // base 25, 25+20=45
    expect(out['Fighting']).toBeLessThanOrEqual(99)
  })
})

describe('职业+兴趣合并 mergeSkills', () => {
  it('同技能既职业又兴趣时取职业值 + 20', () => {
    const occ = { Fighting: 70 }
    const pers = { Fighting: 25 + 20 }
    const merged = mergeSkills(occ, pers)
    expect(merged['Fighting']).toBe(70 + 20)
    expect(merged['Fighting']).toBe(90)
  })

  it('仅职业或仅兴趣时保留原值', () => {
    const occ = { Fighting: 70, Firearms: 60 }
    const pers = { Stealth: 40 }
    const merged = mergeSkills(occ, pers)
    expect(merged['Fighting']).toBe(70)
    expect(merged['Firearms']).toBe(60)
    expect(merged['Stealth']).toBe(40)
  })
})

describe('衍生技能 getDerivedSkillValues', () => {
  it('母语 = EDU，闪避 = DEX/2', () => {
    const attrs: COCAttributes = {
      str: 50, con: 50, siz: 50, dex: 60, app: 50, int: 50, pow: 50, edu: 75, luck: 50,
    }
    const out = getDerivedSkillValues(attrs)
    expect(out['Language (Own)']).toBe(75)
    expect(out['Dodge']).toBe(30)
  })
})

describe('第六章 战斗 - 伤害加值/体格 getDamageBonusAndBuild', () => {
  it('STR+SIZ 12 → -2, build -2', () => {
    const r = getDamageBonusAndBuild(6, 6)
    expect(r.damageBonus).toBe('-2')
    expect(r.build).toBe(-2)
  })
  it('STR+SIZ 16 → -1, build -1', () => {
    const r = getDamageBonusAndBuild(8, 8)
    expect(r.damageBonus).toBe('-1')
    expect(r.build).toBe(-1)
  })
  it('STR+SIZ 24 → 0, build 0', () => {
    const r = getDamageBonusAndBuild(12, 12)
    expect(r.damageBonus).toBe('0')
    expect(r.build).toBe(0)
  })
  it('STR+SIZ 32 → +1D4, build 1', () => {
    const r = getDamageBonusAndBuild(16, 16)
    expect(r.damageBonus).toBe('+1D4')
    expect(r.build).toBe(1)
  })
  it('STR+SIZ 40 → +1D6, build 2', () => {
    const r = getDamageBonusAndBuild(20, 20)
    expect(r.damageBonus).toBe('+1D6')
    expect(r.build).toBe(2)
  })
  it('STR+SIZ 56 → +2D6, build 3', () => {
    const r = getDamageBonusAndBuild(28, 28)
    expect(r.damageBonus).toBe('+2D6')
    expect(r.build).toBe(3)
  })
})

describe('computeDerivedStats', () => {
  it('HP=(CON+SIZ)/10, MP=POW/5, SAN=POW', () => {
    const attrs: COCAttributes = {
      str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 65, edu: 50, luck: 50,
    }
    const d = computeDerivedStats(attrs)
    expect(d.hpMax).toBe(Math.floor((50 + 50) / 10))
    expect(d.mpMax).toBe(Math.floor(65 / 5))
    expect(d.sanMax).toBe(65)
    expect(d.hp).toBe(d.hpMax)
    expect(d.san).toBe(d.sanMax)
  })
})

describe('rollAttributes', () => {
  it('返回全部 9 项属性且为数字', () => {
    const r = rollAttributes()
    const keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck']
    expect(Object.keys(r).sort()).toEqual([...keys].sort())
    keys.forEach((k) => {
      expect(typeof (r as unknown as Record<string, number>)[k]).toBe('number')
      expect((r as unknown as Record<string, number>)[k]).toBeGreaterThanOrEqual(1)
      expect((r as unknown as Record<string, number>)[k]).toBeLessThanOrEqual(99)
    })
  })
})

describe('buildCharacterSheet', () => {
  it('合并职业/兴趣技能、衍生属性、伤害加值并返回完整角色卡', () => {
    const attrs: COCAttributes = {
      str: 40, con: 50, siz: 50, dex: 60, app: 50, int: 50, pow: 50, edu: 60, luck: 50,
    }
    const sheet = buildCharacterSheet(
      'occ1',
      '医生',
      '玩家A',
      ['Fighting', 'Firearms', 'Spot Hidden', 'Dodge', 'Listen', 'Library Use', 'Credit Rating', 'Persuade', 'Psychology'],
      ['Stealth', 'Climb', 'Jump', 'Swim'],
      attrs
    )
    expect(sheet.occupationId).toBe('occ1')
    expect(sheet.playerName).toBe('玩家A')
    expect(sheet.attributes).toEqual(attrs)
    expect(sheet.derived.hpMax).toBe(10)
    expect(sheet.derived.sanMax).toBe(50)
    expect(sheet.skills['Language (Own)']).toBe(60)
    expect(sheet.skills['Dodge']).toBe(50)
    expect(sheet.damageBonus).toBeDefined()
    expect(sheet.build).toBeDefined()
    expect(sheet.armor).toBe(0)
    expect(sheet.insanityState).toBe('normal')
    expect(sheet.weapons).toEqual([])
  })
})

describe('getSkillBase', () => {
  it('已知技能 id 返回基础值', () => {
    expect(getSkillBase('Fighting')).toBe(25)
    expect(getSkillBase('Library Use')).toBe(20)
  })

  it('未知技能 id 返回 0', () => {
    expect(getSkillBase('UnknownSkill')).toBe(0)
  })
})

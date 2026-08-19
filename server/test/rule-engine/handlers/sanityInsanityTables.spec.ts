/**
 * 第八章 理智 — 发作表（表Ⅶ/Ⅷ）与 trigger_insanity 症状返回。
 * 迁自 client/src/toolCalling/handlers/__tests__/sanityInsanityTables.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import {
  IMMEDIATE_BOUT_SYMPTOMS,
  SUMMARY_BOUT_SYMPTOMS,
  rollImmediateSymptom,
  rollSummarySymptom,
} from '../../../../shared/coc/insanityTables.js'
import { sanityHandler } from '../../../src/rule-engine/handlers/sanityHandler.js'
import { createMockContext } from '../mockContext.js'

describe('insanityTables', () => {
  it('表Ⅶ 即时症状 10 项完整且 roll 1-10 唯一', () => {
    expect(IMMEDIATE_BOUT_SYMPTOMS).toHaveLength(10)
    expect(new Set(IMMEDIATE_BOUT_SYMPTOMS.map((s) => s.roll)).size).toBe(10)
    for (const s of IMMEDIATE_BOUT_SYMPTOMS) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('表Ⅷ 总结症状 10 项完整', () => {
    expect(SUMMARY_BOUT_SYMPTOMS).toHaveLength(10)
    expect(new Set(SUMMARY_BOUT_SYMPTOMS.map((s) => s.roll)).size).toBe(10)
  })

  it('roll 1-10 映射正确，越界钳制', () => {
    expect(rollImmediateSymptom(1).name).toBe('失忆')
    expect(rollImmediateSymptom(10).name).toBe('躁狂')
    expect(rollSummarySymptom(9).name).toBe('恐惧')
    expect(rollImmediateSymptom(0).roll).toBe(1)
    expect(rollImmediateSymptom(99).roll).toBe(10)
  })
})

describe('sanityHandler trigger_insanity 发作表', () => {
  it('临时疯狂（summary 默认）：返回具体症状与描述', () => {
    let state = 'normal'
    const ctx = createMockContext({
      rollSequence: [30, 6], // INT 检定成功（30 ≤ 60），boutRoll=6
      characterSheet: {
        derived: { hp: 10, hpMax: 10, san: 50, sanMax: 99 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
      } as any,
      onInsanityState: (s) => { state = s },
    })
    const r = sanityHandler.handle('trigger_insanity', {
      sanLost: 5,
      intValue: 60,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('temporary')
    expect(state).toBe('temporary')
    expect(parsed.boutStyle).toBe('summary')
    expect(parsed.boutRoll).toBe(6)
    expect(parsed.symptom.name).toBe('重要之人')
    expect(parsed.symptom.description).toContain('最重要的人')
  })

  it('boutStyle=immediate 使用即时症状表', () => {
    const ctx = createMockContext({
      rollSequence: [30, 2], // INT 成功，boutRoll=2
      characterSheet: {
        derived: { hp: 10, hpMax: 10, san: 50, sanMax: 99 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
      } as any,
    })
    const r = sanityHandler.handle('trigger_insanity', {
      sanLost: 5,
      intValue: 60,
      boutStyle: 'immediate',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.boutStyle).toBe('immediate')
    expect(parsed.symptom.name).toBe('假性残疾')
  })

  it('boutRoll=9 获得恐惧症（来自表Ⅸ）', () => {
    const ctx = createMockContext({
      rollSequence: [30, 9, 3], // INT 成功，boutRoll=9，D100=3
      characterSheet: {
        derived: { hp: 10, hpMax: 10, san: 50, sanMax: 99 },
        attributes: { con: 50 },
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
      } as any,
    })
    const r = sanityHandler.handle('trigger_insanity', {
      sanLost: 5,
      intValue: 60,
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.phobiaAdded).toBeTruthy()
    expect(parsed.phobiaAdded).not.toBe('随机恐惧症')
  })
})

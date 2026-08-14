/**
 * 第八章 理智 — SAN 检定、疯狂判定、新日重置
 */
import { describe, it, expect } from 'vitest'
import { sanityHandler } from '../sanityHandler'
import { createMockContext } from '../../__tests__/mockContext'

describe('sanityHandler san_check', () => {
  it('失败时扣 failureLoss 并累加当日 SAN', () => {
    let sanDelta = 0
    let dailyAdded = 0
    const ctx = createMockContext({
      rollSequence: [80],
      onUpdateSAN: (d) => { sanDelta = d },
      onAddDailySanLoss: (a) => { dailyAdded = a },
    })
    const r = sanityHandler.handle('san_check', {
      currentSan: 50,
      successLoss: '0',
      failureLoss: '1d6',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.passed).toBe(false)
    expect(parsed.sanLost).toBeGreaterThanOrEqual(1)
    expect(sanDelta).toBe(-parsed.sanLost)
    expect(dailyAdded).toBe(parsed.sanLost)
  })

  it('大失败(roll=100)时按 failureLoss 表达式解析损失', () => {
    let sanDelta = 0
    const ctx = createMockContext({
      rollSequence: [100],
      onUpdateSAN: (d) => { sanDelta = d },
    })
    const r = sanityHandler.handle('san_check', {
      currentSan: 50,
      successLoss: '0',
      failureLoss: '2d10',
    }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.isFumble).toBe(true)
    expect(parsed.sanLost).toBeGreaterThanOrEqual(1)
    expect(sanDelta).toBe(-parsed.sanLost)
  })
})

describe('sanityHandler trigger_insanity', () => {
  it('SAN 归零时为永久疯狂', () => {
    let state = ''
    const sheet = {
      derived: { san: 0 },
      dailySanLoss: 0,
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      onInsanityState: (s) => { state = s },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 5, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('permanent')
    expect(state).toBe('permanent')
  })

  it('当日 SAN 损失达 1/5 时为不定性疯狂', () => {
    let state = ''
    const sheet = {
      derived: { san: 10 },
      dailySanLoss: 2,
      phobias: [],
      manias: [],
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      rollSequence: [5],
      onInsanityState: (s) => { state = s },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 0, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('indefinite')
    expect(state).toBe('indefinite')
  })

  it('sanLost>=5 且 INT 检定成功为临时疯狂', () => {
    let state = ''
    const sheet = {
      derived: { san: 30 },
      dailySanLoss: 0,
      phobias: [],
      manias: [],
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      rollSequence: [25, 3],
      onInsanityState: (s) => { state = s },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 6, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('temporary')
    expect(state).toBe('temporary')
  })

  it('不定性疯狂 1D10=9 时添加恐惧症', () => {
    const sheet = {
      derived: { san: 10 },
      dailySanLoss: 2,
      phobias: [] as string[],
      manias: [] as string[],
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      rollSequence: [9],
      onInsanityState: (_s, phobias) => { if (phobias?.length) sheet.phobias = phobias },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 0, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('indefinite')
    expect(parsed.phobiaAdded).toBe('随机恐惧症')
  })

  it('不定性疯狂 1D10=10 时添加躁狂症', () => {
    const sheet = {
      derived: { san: 10 },
      dailySanLoss: 2,
      phobias: [] as string[],
      manias: [] as string[],
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      rollSequence: [10],
      onInsanityState: (_s, _p, manias) => { if (manias?.length) sheet.manias = manias },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 0, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('indefinite')
    expect(parsed.maniaAdded).toBe('随机躁狂症')
  })

  it('临时疯狂 1D10=9 时添加恐惧症', () => {
    let state = ''
    const ctx = createMockContext({
      characterSheet: {
        derived: { san: 30 },
        dailySanLoss: 0,
        phobias: [],
        manias: [],
        attributes: {},
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      rollSequence: [20, 9],
      onInsanityState: (s) => { state = s },
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 6, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('temporary')
    expect(parsed.phobiaAdded).toBe('随机恐惧症')
    expect(state).toBe('temporary')
  })

  it('临时疯狂 1D10=10 时添加躁狂症', () => {
    const ctx = createMockContext({
      characterSheet: {
        derived: { san: 30 },
        dailySanLoss: 0,
        phobias: [],
        manias: [],
        attributes: {},
        skills: {},
        occupationSkillKeys: [],
        personalInterestKeys: [],
        playerName: '',
        occupationId: '',
        occupationName: '',
      } as any,
      rollSequence: [20, 10],
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 6, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('temporary')
    expect(parsed.maniaAdded).toBe('随机躁狂症')
  })

  it('sanLost>=5 且 INT 检定失败为压抑', () => {
    const sheet = {
      derived: { san: 30 },
      dailySanLoss: 0,
      phobias: [],
      manias: [],
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet as any,
      rollSequence: [60],
    })
    const r = sanityHandler.handle('trigger_insanity', { sanLost: 6, intValue: 50 }, ctx)
    const parsed = JSON.parse(r.content)
    expect(parsed.insanityState).toBe('normal')
    expect(parsed.boutText).toContain('压抑')
  })
})

describe('sanityHandler adjust_san', () => {
  it('调用 updateCharacterSAN 与 addCharacterDailySanLoss(delta<0)', () => {
    let sanDelta = 0
    let dailyAdded = 0
    const ctx = createMockContext({
      onUpdateSAN: (d) => { sanDelta = d },
      onAddDailySanLoss: (a) => { dailyAdded = a },
    })
    const r = sanityHandler.handle('adjust_san', { delta: -3 }, ctx)
    expect(sanDelta).toBe(-3)
    expect(dailyAdded).toBe(3)
    expect(r.content).toContain('adjusted')
  })

  it('delta>=0 时只更新 SAN 不累加当日损失', () => {
    let sanDelta = 0
    let dailyAdded = 0
    const ctx = createMockContext({
      onUpdateSAN: (d) => { sanDelta = d },
      onAddDailySanLoss: (a) => { dailyAdded = a },
    })
    sanityHandler.handle('adjust_san', { delta: 5 }, ctx)
    expect(sanDelta).toBe(5)
    expect(dailyAdded).toBe(0)
  })
})

describe('sanityHandler Max SAN clamp', () => {
  it('当 cthulhuMythos 存在时，SAN 提升不会超过 Max SAN = 99 - cthulhuMythos', () => {
    let sanDelta = 0
    const sheet: any = {
      derived: { san: 95, sanMax: 99 },
      cthulhuMythos: 10,
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateSAN: (d) => {
        sanDelta += d
        sheet.derived.san += d
      },
    })
    sanityHandler.handle('adjust_san', { delta: 10 }, ctx)
    // Max SAN = 99 - 10 = 89，初始 95，应被 clamp 到 89
    expect(sheet.derived.san).toBe(89)
  })

  it('当 cthulhuMythos 提升导致 Max SAN 下降时，当前 SAN 被重新 clamp 到新的 Max SAN', () => {
    let sanDelta = 0
    const sheet: any = {
      derived: { san: 90, sanMax: 99 },
      cthulhuMythos: 0,
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateSAN: (d) => {
        sanDelta += d
        sheet.derived.san += d
      },
    })
    // 模拟神话值变为 20 之后再进行一次正向 SAN 调整触发 clamp
    sheet.cthulhuMythos = 20
    sanityHandler.handle('adjust_san', { delta: 1 }, ctx)
    // 新 Max SAN = 99 - 20 = 79
    expect(sheet.derived.san).toBe(79)
    expect(sanDelta).toBeLessThanOrEqual(0)
  })

  it('负向 SAN 变化（delta<0）时不受 Max SAN 限制，按原规则扣减', () => {
    let sanDelta = 0
    let daily = 0
    const sheet: any = {
      derived: { san: 50, sanMax: 99 },
      cthulhuMythos: 40,
      attributes: {},
      skills: {},
      occupationSkillKeys: [],
      personalInterestKeys: [],
      playerName: '',
      occupationId: '',
      occupationName: '',
    }
    const ctx = createMockContext({
      characterSheet: sheet,
      onUpdateSAN: (d) => {
        sanDelta += d
        sheet.derived.san += d
      },
      onAddDailySanLoss: (a) => {
        daily += a
      },
    })
    sanityHandler.handle('adjust_san', { delta: -7 }, ctx)
    expect(sheet.derived.san).toBe(43)
    expect(sanDelta).toBe(-7)
    expect(daily).toBe(7)
  })
})

describe('sanityHandler reset_day', () => {
  it('调用 resetCharacterDailySanLoss', () => {
    let reset = false
    const ctx = createMockContext({ onResetDailySanLoss: () => { reset = true } })
    const r = sanityHandler.handle('reset_day', {}, ctx)
    expect(reset).toBe(true)
    expect(r.content).toContain('reset')
  })
})

describe('sanityHandler unknown tool', () => {
  it('非 san_check/trigger_insanity/adjust_san/reset_day 时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = sanityHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})

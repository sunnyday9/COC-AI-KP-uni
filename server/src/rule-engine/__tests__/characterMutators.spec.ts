/**
 * CharacterMutators 工厂直测（架构评审候选 1 / D-34）——
 * 15 个 sheet 变更语义的唯一实现：钳制/累加/状态写入/通知。
 */
import { describe, expect, it, vi } from 'vitest'
import { createCharacterMutatorFactory } from '../characterMutators.js'
import type { COCCharacterSheet } from '../../../../shared/types/character.js'

function makeSheet(): COCCharacterSheet {
  return {
    playerName: '测试员',
    derived: { hp: 10, hpMax: 12, mp: 6, mpMax: 6, san: 60, sanMax: 99 },
    attributes: { luck: 50 },
    skills: {},
    insanityState: 'normal',
  } as unknown as COCCharacterSheet
}

describe('createCharacterMutatorFactory', () => {
  it('HP/MP/SAN/幸运 负值钳制到 0（正负增量对称）', () => {
    const sheet = makeSheet()
    const m = createCharacterMutatorFactory({ resolveSheet: () => sheet })(null)
    m.updateCharacterHP(-99)
    expect(sheet.derived!.hp).toBe(0)
    m.updateCharacterHP(5)
    expect(sheet.derived!.hp).toBe(5)
    m.updateCharacterMP(-99)
    expect(sheet.derived!.mp).toBe(0)
    m.updateCharacterSAN(-99)
    expect(sheet.derived!.san).toBe(0)
    m.updateCharacterLuck(-99)
    expect(sheet.attributes!.luck).toBe(0)
  })

  it('dailySanLoss 累加与重置', () => {
    const sheet = makeSheet()
    const m = createCharacterMutatorFactory({ resolveSheet: () => sheet })(null)
    m.addCharacterDailySanLoss(3)
    m.addCharacterDailySanLoss(4)
    expect(sheet.dailySanLoss).toBe(7)
    m.resetCharacterDailySanLoss()
    expect(sheet.dailySanLoss).toBe(0)
  })

  it('疯狂状态写入（含 phobias/manias）与重伤/濒死', () => {
    const sheet = makeSheet()
    const m = createCharacterMutatorFactory({ resolveSheet: () => sheet })(null)
    m.updateCharacterInsanityState('temporary', ['恐水'], ['数数'])
    expect(sheet.insanityState).toBe('temporary')
    expect(sheet.phobias).toEqual(['恐水'])
    expect(sheet.manias).toEqual(['数数'])
    m.setCharacterMajorWound(true)
    m.setCharacterDying(true)
    expect(sheet.hasMajorWound).toBe(true)
    expect(sheet.isDying).toBe(true)
  })

  it('技能成长与克苏鲁神话', () => {
    const sheet = makeSheet()
    const m = createCharacterMutatorFactory({ resolveSheet: () => sheet })(null)
    m.growCharacterSkill('侦查', 65)
    m.increaseCthulhuMythos(3)
    expect(sheet.skills!['侦查']).toBe(65)
    expect(sheet.cthulhuMythos).toBe(3)
  })

  it('resolveSheet 无卡 → 变更跳过且不通知', () => {
    const onSheetMutated = vi.fn()
    const m = createCharacterMutatorFactory({ resolveSheet: () => null, onSheetMutated })(null)
    m.updateCharacterHP(-5)
    expect(onSheetMutated).not.toHaveBeenCalled()
  })

  it('onSheetMutated 携带 characterId 与变更后 sheet', () => {
    const sheet = makeSheet()
    const onSheetMutated = vi.fn()
    const factory = createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'char_a' ? sheet : null), onSheetMutated })
    factory('char_a').updateCharacterHP(-2)
    expect(onSheetMutated).toHaveBeenCalledWith('char_a', sheet)
    expect(sheet.derived!.hp).toBe(8)
  })

  it('world 三回调透传；generateId 产出 msg_ 前缀 id', () => {
    const scene = vi.fn()
    const clue = vi.fn()
    const end = vi.fn()
    const m = createCharacterMutatorFactory({
      resolveSheet: () => null,
      transitionToScene: scene,
      addClue: clue,
      endGame: end,
    })(null)
    m.transitionToScene('地下室')
    m.addClue('奇怪的符号', 'c1')
    m.endGame({ outcome: 'win', title: 't', summary: 's' })
    expect(scene).toHaveBeenCalledWith('地下室')
    expect(clue).toHaveBeenCalledWith('奇怪的符号', 'c1')
    expect(end).toHaveBeenCalledWith({ outcome: 'win', title: 't', summary: 's' })
    expect(m.generateId()).toMatch(/^msg_/)
  })
})

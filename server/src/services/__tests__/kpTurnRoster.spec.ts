/**
 * B5 多角色卡 prompt 注入测试 — buildCharacterRosterPrompt / injectCharacterRoster。
 *
 * 纯函数级测试（不触 LLM）：验证多人模式花名册注入 system 消息，
 * 单角色/空角色不注入（prompt 精简）。
 */
import { describe, expect, it } from 'vitest'
import { buildCharacterRosterPrompt, injectCharacterRoster } from '../kpTurnService.js'
import type { COCCharacterSheet } from '../../../../shared/types/character.js'

/** 最小角色卡夹具（类型放宽）。 */
function makeSheet(id: string, name: string, hp: number, hpMax: number, san: number, luck: number): COCCharacterSheet {
  return {
    id,
    playerName: name,
    name,
    derived: { hp, hpMax, mp: 5, mpMax: 5, san, sanMax: 99 },
    attributes: { luck },
    skills: {},
  } as unknown as COCCharacterSheet
}

describe('buildCharacterRosterPrompt (B5)', () => {
  it('多角色 → 花名册含全部调查员 id + 名称 + 属性', () => {
    const roster = buildCharacterRosterPrompt({
      char_a: makeSheet('char_a', '艾琳', 10, 12, 60, 50),
      char_b: makeSheet('char_b', '汤姆', 8, 10, 45, 30),
    })
    expect(roster).toContain('### 房间内调查员')
    expect(roster).toContain('艾琳（id: char_a）')
    expect(roster).toContain('汤姆（id: char_b）')
    expect(roster).toContain('HP 10/12')
    expect(roster).toContain('SAN 60/99')
    expect(roster).toContain('幸运 50')
    expect(roster).toContain('characterId')
  })

  it('单角色 → 空串（单人模式不注入）', () => {
    expect(buildCharacterRosterPrompt({ char_a: makeSheet('char_a', '艾琳', 10, 12, 60, 50) })).toBe('')
  })

  it('空/缺失角色组 → 空串', () => {
    expect(buildCharacterRosterPrompt(null)).toBe('')
    expect(buildCharacterRosterPrompt({})).toBe('')
  })
})

describe('injectCharacterRoster (B5)', () => {
  it('多人 → 追加到现有 system 消息', () => {
    const msgs = [
      { role: 'system' as const, content: '你是守秘人。' },
      { role: 'user' as const, content: '我搜索书架。' },
    ]
    const out = injectCharacterRoster(msgs, {
      char_a: makeSheet('char_a', '艾琳', 10, 12, 60, 50),
      char_b: makeSheet('char_b', '汤姆', 8, 10, 45, 30),
    })
    expect(out).toHaveLength(2) // 不新增消息，只追加内容
    expect(out[0]!.content).toContain('你是守秘人。')
    expect(out[0]!.content).toContain('### 房间内调查员')
    expect(out[0]!.content).toContain('艾琳（id: char_a）')
  })

  it('无 system 消息 → 前置一条', () => {
    const msgs = [{ role: 'user' as const, content: '我看看门。' }]
    const out = injectCharacterRoster(msgs, {
      char_a: makeSheet('char_a', '艾琳', 10, 12, 60, 50),
      char_b: makeSheet('char_b', '汤姆', 8, 10, 45, 30),
    })
    expect(out[0]!.role).toBe('system')
    expect(out[0]!.content).toContain('### 房间内调查员')
    expect(out[1]!.content).toBe('我看看门。')
  })

  it('单角色 → 原样返回（不注入）', () => {
    const msgs = [{ role: 'system' as const, content: '你是守秘人。' }]
    expect(injectCharacterRoster(msgs, { char_a: makeSheet('char_a', '艾琳', 10, 12, 60, 50) })).toBe(msgs)
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeSample } from '../lib/judge.ts'
import type { GoldenSample, ModelResponse } from '../lib/types.ts'

function sample(overrides: Partial<GoldenSample>): GoldenSample {
  return {
    id: 't',
    category: 't',
    tools: ['skill_check'],
    notes: '',
    storyName: 's',
    scene: null,
    clues: [],
    history: [],
    kpMemory: [],
    longTermSummary: '',
    ragContext: '',
    characters: ['char_lin'],
    charactersById: {
      char_lin: {
        occupationId: 'x',
        occupationName: '考古学家',
        playerName: '林逸',
        attributes: { str: 55, con: 60, siz: 60, dex: 70, app: 55, int: 75, pow: 65, edu: 80, luck: 60 },
        skills: { 侦查: 65 },
        occupationSkillKeys: [],
        personalInterestKeys: [],
        derived: { hp: 12, hpMax: 12, mp: 13, mpMax: 13, san: 60, sanMax: 65 },
      },
    },
    batchUserContent: 'x',
    expect: { alternatives: [[{ name: 'skill_check', args: { skillValue: 65 } }]] },
    ...overrides,
  }
}

test('judge: 全对 → pass（format/verdict 双绿）', () => {
  const j = judgeSample(sample({}), { content: '你举灯照向书架。', toolCalls: [{ name: 'skill_check', arguments: '{"skillName":"侦查","skillValue":65,"difficulty":"regular"}' }] })
  assert.equal(j.category, 'pass')
  assert.equal(j.formatOk, true)
  assert.equal(j.verdictOk, true)
})

test('judge: 未调工具 → no_tool_call（格式也败）', () => {
  const j = judgeSample(sample({}), { content: '你举灯照向书架，什么都没有。', toolCalls: [] })
  assert.equal(j.category, 'no_tool_call')
  assert.equal(j.formatOk, false)
})

test('judge: 调错工具 → wrong_tool（格式败：required 未覆盖）', () => {
  const j = judgeSample(sample({}), { content: '', toolCalls: [{ name: 'grant_clue', arguments: '{"description":"x"}' }] })
  assert.equal(j.category, 'wrong_tool')
})

test('judge: 参数错 → bad_args（格式过、裁定败）', () => {
  const j = judgeSample(sample({}), { content: '', toolCalls: [{ name: 'skill_check', arguments: '{"skillName":"侦查","skillValue":45}' }] })
  assert.equal(j.category, 'bad_args')
  assert.equal(j.formatOk, true)
  assert.equal(j.verdictOk, false)
})

test('judge: 文字模拟骰点 → text_dice（validate 同源正则）', () => {
  const j = judgeSample(sample({}), { content: '你进行侦查检定。d100: 45，成功了。', toolCalls: [{ name: 'skill_check', arguments: '{"skillValue":65}' }] })
  assert.equal(j.category, 'text_dice')
  assert.equal(j.formatOk, false)
})

test('judge: arguments 非 JSON → unparseable；未知工具名 → unparseable', () => {
  const j1 = judgeSample(sample({}), { content: '', toolCalls: [{ name: 'skill_check', arguments: '{skillValue:65}' }] })
  assert.equal(j1.category, 'unparseable')
  const j2 = judgeSample(sample({}), { content: '', toolCalls: [{ name: 'make_dice', arguments: '{}' }] })
  assert.equal(j2.category, 'unparseable')
})

test('judge: 纯叙事样本 — 零工具 pass；调了工具 → wrong_tool；文字骰点仍抓', () => {
  const s = sample({ expect: { noTools: true, alternatives: [] } })
  const ok = judgeSample(s, { content: '陶片是迈锡尼时期的。', toolCalls: [] })
  assert.equal(ok.category, 'pass')
  const bad = judgeSample(s, { content: '', toolCalls: [{ name: 'skill_check', arguments: '{"skillValue":65}' }] })
  assert.equal(bad.category, 'wrong_tool')
  assert.equal(bad.formatOk, true)
  const dice = judgeSample(s, { content: 'd100: 45', toolCalls: [] })
  assert.equal(dice.category, 'text_dice')
})

test('judge: 备选序列兜底（melee_attack 或分步 skill_check）', () => {
  const s = sample({
    expect: {
      alternatives: [
        [{ name: 'melee_attack', args: { sideAValue: 60 } }],
        [{ name: 'skill_check', args: { skillValue: 60 } }],
      ],
    },
  })
  const oneShot = judgeSample(s, { content: '', toolCalls: [{ name: 'melee_attack', arguments: '{"sideAValue":60,"sideBValue":40,"damageExpr":"1d4","investigatorSide":"A"}' }] })
  assert.equal(oneShot.category, 'pass')
  const stepped = judgeSample(s, { content: '', toolCalls: [{ name: 'skill_check', arguments: '{"skillName":"斗殴","skillValue":60}' }] })
  assert.equal(stepped.category, 'pass')
})

test('judge: 有序双调用（多人两行动，逆序备选）', () => {
  const s = sample({
    expect: {
      alternatives: [
        [
          { name: 'skill_check', args: { characterId: 'char_lin' } },
          { name: 'skill_check', args: { characterId: 'char_chen' } },
        ],
        [
          { name: 'skill_check', args: { characterId: 'char_chen' } },
          { name: 'skill_check', args: { characterId: 'char_lin' } },
        ],
      ],
    },
  })
  const j = judgeSample(s, {
    content: '',
    toolCalls: [
      { name: 'skill_check', arguments: '{"skillName":"锁匠","skillValue":55,"characterId":"char_chen"}' },
      { name: 'skill_check', arguments: '{"skillName":"侦查","skillValue":65,"characterId":"char_lin"}' },
    ],
  })
  assert.equal(j.category, 'pass')
})

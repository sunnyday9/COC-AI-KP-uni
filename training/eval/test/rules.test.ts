import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expectedCallMatches, parseToolArguments, requiredToolsCovered, sequenceMatches, valueMatches } from '../lib/rules.ts'
import type { GoldenSample } from '../lib/types.ts'

test('parseToolArguments: 合法对象 / 非对象 / 空', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 })
  assert.equal(parseToolArguments('null'), null)
  assert.equal(parseToolArguments('[1]'), null)
  assert.equal(parseToolArguments('not json'), null)
  assert.equal(parseToolArguments(''), null)
  assert.deepEqual(parseToolArguments('   {}  '), {})
})

test('valueMatches: 数字宽化（字符串数字）、布尔/字符串严格、数组包含、对象子集', () => {
  assert.equal(valueMatches('65', 65), true)
  assert.equal(valueMatches(65, 65), true)
  assert.equal(valueMatches(65.5, 65), false)
  assert.equal(valueMatches(true, true), true)
  assert.equal(valueMatches('true', true), false)
  assert.equal(valueMatches('  侦查 ', '侦查'), true)
  assert.equal(
    valueMatches([{ name: '林逸', mov: 8, dex: 70 }, { name: '教徒', mov: 7 }], [{ name: '林逸', mov: 8 }, { name: '教徒', mov: 7 }]),
    true,
  )
  assert.equal(valueMatches([{ name: '林逸', mov: 8 }], [{ name: '林逸', mov: 9 }]), false)
  assert.equal(valueMatches({ a: 1, b: 2 }, { a: 1 }), true)
  assert.equal(valueMatches({ a: 1 }, { a: 1, b: 2 }), false)
})

test('expectedCallMatches: args 子集 + forbid', () => {
  const call = { name: 'skill_check', args: { skillName: '侦查', skillValue: '65', difficulty: 'regular' } }
  assert.equal(expectedCallMatches(call, { name: 'skill_check', args: { skillValue: 65 } }), true)
  assert.equal(expectedCallMatches(call, { name: 'skill_check', args: { skillValue: 64 } }), false)
  assert.equal(expectedCallMatches(call, { name: 'opposed_check' }), false)
  assert.equal(expectedCallMatches({ name: 'cast_spell', args: { costMp: 10 } }, { name: 'cast_spell', forbid: { firstCast: true } }), true)
  assert.equal(
    expectedCallMatches({ name: 'cast_spell', args: { costMp: 10, firstCast: true } }, { name: 'cast_spell', forbid: { firstCast: true } }),
    false,
  )
})

test('sequenceMatches: 有序子列（允许夹杂额外调用）', () => {
  const calls = [
    { name: 'skill_check', args: { skillValue: 65 } },
    { name: 'grant_clue', args: {} },
    { name: 'roll_dice', args: { sides: 4 } },
  ]
  assert.equal(sequenceMatches(calls, [{ name: 'skill_check' }, { name: 'roll_dice', args: { sides: 4 } }]), true)
  assert.equal(sequenceMatches(calls, [{ name: 'roll_dice' }, { name: 'skill_check' }]), false)
  assert.equal(sequenceMatches(calls, [{ name: 'adjust_hp' }]), false)
})

function makeSample(expect: GoldenSample['expect']): GoldenSample {
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
    batchUserContent: 'x',
    expect,
  }
}

test('requiredToolsCovered: melee_attack 等价展开满足三件套', () => {
  const sample = makeSample({ alternatives: [[{ name: 'skill_check' }, { name: 'roll_dice' }, { name: 'adjust_hp' }]] })
  assert.equal(requiredToolsCovered(['melee_attack'], sample), true)
  assert.equal(requiredToolsCovered(['skill_check', 'roll_dice'], sample), false)
  assert.equal(requiredToolsCovered([], sample), false)
})

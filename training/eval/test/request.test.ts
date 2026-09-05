import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnRequest } from '../lib/request.ts'
import type { GoldenSample } from '../lib/types.ts'
import type { COCCharacterSheet } from '../../../../shared/types/character.ts'

const card: COCCharacterSheet = {
  occupationId: 'x',
  occupationName: '考古学家',
  playerName: '林逸',
  attributes: { str: 55, con: 60, siz: 60, dex: 70, app: 55, int: 75, pow: 65, edu: 80, luck: 60 },
  skills: { 侦查: 65 },
  occupationSkillKeys: [],
  personalInterestKeys: [],
  derived: { hp: 12, hpMax: 12, mp: 13, mpMax: 13, san: 60, sanMax: 65 },
}
const cardChen = { ...card, playerName: '陈默', occupationName: '私家侦探' }

function sample(overrides: Partial<GoldenSample> = {}): GoldenSample {
  return {
    id: 't',
    category: 't',
    tools: ['skill_check'],
    notes: '',
    storyName: '雾停镇的灯塔',
    scene: '渔民小屋',
    clues: [{ id: 'c1', description: '航海日记' }],
    history: [{ role: 'kp', content: '屋内很暗。' }, { role: 'player', playerName: '林逸', content: '我环视房间。' }],
    kpMemory: ['林逸进屋了。'],
    longTermSummary: '',
    ragContext: '【渔民小屋】书架后有暗格。',
    characters: ['char_lin'],
    charactersById: { char_lin: card },
    batchUserContent: '【林逸】我检查书架。',
    expect: { alternatives: [[{ name: 'skill_check' }]] },
    ...overrides,
  }
}

test('buildTurnRequest: 单人——system 收口（BASE_INSTRUCTIONS+状态+RAG），批次 user 收尾', () => {
  const msgs = buildTurnRequest(sample())
  assert.equal(msgs[msgs.length - 1].role, 'user')
  assert.equal(msgs[msgs.length - 1].content, '【林逸】我检查书架。')
  const system = msgs[0]
  assert.equal(system.role, 'system')
  const sc = system.content
  assert.ok(sc.includes('守密人'), 'system 应包含 BASE_INSTRUCTIONS 开头')
  assert.ok(sc.includes('## 故事: 雾停镇的灯塔'))
  assert.ok(sc.includes('当前场景: 渔民小屋'))
  assert.ok(sc.includes('## 调查员: 林逸'), '角色卡应注入 system')
  assert.ok(sc.includes('## 故事情报'), 'RAG 注入应存在')
  assert.ok(sc.includes('书架后有暗格'))
  assert.ok(!sc.includes('房间内调查员'), '单人不应注入花名册')
  // 近窗历史映射：kp→assistant, player→user（[名字] 前缀）
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content, '屋内很暗。')
  assert.equal(msgs[2].role, 'user')
  assert.equal(msgs[2].content, '[林逸] 我环视房间。')
  assert.equal(msgs.length, 4)
})

test('buildTurnRequest: 多人——花名册注入 system', () => {
  const msgs = buildTurnRequest(sample({ characters: ['char_lin', 'char_chen'], charactersById: { char_lin: card, char_chen: cardChen } }))
  assert.ok(msgs[0].content.includes('### 房间内调查员（多人模式）'))
  assert.ok(msgs[0].content.includes('char_lin'))
  assert.ok(msgs[0].content.includes('char_chen'))
})

test('buildTurnRequest: 续接样本——assistant(tool_calls) + tool(结果原文) 按序回放', () => {
  const msgs = buildTurnRequest(
    sample({
      priorIterations: [
        {
          assistantContent: '',
          toolCalls: [{ id: 'tc1', name: 'skill_check', arguments: '{"skillName":"侦查"}' }],
          toolResults: [{ tool_call_id: 'tc1', content: '【结果摘要】roll: 34\n{"roll":34}' }],
        },
      ],
    }),
  )
  const assistant = msgs[msgs.length - 2]
  const tool = msgs[msgs.length - 1]
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.tool_calls, [{ id: 'tc1', type: 'function', function: { name: 'skill_check', arguments: '{"skillName":"侦查"}' } }])
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'tc1')
  assert.equal(tool.content, '【结果摘要】roll: 34\n{"roll":34}')
})

import { describe, it, expect } from 'vitest'
import {
  createKPGraph,
  classifyIntentByRules,
  extractSanStateFromHistory,
  parseToolResultContent,
  shouldTriggerInsanity,
  invokeKPAgent,
  type KpMessage,
  type InvokeLLMResult,
} from '../kpGraph.js'

/**
 * Deterministic-behavior fixes for the graph:
 *  - SAN history extraction (client no longer sends storyContext).
 *  - endgame intent short-circuit.
 *  - stall detection fed by the previous turn's tools (planTools runs before
 *    generate, so it can never see the current turn's toolCalls).
 *  - forceTools normalizes malformed tool_calls before re-sending history.
 */

const classifier = (msgs: KpMessage[]) =>
  msgs[0]?.role === 'system' && String(msgs[0]?.content).includes('只回复一个英文意图关键词')

const forceCall = (msgs: KpMessage[]) =>
  String(msgs[msgs.length - 1]?.content ?? '').includes('请立即调用以下工具')

describe('extractSanStateFromHistory / shouldTriggerInsanity', () => {
  it('extracts currentSan + sanLost from trailing san_check tool results', () => {
    const msgs: KpMessage[] = [
      { role: 'user', content: '我看到神像' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'san_check', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ roll: 34, currentSan: 50, passed: false, sanLost: 8, lossExpression: '1d8' }) },
    ]
    const state = extractSanStateFromHistory(msgs)
    expect(state).toEqual({ currentSan: 50, totalSanLost: 8 })
    expect(shouldTriggerInsanity(state)).toBe(true) // single loss >= 5
  })

  it('triggers at 1/5 cumulative threshold', () => {
    const msgs: KpMessage[] = [
      { role: 'user', content: '看' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'san_check', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ currentSan: 40, sanLost: 4 }) },
      { role: 'assistant', content: '', tool_calls: [{ id: 't2', function: { name: 'san_check', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't2', content: JSON.stringify({ currentSan: 36, sanLost: 5 }) },
    ]
    const state = extractSanStateFromHistory(msgs)
    expect(state).not.toBeNull()
    expect(shouldTriggerInsanity(state)).toBe(true) // 4+5 = 9 >= floor(40/5)=8
  })

  it('does not trigger for small losses', () => {
    const msgs: KpMessage[] = [
      { role: 'user', content: '看' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'san_check', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ currentSan: 60, sanLost: 2 }) },
    ]
    const state = extractSanStateFromHistory(msgs)
    expect(shouldTriggerInsanity(state)).toBe(false)
  })

  it('returns null without san_check results', () => {
    expect(extractSanStateFromHistory([{ role: 'user', content: 'hi' }])).toBeNull()
  })
})

describe('endgame intent short-circuit', () => {
  async function runOnce(userText: string): Promise<{ intent?: string; requiredTools?: string[]; validationResult?: string }> {
    const graph = createKPGraph(async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      if (classifier(msgs)) return 'narrative'
      if (forceCall(msgs)) return { content: '', toolCalls: [] }
      return { content: '故事结束。', toolCalls: [] }
    })
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: userText },
      ],
    })) as Record<string, unknown>
    return {
      intent: result.playerIntent as string | undefined,
      requiredTools: result.requiredTools as string[] | undefined,
      validationResult: result.validationResult as string | undefined,
    }
  }

  it('classifies explicit ending phrases as endgame and requires end_game', async () => {
    for (const phrase of ['我们结束冒险吧', '这个团就到这里，封存', '大家都不玩了', '我们成功逃离了', '真相大白了']) {
      const r = await runOnce(phrase)
      expect(r.intent).toBe('endgame')
      expect(r.requiredTools).toContain('end_game')
    }
  })

  it('does not misclassify ordinary movement', async () => {
    const r = await runOnce('我离开房间，去走廊看看')
    expect(r.intent).not.toBe('endgame')
  })
})

describe('stall detection over message history', () => {
  it('force-grants a clue after repeated non-progress turns', async () => {
    const graph = createKPGraph(async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      if (classifier(msgs)) return 'investigate'
      if (forceCall(msgs)) return { content: '', toolCalls: [{ id: 'f1', name: 'grant_clue', arguments: '{"description":"门缝里的纸条"}' }] }
      return { content: '你看了看四周。', toolCalls: [] }
    })
    // Three investigate turns in one invocation (single user turn, two
    // assistant tool-less replies from the classifier/generate) — the LLM
    // returns no progress tools, so the stall counter reaches 3 ≥ 2 and
    // grant_clue must be forced into requiredTools.
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我调查一下' },
        { role: 'assistant', content: '你看了看四周。', tool_calls: [] },
        { role: 'user', content: '我继续调查' },
        { role: 'assistant', content: '还是没什么发现。', tool_calls: [] },
        { role: 'user', content: '我再仔细看看' },
      ],
    })) as Record<string, unknown>
    expect(result.requiredTools).toContain('grant_clue')
    expect(result.validationResult === 'valid' || result.validationResult === 'max_retries').toBe(true)
  })

  it('does not force a clue when a recent turn granted one', async () => {
    const graph = createKPGraph(async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      if (classifier(msgs)) return 'investigate'
      return { content: '你发现了线索。', toolCalls: [] }
    })
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我调查一下' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', function: { name: 'grant_clue', arguments: '{"description":"钥匙"}' } }],
        },
        { role: 'user', content: '我继续调查' },
      ],
    })) as Record<string, unknown>
    expect(result.requiredTools).not.toContain('grant_clue')
  })
})

describe('forceTools normalizes malformed tool_calls', () => {
  it('downgrades bad arguments to "{}" in the force-tools re-send', async () => {
    const seen: string[] = []
    const graph = createKPGraph(async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      if (classifier(msgs)) return 'combat'
      if (forceCall(msgs)) {
        seen.push(JSON.stringify(msgs))
        return { content: '', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{}' }] }
      }
      return { content: '你攻击。', toolCalls: [] }
    })
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我攻击他' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'bad', function: { name: 'skill_check', arguments: '{bad json' } }],
        },
      ],
    })) as Record<string, unknown>
    expect(result.validationResult === 'valid' || result.validationResult === 'max_retries').toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toContain('"arguments":"{}"')
  })
})

describe('invokeKPAgent', () => {
  it('passes storyContext to the graph (script gating path does not throw without a script)', async () => {
    const result = await invokeKPAgent(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我调查一下' },
      ],
      async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
        if (classifier(msgs)) return 'investigate'
        return { content: '你环顾四周，没有什么特别的。', toolCalls: [] }
      },
      { scriptId: 'missing-script.json', openClues: [{ id: 'c1', description: '旧钥匙' }], sceneName: '校长办公室' },
      999,
    )
    expect(result.content.length).toBeGreaterThan(0)
  })
})

describe('classifyIntentByRules (perf A1: rule-first intent, skips classifier LLM)', () => {
  it('combat keywords match', () => {
    expect(classifyIntentByRules('我开枪射击他')).toBe('combat')
    expect(classifyIntentByRules('挥拳攻击')).toBe('combat')
    expect(classifyIntentByRules('扑向敌人')).toBe('combat')
  })

  it('investigate / move / talk_npc / san_encounter / skill_check match', () => {
    expect(classifyIntentByRules('我仔细搜查书架')).toBe('investigate')
    expect(classifyIntentByRules('查看抽屉')).toBe('investigate')
    expect(classifyIntentByRules('前往地下室')).toBe('move')
    expect(classifyIntentByRules('走进教师办公室')).toBe('move')
    expect(classifyIntentByRules('询问门卫情况')).toBe('talk_npc')
    expect(classifyIntentByRules('这太诡异了，我感到毛骨悚然')).toBe('san_encounter')
    expect(classifyIntentByRules('我要做一次检定')).toBe('skill_check')
  })

  it('no keyword match → null (classifier LLM fallback path)', () => {
    expect(classifyIntentByRules('今天天气不错')).toBeNull()
    expect(classifyIntentByRules('')).toBeNull()
  })

  it('调查员 (investigator noun) must NOT trigger investigate', () => {
    expect(classifyIntentByRules('调查员马丁站在门口')).not.toBe('investigate')
  })
})

describe('parseToolResultContent (perf A4 summary-head compat)', () => {
  it('parses plain JSON tool results (legacy format)', () => {
    expect(parseToolResultContent('{"roll":5,"sides":6}')).toEqual({ roll: 5, sides: 6 })
  })

  it('parses JSON after the client 【结果摘要】 head (perf A4)', () => {
    expect(parseToolResultContent('【结果摘要】roll: 5；sides: 6\n{"roll":5,"sides":6}')).toEqual({ roll: 5, sides: 6 })
  })

  it('returns null for non-JSON content', () => {
    expect(parseToolResultContent('HP adjusted by -2')).toBeNull()
    expect(parseToolResultContent('')).toBeNull()
    expect(parseToolResultContent(null)).toBeNull()
  })

  it('SAN extraction works with summary-head tool results (end-to-end)', () => {
    const msgs: KpMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'san_check', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '【结果摘要】roll: 34；currentSan: 50；sanLost: 8\n{"roll":34,"currentSan":50,"passed":false,"sanLost":8}' },
    ]
    const state = extractSanStateFromHistory(msgs)
    expect(state).toEqual({ currentSan: 50, totalSanLost: 8 })
  })
})

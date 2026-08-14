// Migrated from original/ai-trpg-web/electron/agent/__tests__/kpGraph.spec.ts
import { describe, it, expect } from 'vitest'
import { createKPGraph, type KpMessage, type InvokeLLMResult } from '../kpGraph.js'

describe('server/agent/kpGraph', () => {
  it('routes combat intent and forces missing tool calls', async () => {
    const invokeLLM = async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      const last = msgs[msgs.length - 1]?.content ?? ''
      // intent classifier
      if (msgs[0]?.role === 'system' && String(msgs[0]?.content).includes('只回复一个英文意图关键词')) {
        return 'combat'
      }
      // force-tools call
      if (last.includes('请立即调用以下工具')) {
        return { content: '', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{"skillName":"斗殴","skillValue":50,"difficulty":"regular"}' }] }
      }
      // generate without tool calls (invalid)
      return { content: '你扑上去试图攻击对方。', toolCalls: [] }
    }

    const graph = createKPGraph(invokeLLM)
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我攻击他' },
      ],
    })) as Record<string, unknown>

    expect(result.validationResult === 'valid' || result.validationResult === 'max_retries').toBe(true)
    expect(Array.isArray(result.toolCalls)).toBe(true)
    expect((result.toolCalls as { name: string }[])[0].name).toBe('skill_check')
  })

  it('cleans text-simulated dice and still requests required tools', async () => {
    const invokeLLM = async (msgs: KpMessage[]): Promise<InvokeLLMResult> => {
      const last = msgs[msgs.length - 1]?.content ?? ''
      if (msgs[0]?.role === 'system' && String(msgs[0]?.content).includes('只回复一个英文意图关键词')) {
        return 'combat'
      }
      if (last.includes('请立即调用以下工具')) {
        return { content: '', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{}' }] }
      }
      return { content: 'd100: 45 你命中了。', toolCalls: [] }
    }

    const graph = createKPGraph(invokeLLM)
    const result = (await graph.invoke({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我攻击他' },
      ],
    })) as Record<string, unknown>
    // With simulated dice text, validate will not mark as fully valid; after one retry it should cap at max_retries.
    expect(result.validationResult).toBe('max_retries')
    expect(Array.isArray(result.toolCalls)).toBe(true)
    expect((result.toolCalls as { name: string }[]).some((t) => t.name === 'skill_check')).toBe(true)
  })
})

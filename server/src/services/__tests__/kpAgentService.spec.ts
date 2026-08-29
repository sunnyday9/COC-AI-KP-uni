import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import { register } from '../authService.js'
import { saveSettings } from '../settingsService.js'
import { invokeKp, invokeKpStream } from '../kpAgentService.js'
import { BadRequestError, UpstreamError } from '../../utils/errors.js'

/**
 * kpAgentService tests — the real LangGraph state machine runs, only the LLM
 * layer (aiService.chatForAgent) is mocked. Covers invoke result shape,
 * streaming event sequence (chunk → trace → end), and error paths
 * (LLM failure → UpstreamError / WS error event / REST 502).
 */

const state = vi.hoisted(() => ({
  calls: [] as {
    messages: { role: string; content: string }[]
    maxTokens?: number
    stream?: boolean
    tools?: unknown[]
  }[],
  failGenerate: false,
}))

vi.mock('../aiService.js', () => ({
  chatForAgent: vi.fn(
    async (
      _userId: number,
      params: {
        messages: { role: string; content: string }[]
        maxTokens?: number
        stream?: boolean
        tools?: unknown[]
        onChunk?: (chunk: string) => void
      },
    ) => {
      state.calls.push({
        messages: params.messages,
        maxTokens: params.maxTokens,
        stream: params.stream,
        tools: params.tools,
      })
      const msgs = params.messages
      const first = msgs[0]
      const last = msgs[msgs.length - 1]
      // intent classifier (maxTokens 32, no tools)
      if (first?.role === 'system' && String(first.content).includes('只回复一个英文意图关键词')) {
        return { content: 'combat', toolCalls: undefined }
      }
      // force-tools call
      if (last?.role === 'user' && String(last.content).includes('请立即调用以下工具')) {
        return { content: '', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{}' }] }
      }
      // generate call
      if (state.failGenerate) {
        throw new Error('upstream boom')
      }
      params.onChunk?.('第一段')
      params.onChunk?.('第二段')
      return { content: '战斗剧情。', toolCalls: [] }
    },
  ),
}))

async function createUser(username: string): Promise<number> {
  const { user } = await register(username, 'secret123')
  return user.id
}

beforeEach(() => {
  state.calls.length = 0
  state.failGenerate = false
})

describe('invokeKp (REST path)', () => {
  it('runs the graph once and returns { content, toolCalls }', async () => {
    const userId = await createUser('kp_alice')
    const result = await invokeKp(userId, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我攻击他' },
      ],
    })

    expect(result.content).toBe('战斗剧情。')
    expect(result.toolCalls).toBeDefined()
    expect(result.toolCalls![0].name).toBe('skill_check')

    // Rule-first classification (perf A1): "我攻击他" hits the combat rule,
    // so the classifier LLM call is skipped entirely; generate + forceTools
    // still receive the 24 tools. First call is the main generate.
    expect(state.calls[0].maxTokens).toBe(2048)
    expect(state.calls[0].tools).toBeDefined()
    expect(state.calls[0].tools!.length).toBe(24)
    expect(state.calls.slice(1).every((c) => Array.isArray(c.tools) && c.tools.length === 24)).toBe(true)
    // REST path never streams
    expect(state.calls.every((c) => c.stream === false)).toBe(true)
  })

  it('returns { content: "" } for empty messages without calling the LLM', async () => {
    const userId = await createUser('kp_bob')
    const result = await invokeKp(userId, { messages: [] })
    expect(result).toEqual({ content: '' })
    expect(state.calls).toHaveLength(0)
  })

  it('rejects malformed messages with BadRequestError', async () => {
    const userId = await createUser('kp_carol')
    await expect(
      invokeKp(userId, { messages: [{ role: 'user' } as never] }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(state.calls).toHaveLength(0)
  })

  it('maps graph failure to UpstreamError', async () => {
    state.failGenerate = true
    const userId = await createUser('kp_dave')
    await expect(
      invokeKp(userId, {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '我攻击他' },
        ],
      }),
    ).rejects.toBeInstanceOf(UpstreamError)
  })
})

// POST /api/kp/invoke 路由测试已随路由退役删除（ADR-0002 / T4）。

describe('invokeKpStream (WS path)', () => {
  it('emits chunk → trace → end in order with the graph result', async () => {
    const userId = await createUser('kp_heidi')
    const events: { kind: string; payload: unknown }[] = []
    await invokeKpStream(
      userId,
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '我攻击他' },
        ],
      },
      {
        onChunk: (chunk) => events.push({ kind: 'chunk', payload: chunk }),
        onTrace: (traceEvents) => events.push({ kind: 'trace', payload: traceEvents }),
        onEnd: (result) => events.push({ kind: 'end', payload: result }),
        onError: (error) => events.push({ kind: 'error', payload: error }),
      },
    )

    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'trace', 'end'])
    expect(events[0].payload).toBe('第一段')
    expect(events[1].payload).toBe('第二段')
    expect(Array.isArray(events[2].payload)).toBe(true)
    expect((events[2].payload as unknown[]).length).toBeGreaterThan(0)
    const end = events[3].payload as { content: string; toolCalls?: { name: string }[] }
    expect(end.content).toBe('战斗剧情。')
    expect(end.toolCalls?.[0].name).toBe('skill_check')
    // streaming enabled only for the generate call; rule-first classification
    // (perf A1) skips the classifier LLM, so first call is generate (stream),
    // second is the non-streaming forceTools retry.
    expect(state.calls[0].stream).toBe(true)
    expect(state.calls[1].stream).toBe(false)
  })

  it('emits end with empty content for empty messages (no LLM calls)', async () => {
    const userId = await createUser('kp_ivan')
    const events: { kind: string; payload: unknown }[] = []
    await invokeKpStream(userId, { messages: [] }, {
      onChunk: (c) => events.push({ kind: 'chunk', payload: c }),
      onTrace: (t) => events.push({ kind: 'trace', payload: t }),
      onEnd: (r) => events.push({ kind: 'end', payload: r }),
      onError: (e) => events.push({ kind: 'error', payload: e }),
    })
    expect(events).toEqual([{ kind: 'end', payload: { content: '', toolCalls: undefined } }])
    expect(state.calls).toHaveLength(0)
  })

  it('emits error event when the graph fails', async () => {
    state.failGenerate = true
    const userId = await createUser('kp_jack')
    const events: { kind: string; payload: unknown }[] = []
    await invokeKpStream(
      userId,
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '我攻击他' },
        ],
      },
      {
        onChunk: (c) => events.push({ kind: 'chunk', payload: c }),
        onTrace: (t) => events.push({ kind: 'trace', payload: t }),
        onEnd: (r) => events.push({ kind: 'end', payload: r }),
        onError: (e) => events.push({ kind: 'error', payload: e }),
      },
    )
    expect(events.map((e) => e.kind)).toEqual(['error'])
    expect(events[0].payload).toBe('upstream boom')
  })

  it('reads AI config from user settings (temperature/maxTokens from settings)', async () => {
    const userId = await createUser('kp_kate')
    saveSettings(userId, { ai: { temperature: 0.3, maxTokens: 999 } })
    await invokeKp(userId, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我攻击他' },
      ],
    })
    // generate call uses settings temperature/maxTokens
    const generateCall = state.calls.find((c) => c.tools && c.tools.length > 0)
    expect(generateCall?.maxTokens).toBe(999)
  })
})

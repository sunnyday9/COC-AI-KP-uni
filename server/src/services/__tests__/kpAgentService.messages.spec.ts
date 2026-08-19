import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeKp, invokeKpStream } from '../kpAgentService.js'
import { BadRequestError } from '../../utils/errors.js'

/**
 * Wire-format message validation (task: fix test-agent AW-R-01 / AW-R-09).
 *  - Non-array messages → BadRequestError (was: silent 200 empty response).
 *  - assistant tool_calls: structural violations → 400; unparseable
 *    arguments JSON is downgraded to '{}' (mirrors client orchestrator), so
 *    the graph and the upstream LLM call never see malformed arguments.
 *  - tool messages: missing/non-string tool_call_id → 400.
 */
const state = vi.hoisted(() => ({
  calls: [] as { messages: unknown[] }[],
}))

vi.mock('../aiService.js', () => ({
  chatForAgent: vi.fn(async (_userId: number, params: { messages: unknown[] }) => {
    state.calls.push({ messages: params.messages })
    return { content: 'ok' }
  }),
}))

beforeEach(() => {
  state.calls.length = 0
})

describe('kp:invoke message validation', () => {
  it('rejects non-array messages with BadRequestError (no silent empty result)', async () => {
    await expect(invokeKp(1, { messages: 'not-an-array' as never })).rejects.toBeInstanceOf(BadRequestError)
    await expect(invokeKp(1, { messages: undefined as never })).rejects.toBeInstanceOf(BadRequestError)
    expect(state.calls).toHaveLength(0)
  })

  it('rejects structurally invalid assistant tool_calls with BadRequestError', async () => {
    const bad = [
      { role: 'assistant', content: '', tool_calls: 'nope' },
      { role: 'assistant', content: '', tool_calls: [{ id: 1, function: { name: 'x', arguments: '{}' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { arguments: '{}' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x', arguments: 42 } }] },
    ]
    for (const messages of bad) {
      await expect(invokeKp(1, { messages: [messages] as never })).rejects.toBeInstanceOf(BadRequestError)
    }
    expect(state.calls).toHaveLength(0)
  })

  it('downgrades unparseable tool_calls arguments to "{}" instead of failing', async () => {
    const result = await invokeKp(1, {
      messages: [
        { role: 'user', content: '我搜索房间。' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc_bad', function: { name: 'skill_check', arguments: '{bad json' } }] },
        { role: 'tool', tool_call_id: 'tc_bad', content: 'error: 参数解析失败' },
        { role: 'user', content: '我继续搜索。' },
      ] as never,
    })
    expect(state.calls.length).toBeGreaterThan(0)
    // the downgraded '{}' must have reached the LLM layer at least once
    const serialized = JSON.stringify(state.calls)
    expect(serialized).toContain('"arguments":"{}"')
    expect(result).toBeDefined()
  })

  it('rejects tool messages without a string tool_call_id', async () => {
    await expect(
      invokeKp(1, {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', content: '{}' },
        ] as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(state.calls).toHaveLength(0)
  })

  it('WS path: non-array messages reject (ws layer converts to error frame), no end event', async () => {
    const events: string[] = []
    await expect(
      invokeKpStream(
        1,
        { messages: 42 as never },
        {
          onChunk: () => events.push('chunk'),
          onTrace: () => events.push('trace'),
          onEnd: () => events.push('end'),
          onError: () => events.push('error'),
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(events).toEqual([]) // nothing streamed; ws/index.ts catch → error frame
  })
})

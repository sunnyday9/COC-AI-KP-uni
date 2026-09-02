import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch } from '../llm/index.js'
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'

/**
 * openai_responses 适配器测试（T3 #10）。
 * openai SDK 的 responses.create 被 mock：
 *  - 非流式 → { output: [message(text), function_call] }
 *  - 流式 → AsyncIterable<ResponseStreamEvent>（output_text.delta + output_item.done）
 * 验证归一化 { content, chunks, toolCalls } 与请求参数映射
 * （instructions / tools 扁平 / max_output_tokens）。不做流式 delta 拼装（Q8-A）。
 */

type CreateCall = {
  body: Record<string, unknown>
  stream: boolean
}

const calls = vi.hoisted(() => [] as CreateCall[])
const createImpl = vi.hoisted(() => ({ current: (_body: Record<string, unknown>) => ({ id: 'resp_x', output: [] }) }))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    baseURL: string
    constructor(opts: { baseURL: string }) {
      this.baseURL = opts.baseURL
    }
    responses = {
      create: async (body: Record<string, unknown>) => {
        calls.push({ body, stream: !!body.stream })
        return createImpl.current(body)
      },
    }
  },
}))

/** 每个用例设置 responses.create 的实现 */
function mockResponsesCreate(impl: (body: Record<string, unknown>) => unknown) {
  createImpl.current = impl as typeof createImpl.current
}

const KEY = ['fixture', 'resp'].join('-')

function cfg(): AIProviderConfig {
  return {
    protocol: 'openai_responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKey: KEY,
  }
}

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

describe('openai_responses adapter', () => {
  it('non-stream: maps system to instructions, returns content from output message', async () => {
    mockResponsesCreate(() => ({
      id: 'resp_1',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '你好，调查员。' }],
        },
      ],
    }))
    const res = await dispatch(cfg(), {
      messages: [
        { role: 'system', content: '你是克苏鲁的呼唤守密人。' },
        { role: 'user', content: '开始吧' },
      ],
      stream: false,
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.stream).toBe(false)
    expect(res.content).toBe('你好，调查员。')
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({
      model: 'gpt-4o',
      instructions: '你是克苏鲁的呼唤守密人。',
      max_output_tokens: 512,
      temperature: 0.3,
      stream: false,
    })
    // input: system 被抽走，只留 user
    const input = calls[0].body.input as { role: string; content: string }[]
    expect(input).toEqual([{ role: 'user', content: '开始吧' }])
  })

  it('non-stream: returns toolCalls from output function_call items', async () => {
    mockResponsesCreate(() => ({
      id: 'resp_2',
      output: [
        {
          type: 'function_call',
          call_id: 'fc_1',
          name: 'roll_dice',
          arguments: '{"sides":6}',
          status: 'completed',
        },
      ],
    }))
    const res = await dispatch(cfg(), {
      messages: [{ role: 'user', content: '投个骰子' }],
      tools: [
        {
          type: 'function',
          function: { name: 'roll_dice', description: 'roll', parameters: { type: 'object', properties: {} } },
        },
      ],
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.toolCalls).toEqual([{ id: 'fc_1', name: 'roll_dice', arguments: '{"sides":6}' }])
    // tools 扁平格式
    const tools = calls[0].body.tools as { type: string; name: string }[]
    expect(tools[0]).toMatchObject({ type: 'function', name: 'roll_dice' })
  })

  it('stream: accumulates output_text.delta into chunks; tool calls via output_item.done with full arguments', async () => {
    mockResponsesCreate((body) => {
      if (body.stream) {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: '正在侦查…', item_id: 'msg_1' }
          yield { type: 'response.output_text.delta', delta: '发现了线索。', item_id: 'msg_1' }
          // function_call output item 完成事件携带完整 arguments（无 delta 拼装）
          yield {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'function_call',
              call_id: 'fc_2',
              name: 'skill_check',
              arguments: '{"skillName":"侦查"}',
              status: 'completed',
            },
          }
        })()
      }
      return { id: 'resp_3', output: [] }
    })
    const chunks: string[] = []
    const res = await dispatch(cfg(), {
      messages: [{ role: 'user', content: '我要侦查' }],
      stream: true,
      temperature: 0.3,
      maxTokens: 512,
      onChunk: (c) => chunks.push(c),
    })
    expect(res.stream).toBe(true)
    expect(res.content).toBe('正在侦查…发现了线索。')
    expect(res.chunks).toEqual(['正在侦查…', '发现了线索。'])
    expect(chunks).toEqual(['正在侦查…', '发现了线索。'])
    expect(res.toolCalls).toEqual([{ id: 'fc_2', name: 'skill_check', arguments: '{"skillName":"侦查"}' }])
  })

  it('stream without tools: no toolCalls', async () => {
    mockResponsesCreate((body) => {
      if (body.stream) {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: '就绪。', item_id: 'm' }
        })()
      }
      return { id: 'resp_4', output: [] }
    })
    const res = await dispatch(cfg(), {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.content).toBe('就绪。')
    expect(res.toolCalls).toBeUndefined()
  })

  it('tool round-trip history: assistant function_call precedes tool function_call_output with matching call_id', async () => {
    mockResponsesCreate(() => ({
      id: 'resp_5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '继续。' }] }],
    }))
    const res = await dispatch(cfg(), {
      messages: [
        { role: 'user', content: '侦查房间' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'skill_check', arguments: '{"skillName":"侦查"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '成功' },
      ],
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.content).toBe('继续。')
    const input = calls[0].body.input as { type?: string; role?: string; call_id?: string }[]
    // function_call item（call_id=call_1）必须先于 function_call_output
    const fcIdx = input.findIndex((i) => i.type === 'function_call')
    const fcoIdx = input.findIndex((i) => i.type === 'function_call_output')
    expect(fcIdx).toBeGreaterThanOrEqual(0)
    expect(fcoIdx).toBeGreaterThan(fcIdx)
    expect(input[fcIdx]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'skill_check' })
    expect(input[fcoIdx]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' })
  })

  it('assistant text history is emitted as ResponseOutputMessage (type message, role assistant)', async () => {
    mockResponsesCreate(() => ({
      id: 'resp_6',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '了解。' }] }],
    }))
    const res = await dispatch(cfg(), {
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '我是守密人。' },
        { role: 'user', content: '开始' },
      ],
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.content).toBe('了解。')
    const input = calls[0].body.input as { type?: string; role?: string; content?: unknown }[]
    const assistant = input.find((i) => i.type === 'message' && i.role === 'assistant') as {
      content: { type: string; text: string }[]
    } | undefined
    expect(assistant).toBeDefined()
    expect(assistant?.content[0]).toEqual({ type: 'output_text', text: '我是守密人。' })
  })
})

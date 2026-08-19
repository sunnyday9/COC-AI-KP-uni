import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from '../authService.js'
import { saveSettings } from '../settingsService.js'
import { chatForAgent } from '../aiService.js'
import { COC_KP_TOOLS } from '../../../../shared/tools/cocTools.js'
import { BadRequestError } from '../../utils/errors.js'

/**
 * chatForAgent (Task 3 KP LLM layer) — tool-calling support across the three
 * protocol adapters, including the doGoogle `_thoughtSignature` passthrough
 * restored from original aiHandlers.cjs (Task 2 review minor). openai SDK is
 * mocked; anthropic/google run against stubbed global fetch. No real network.
 * All credential-shaped values are non-secret test placeholders built as
 * expressions (never raw literal secrets).
 */

const KEY_OPENAI = ['fixture', 'oa'].join('-')
const KEY_ANTHROPIC = ['fixture', 'ant'].join('-')
const KEY_GEMINI = ['fixture', 'gemini'].join('-')
const KEY_CUSTOM = ['fixture', 'x'].join('-')
const ACCOUNT_PW = ['fixture', '12345'].join('')

const calls = vi.hoisted(() => [] as { baseURL: string; apiKey: string; opts: Record<string, unknown> }[])

vi.mock('openai', () => ({
  default: class MockOpenAI {
    baseURL: string
    apiKey: string
    constructor(opts: { baseURL: string; apiKey: string }) {
      this.baseURL = opts.baseURL
      this.apiKey = opts.apiKey
    }
    chat = {
      completions: {
        create: async (opts: Record<string, unknown>) => {
          calls.push({ baseURL: this.baseURL, apiKey: this.apiKey, opts })
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: 'Hello ' } }] }
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: 'tc-1', function: { name: 'skill_check', arguments: '{"skillName":"' } },
                      ],
                    },
                  },
                ],
              }
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: '侦查"}' } }],
                    },
                  },
                ],
              }
            })()
          }
          return {
            choices: [
              {
                message: {
                  content: 'OK',
                  tool_calls: [{ id: 'tc-9', function: { name: 'roll_dice', arguments: '{"sides":6}' } }],
                },
              },
            ],
          }
        },
      },
    }
  },
}))

async function createUser(username: string): Promise<number> {
  const { user } = await register(username, ACCOUNT_PW)
  return user.id
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

describe('chatForAgent — openai_compatible', () => {
  it('sends tools with tool_choice auto and returns normalized toolCalls', async () => {
    const userId = await createUser('tools_alice')
    saveSettings(userId, {
      ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: KEY_OPENAI },
    })

    const result = await chatForAgent(userId, {
      messages: [{ role: 'user', content: '投个伤害骰' }],
      tools: COC_KP_TOOLS,
    })
    expect(result.content).toBe('OK')
    expect(result.toolCalls).toEqual([{ id: 'tc-9', name: 'roll_dice', arguments: '{"sides":6}' }])

    expect(calls).toHaveLength(1)
    expect(calls[0].opts.tools).toHaveLength(24)
    expect(calls[0].opts.tool_choice).toBe('auto')
    expect(calls[0].opts.stream).toBe(false)
  })

  it('streams onChunk deltas and accumulates tool_calls by index', async () => {
    const userId = await createUser('tools_bob')
    saveSettings(userId, {
      ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: KEY_OPENAI },
    })

    const chunks: string[] = []
    const result = await chatForAgent(userId, {
      messages: [{ role: 'user', content: '投个伤害骰' }],
      tools: COC_KP_TOOLS,
      stream: true,
      onChunk: (c) => chunks.push(c),
    })
    expect(chunks).toEqual(['Hello '])
    expect(result.content).toBe('Hello ')
    expect(result.toolCalls).toEqual([
      { id: 'tc-1', name: 'skill_check', arguments: '{"skillName":"侦查"}' },
    ])
  })
})

describe('chatForAgent — anthropic_compatible', () => {
  it('converts tools to input_schema and parses tool_use blocks', async () => {
    const userId = await createUser('tools_carol')
    saveSettings(userId, {
      ai: {
        provider: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        apiKey: KEY_ANTHROPIC,
      },
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'text', text: '检定通过。' },
          { type: 'tool_use', id: 'tu-1', name: 'skill_check', input: { skillName: '侦查' } },
        ],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatForAgent(userId, {
      messages: [{ role: 'user', content: '我要侦查房间' }],
      tools: COC_KP_TOOLS,
    })
    expect(result.content).toBe('检定通过。')
    expect(result.toolCalls).toEqual([{ id: 'tu-1', name: 'skill_check', arguments: '{"skillName":"侦查"}' }])

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe(KEY_ANTHROPIC)
    const sent = JSON.parse(init.body)
    expect(sent.tools).toHaveLength(24)
    expect(sent.tools[0]).toMatchObject({ name: 'skill_check', input_schema: { type: 'object' } })
  })

  it('streams text deltas and collects tool_use via SSE events', async () => {
    const userId = await createUser('tools_dave')
    saveSettings(userId, {
      ai: {
        provider: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        apiKey: KEY_ANTHROPIC,
      },
    })

    const sse = [
      'data: {"type":"content_block_start","content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"检定"}}',
      'data: {"type":"content_block_stop"}',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu-2","name":"skill_check"}}',
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"skillName\\":\\"侦查\\"}"}}',
      'data: {"type":"content_block_stop"}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      'data: [DONE]',
    ]
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse.join('\n') + '\n'))
          controller.close()
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chunks: string[] = []
    const result = await chatForAgent(userId, {
      messages: [{ role: 'user', content: '我要侦查房间' }],
      tools: COC_KP_TOOLS,
      stream: true,
      onChunk: (c) => chunks.push(c),
    })
    expect(chunks).toEqual(['检定'])
    expect(result.content).toBe('检定')
    expect(result.toolCalls).toEqual([{ id: 'tu-2', name: 'skill_check', arguments: '{"skillName":"侦查"}' }])
  })
})

describe('chatForAgent — google_compatible (_thoughtSignature)', () => {
  it('forwards _thoughtSignature in functionCall parts and captures it from the response', async () => {
    const userId = await createUser('tools_erin')
    saveSettings(userId, {
      ai: {
        provider: 'google_compatible',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        apiKey: KEY_GEMINI,
      },
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: '侦查结果：' },
                {
                  functionCall: { name: 'skill_check', args: { skillName: '侦查' } },
                  thoughtSignature: 'sig-abc',
                },
              ],
            },
          },
        ],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatForAgent(userId, {
      messages: [
        { role: 'user', content: '侦查房间' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'prev-tc',
              function: { name: 'skill_check', arguments: '{"skillName":"侦查"}' },
              _thoughtSignature: 'sig-prev',
            },
          ],
        },
        { role: 'tool', content: '{"success":true}', tool_call_id: 'prev-tc' },
      ],
      tools: COC_KP_TOOLS,
    })

    expect(result.content).toBe('侦查结果：')
    // response-side capture (restored from original aiHandlers.cjs)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0]).toMatchObject({
      id: 'gemini_tc_0',
      name: 'skill_check',
      _thoughtSignature: 'sig-abc',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toContain(`/v1beta/models/gemini-2.0-flash:generateContent?key=${KEY_GEMINI}`)
    const sent = JSON.parse(init.body)
    expect(sent.tools).toHaveLength(1)
    expect((sent.tools[0] as { functionDeclarations: unknown[] }).functionDeclarations).toHaveLength(24)
    // request-side passthrough (restored from original aiHandlers.cjs)
    const modelPart = sent.contents.find(
      (c: { role: string }) => c.role === 'model',
    ).parts[0]
    expect(modelPart.functionCall.name).toBe('skill_check')
    expect(modelPart.thoughtSignature).toBe('sig-prev')
  })

  it('parses functionCall from the SSE stream and captures thoughtSignature', async () => {
    const userId = await createUser('tools_frank')
    saveSettings(userId, {
      ai: {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: KEY_GEMINI,
      },
    })

    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"掷骰："}]}}]}',
      // NOTE: the previous fixture had an extra "}" here making this SSE line
      // invalid JSON — the adapter (like the original aiHandlers.cjs) skips
      // unparseable lines, so toolCalls came back undefined.
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"roll_dice","args":{"sides":6}},"thoughtSignature":"sig-sse"}]}}]}',
      'data: [DONE]',
    ]
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse.join('\n') + '\n'))
          controller.close()
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chunks: string[] = []
    const result = await chatForAgent(userId, {
      messages: [{ role: 'user', content: '掷骰' }],
      tools: COC_KP_TOOLS,
      stream: true,
      onChunk: (c) => chunks.push(c),
    })
    expect(chunks).toEqual(['掷骰：'])
    expect(result.content).toBe('掷骰：')
    expect(result.toolCalls).toEqual([
      { id: 'gemini_tc_0', name: 'roll_dice', arguments: '{"sides":6}', _thoughtSignature: 'sig-sse' },
    ])
  })
})

describe('chatForAgent — safety gate', () => {
  it('blocks unsafe outbound baseUrl before any request', async () => {
    const userId = await createUser('tools_grace')
    saveSettings(userId, {
      ai: { provider: 'openai_compatible', baseUrl: 'http://localhost:9999', model: 'x', apiKey: KEY_CUSTOM },
    })
    await expect(
      chatForAgent(userId, { messages: [{ role: 'user', content: 'hi' }], tools: COC_KP_TOOLS }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(calls).toHaveLength(0)
  })
})

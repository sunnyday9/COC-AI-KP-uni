import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch } from '../llm/index.js'
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import type { LLMCallParams } from '../llm/types.js'

/**
 * llm dispatch 分派测试（T2 #9）。
 * 验证按 protocol 分发到正确的适配器；未知协议报错。
 * openai SDK mocked（非流式返回 OK）；anthropic/google 走 stubbed fetch。
 */

const calls = vi.hoisted(() => [] as { baseURL: string; opts: Record<string, unknown> }[])

vi.mock('openai', () => ({
  default: class MockOpenAI {
    baseURL: string
    constructor(opts: { baseURL: string }) {
      this.baseURL = opts.baseURL
    }
    chat = {
      completions: {
        create: async (opts: Record<string, unknown>) => {
          calls.push({ baseURL: this.baseURL, opts })
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: 'Hello ' } }] }
            })()
          }
          return { choices: [{ message: { content: 'OK' } }] }
        },
      },
    }
  },
}))

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

const TEST_API_KEY = ['test', 'key'].join('-')

function cfg(protocol: AIProviderConfig['protocol']): AIProviderConfig {
  return {
    protocol,
    baseUrl: 'https://example.com/v1',
    model: 'test-model',
    apiKey: TEST_API_KEY,
    temperature: 0.7,
    maxTokens: 2048,
  }
}

const params: LLMCallParams = { messages: [{ role: 'user', content: 'hi' }] }

describe('llm dispatch', () => {
  it('dispatches openai_chat to the chat-completions adapter (non-stream returns content)', async () => {
    const res = await dispatch(cfg('openai_chat'), params)
    expect(res.stream).toBe(false)
    expect(res.content).toBe('OK')
    expect(calls).toHaveLength(1)
    expect(calls[0].baseURL).toBe('https://example.com/v1')
  })

  it('dispatches anthropic_messages to the anthropic adapter', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'hi from claude' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await dispatch(cfg('anthropic_messages'), params)
    expect(res.content).toBe('hi from claude')
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string
    expect(url).toBe('https://example.com/v1/messages')
  })

  it('dispatches google_compatible to the google adapter', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await dispatch(cfg('google_compatible'), params)
    expect(res.content).toBe('hi from gemini')
  })

  it('openai_responses is not yet implemented (T3)', async () => {
    await expect(dispatch(cfg('openai_responses'), params)).rejects.toThrow(/Unknown protocol/)
  })

  it('rejects an unknown protocol', async () => {
    await expect(
      dispatch({ ...cfg('openai_chat'), protocol: 'bogus' as AIProviderConfig['protocol'] }, params),
    ).rejects.toThrow(/Unknown protocol/)
  })
})

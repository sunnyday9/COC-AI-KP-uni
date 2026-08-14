import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'

/**
 * AI route tests (api-contract §3) — openai SDK is mocked; the anthropic
 * adapter is exercised with a stubbed global fetch. No real network calls.
 */

const state = vi.hoisted(() => {
  const calls: { baseURL: string; apiKey: string; opts: Record<string, unknown> }[] = []
  return { calls }
})

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
          state.calls.push({ baseURL: this.baseURL, apiKey: this.apiKey, opts })
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: 'Hello' } }] }
              yield { choices: [{ delta: { content: ' world' } }] }
            })()
          }
          return { choices: [{ message: { content: 'Hello from mock' } }] }
        },
      },
    }
  },
}))

const CLAUDE_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
]

async function registerToken(username: string) {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: 'secret123' })
  return res.body.token as string
}

async function putSettings(token: string, ai: Record<string, unknown>) {
  return request(createApp())
    .put('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .send({ ai })
}

async function chat(token: string, body: Record<string, unknown>) {
  return request(createApp())
    .post('/api/ai/chat')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

afterEach(() => {
  state.calls.length = 0
  vi.unstubAllGlobals()
})

describe('ai chat', () => {
  it('requires auth (401 without token)', async () => {
    const res = await request(createApp()).post('/api/ai/chat').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(401)
  })

  it('non-stream chat returns { stream: false, content } and forwards config', async () => {
    const token = await registerToken('ai_alice')
    await putSettings(token, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-test-ai',
    })

    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ stream: false, content: 'Hello from mock' })

    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].baseURL).toBe('https://api.openai.com/v1')
    expect(state.calls[0].apiKey).toBe('sk-test-ai')
    expect(state.calls[0].opts).toMatchObject({
      model: 'gpt-4o',
      stream: false,
      temperature: 0.7,
      max_tokens: 2048,
    })
    expect(state.calls[0].opts.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('stream chat returns buffered chunks array', async () => {
    const token = await registerToken('ai_bob')
    await putSettings(token, { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test-ai' })

    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.3,
      maxTokens: 512,
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ stream: true, chunks: ['Hello', ' world'] })
    expect(state.calls[0].opts).toMatchObject({ stream: true, temperature: 0.3, max_tokens: 512 })
  })

  it('chat with localhost baseUrl is blocked by the outbound URL guard (400)', async () => {
    const token = await registerToken('ai_carol')
    await putSettings(token, {
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      model: 'some-model',
      apiKey: 'sk-test-ai',
    })

    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unsafe outbound host/)
    expect(state.calls).toHaveLength(0)
  })

  it('chat without a configured model returns 400', async () => {
    const token = await registerToken('ai_dave')
    await putSettings(token, { provider: 'openai', apiKey: 'sk-test-ai' })
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/请先在设置中选择或输入模型名称/)
  })

  it('chat with invalid messages returns 400', async () => {
    const token = await registerToken('ai_erin')
    const res = await chat(token, { messages: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/non-empty array/)
  })

  it('chat with unknown provider is unreachable via API (settings validation rejects it)', async () => {
    const token = await registerToken('ai_frank')
    const put = await putSettings(token, { provider: 'not-a-provider', model: 'x' })
    expect(put.status).toBe(400)
    expect(put.body).toEqual({ error: 'invalid provider' })
    // defensive fallback in aiService: stored settings are always valid, so
    // with defaults (no provider configured) chat reports missing model.
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/请先在设置中选择或输入模型名称/)
  })

  it('anthropic-compatible chat goes through the fetch adapter', async () => {
    const token = await registerToken('ai_grace')
    await putSettings(token, {
      provider: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test',
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'Hi from Claude' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await chat(token, { messages: [{ role: 'user', content: 'hello' }] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ stream: false, content: 'Hi from Claude' })

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-ant-test')
    const sent = JSON.parse(init.body)
    expect(sent.model).toBe('claude-sonnet-4-20250514')
    expect(sent.messages).toEqual([{ role: 'user', content: 'hello' }])
  })
})

describe('ai models', () => {
  it('requires auth (401 without token)', async () => {
    const res = await request(createApp()).get('/api/ai/models')
    expect(res.status).toBe(401)
  })

  it('anthropic-compatible provider returns the preset model list without network', async () => {
    const token = await registerToken('ai_henry')
    await putSettings(token, {
      provider: 'anthropic_compatible',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test',
    })

    const res = await request(createApp())
      .get('/api/ai/models?purpose=chat')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.map((m: { value: string }) => m.value)).toEqual(CLAUDE_MODELS)
  })

  it('anthropic-compatible embeddings purpose returns []', async () => {
    const token = await registerToken('ai_iris')
    await putSettings(token, { provider: 'anthropic_compatible', apiKey: 'sk-ant-test' })
    const res = await request(createApp())
      .get('/api/ai/models?purpose=embeddings')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('listModels with default settings returns [] without real network (stubbed upstream 401)', async () => {
    const token = await registerToken('ai_jack')
    // Fresh user → server merges DEFAULT_SETTINGS (provider 'openai', baseUrl
    // resolved to https://api.openai.com/v1), which would trigger a real
    // outbound /models fetch. Stub it to answer 401 → empty list, keeping the
    // exercised code path (fetch + !ok → []) identical without network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 })),
    )
    const res = await request(createApp())
      .get('/api/ai/models')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

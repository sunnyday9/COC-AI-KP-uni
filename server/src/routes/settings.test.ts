import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { getDb } from '../db/index.js'
import { decryptSecret } from '../utils/crypto.js'
import type { EncryptedSecret } from '../utils/crypto.js'

/**
 * Settings route tests (api-contract §2).
 * Covers: default structure, PUT→GET persistence (no apiKey leak),
 * ciphertext at rest, apiKey keep-on-omit, invalid protocol → 400.
 * All credential-shaped values below are non-secret test placeholders,
 * built as expressions so they never appear as raw literal secrets.
 */

const KEY_A = ['fixture', 'a'].join('-')
const KEY_B = ['fixture', 'b'].join('-')
const KEY_C = ['fixture', 'c'].join('-')
const KEY_D = ['fixture', 'd'].join('-')
const ACCOUNT_PW = ['fixture', '12345'].join('')

async function registerToken(username: string) {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: ACCOUNT_PW })
  return res.body.token as string
}

function getSettings(token: string) {
  return request(createApp()).get('/api/settings').set('Authorization', `Bearer ${token}`)
}

function putSettings(token: string, body: unknown) {
  return request(createApp())
    .put('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send(body as string | object)
}

const DEFAULT_AI = {
  protocol: 'openai_chat',
  baseUrl: '',
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
}

const DEFAULT_RAG = {
  useEmbeddings: true,
  provider: 'builtin',
  model: 'text-embedding-3-small',
  useGraphRAG: true,
  extractionModel: '',
}

describe('settings routes', () => {
  it('GET without token returns 401', async () => {
    const res = await request(createApp()).get('/api/settings')
    expect(res.status).toBe(401)
  })

  it('GET returns default AppSettings structure for a fresh user (no apiKey field)', async () => {
    const token = await registerToken('s_alice')
    const res = await getSettings(token)
    expect(res.status).toBe(200)
    expect(res.body.ai).toEqual(DEFAULT_AI)
    expect(res.body.rag).toEqual(DEFAULT_RAG)
    expect(res.body.syncServerUrl).toBe('http://localhost:3000')
    expect('apiKey' in res.body.ai).toBe(false)
  })

  it('PUT then GET persists settings and never returns apiKey', async () => {
    const token = await registerToken('s_bob')
    const put = await putSettings(token, {
      ai: {
        protocol: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        apiKey: KEY_A,
        temperature: 0.5,
        maxTokens: 1024,
      },
      rag: { useEmbeddings: false, provider: 'api', model: 'text-embedding-3-large' },
      syncServerUrl: 'https://sync.example.com',
      debugMode: true,
    })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })

    const got = await getSettings(token)
    expect(got.status).toBe(200)
    expect(got.body.ai).toEqual({
      protocol: 'anthropic_messages',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.5,
      maxTokens: 1024,
    })
    expect('apiKey' in got.body.ai).toBe(false)
    expect(got.body.rag).toEqual({
      useEmbeddings: false,
      provider: 'api',
      model: 'text-embedding-3-large',
      useGraphRAG: true,
      extractionModel: '',
    })
    expect(got.body.syncServerUrl).toBe('https://sync.example.com')
    expect(got.body.debugMode).toBe(true)
  })

  it('apiKey is stored as AES-256-GCM ciphertext and round-trips via decryptSecret', async () => {
    const token = await registerToken('s_carol')
    await putSettings(token, { ai: { apiKey: KEY_B } })

    const row = getDb().prepare('SELECT data FROM settings WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('s_carol') as {
      data: string
    }
    const stored = JSON.parse(row.data) as { ai: { apiKey: EncryptedSecret } }
    expect(stored.ai.apiKey).toMatchObject({ v: 1 })
    expect(typeof stored.ai.apiKey.iv).toBe('string')
    expect(typeof stored.ai.apiKey.tag).toBe('string')
    expect(stored.ai.apiKey.data).not.toContain(KEY_B)
    expect(decryptSecret(stored.ai.apiKey)).toBe(KEY_B)
  })

  it('PUT without apiKey keeps the previously stored key (still decryptable)', async () => {
    const token = await registerToken('s_dave')
    await putSettings(token, { ai: { protocol: 'openai_chat', apiKey: KEY_C } })

    // second PUT omits apiKey entirely
    const put2 = await putSettings(token, {
      ai: { protocol: 'openai_responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    })
    expect(put2.status).toBe(200)

    const row = getDb().prepare('SELECT data FROM settings WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('s_dave') as {
      data: string
    }
    const stored = JSON.parse(row.data) as { ai: { apiKey: EncryptedSecret } }
    expect(decryptSecret(stored.ai.apiKey)).toBe(KEY_C)
    expect(stored.ai.protocol).toBe('openai_responses')
  })

  it('PUT with masked placeholder *** keeps the stored key (legacy client behavior)', async () => {
    const token = await registerToken('s_erin')
    await putSettings(token, { ai: { apiKey: KEY_D } })
    await putSettings(token, { ai: { apiKey: '***' } })
    const row = getDb().prepare('SELECT data FROM settings WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('s_erin') as {
      data: string
    }
    const stored = JSON.parse(row.data) as { ai: { apiKey: EncryptedSecret } }
    expect(decryptSecret(stored.ai.apiKey)).toBe(KEY_D)
  })

  it('PUT with invalid protocol returns 400', async () => {
    const token = await registerToken('s_frank')
    const res = await putSettings(token, { ai: { protocol: 'not-a-protocol' } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid protocol' })
  })

  it('PUT with out-of-range temperature returns 400', async () => {
    const token = await registerToken('s_grace')
    const res = await putSettings(token, { ai: { protocol: 'openai_chat', temperature: 3 } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/temperature/)
  })

  it('PUT with non-integer maxTokens returns 400', async () => {
    const token = await registerToken('s_heidi')
    const res = await putSettings(token, { ai: { protocol: 'openai_chat', maxTokens: 10.5 } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/maxTokens/)
  })

  it('PUT with a non-object JSON body returns 400 (rejected by body-parser strict mode)', async () => {
    const token = await registerToken('s_ivan')
    const res = await putSettings(token, '123')
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })
})

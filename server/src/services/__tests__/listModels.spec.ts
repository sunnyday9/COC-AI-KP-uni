import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from '../authService.js'
import { saveSettings } from '../settingsService.js'
import { listModels } from '../aiService.js'
import { AI_MODEL_LISTS } from '../../../../shared/constants/providers.js'

/**
 * listModels 协议分派测试（T4 #11）。
 * chat/responses/messages 统一实时拉取 GET {baseUrl}/models（OpenAI 格式）；
 * anthropic 实时拉取失败回退静态 AI_MODEL_LISTS；google 保留现状。
 * fetch 全部 stub，无真实网络。
 */

const KEY = ['fixture', 'lm'].join('-')
const ACCOUNT_PW = ['fixture', '12345'].join('')

async function createUser(username: string, protocol: string, baseUrl = 'https://api.openai.com/v1') {
  const { user } = await register(username, ACCOUNT_PW)
  saveSettings(user.id, {
    ai: { protocol, baseUrl, model: 'x', apiKey: KEY, temperature: 0.7, maxTokens: 2048 },
  })
  return user.id
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listModels protocol dispatch', () => {
  it('openai_chat: real fetch returns models (purpose=chat)', async () => {
    const userId = await createUser('lm_chat', 'openai_chat')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
      })),
    )
    const models = await listModels(userId, 'chat')
    expect(models.map((m) => m.value)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('openai_responses: same real fetch path', async () => {
    const userId = await createUser('lm_resp', 'openai_responses')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-5' }] }),
      })),
    )
    const models = await listModels(userId, 'chat')
    expect(models.map((m) => m.value)).toEqual(['gpt-5'])
  })

  it('anthropic_messages: real fetch success returns live models', async () => {
    const userId = await createUser('lm_ant_live', 'anthropic_messages', 'https://api.anthropic.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'claude-custom-1' }] }),
      })),
    )
    const models = await listModels(userId, 'chat')
    expect(models.map((m) => m.value)).toEqual(['claude-custom-1'])
  })

  it('anthropic_messages: real fetch failure falls back to static Claude list', async () => {
    const userId = await createUser('lm_ant_static', 'anthropic_messages', 'https://api.anthropic.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    )
    const models = await listModels(userId, 'chat')
    expect(models.map((m) => m.value)).toEqual((AI_MODEL_LISTS.anthropic_compatible ?? []).map((m) => m.value))
  })

  it('anthropic_messages: embeddings purpose falls back to empty (no static embedding list)', async () => {
    const userId = await createUser('lm_ant_emb', 'anthropic_messages', 'https://api.anthropic.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    )
    const models = await listModels(userId, 'embeddings')
    expect(models).toEqual([])
  })

  it('google_compatible: uses /v1beta/models with generateContent filter', async () => {
    const userId = await createUser('lm_goog', 'google_compatible', 'https://generativelanguage.googleapis.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      })),
    )
    const chat = await listModels(userId, 'chat')
    expect(chat.map((m) => m.value)).toEqual(['gemini-2.0-flash'])
  })
})

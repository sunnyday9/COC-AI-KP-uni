import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../settingsStore'
import { TEST_KEY_A, TEST_KEY_B, TEST_KEY_C, TEST_PASSWORD_LONG, TEST_TOKEN_B, TEST_TOKEN_C } from '../../testFixtures'

/**
 * settingsStore 迁移测试（简报决策 2/8）：mock `platform/index` 的 getBridge，
 * 覆盖 load 合并默认值、save 透传 apiKey、认证（login 成功/失败、register、
 * me）、logout 清状态。
 */
const { bridge } = vi.hoisted(() => ({
  bridge: {
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
  },
}))

vi.mock('../../platform/index', () => ({
  getBridge: () => bridge,
}))

describe('settingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    bridge.getSettings.mockReset()
    bridge.setSettings.mockReset()
    bridge.login.mockReset()
    bridge.register.mockReset()
    bridge.logout.mockReset()
    bridge.me.mockReset()
  })

  it('load() merges server settings with defaults and validates the protocol', async () => {
    bridge.getSettings.mockResolvedValue({
      ai: {
        protocol: 'not-a-protocol',
        baseUrl: 'http://example.com',
        model: 'm1',
        apiKey: TEST_KEY_A,
        temperature: 0.5,
        maxTokens: 100,
      },
      rag: { useEmbeddings: false, provider: 'api', model: 'embed-1' },
      syncServerUrl: 'http://sync.example',
      debugMode: true,
    })
    const store = useSettingsStore()
    await store.load()

    // invalid protocol normalized to default
    expect(store.settings.ai.protocol).toBe('openai_chat')
    expect(store.settings.ai.model).toBe('m1')
    expect(store.settings.ai.baseUrl).toBe('http://example.com')
    expect(store.settings.ai.apiKey).toBe(TEST_KEY_A)
    expect(store.settings.ai.temperature).toBe(0.5)
    expect(store.settings.ai.maxTokens).toBe(100)
    expect(store.settings.syncServerUrl).toBe('http://sync.example')
    expect(store.settings.rag?.useEmbeddings).toBe(false)
    expect(store.settings.rag?.provider).toBe('api')
    expect(store.settings.rag?.model).toBe('embed-1')
    expect(store.debugMode).toBe(true)
  })

  it('load() keeps defaults when the server returns an empty object', async () => {
    bridge.getSettings.mockResolvedValue({} as never)
    const store = useSettingsStore()
    await store.load()

    expect(store.settings.ai.protocol).toBe('openai_chat')
    expect(store.settings.ai.model).toBe('')
    expect(store.settings.rag?.useEmbeddings).toBe(true)
    expect(store.settings.rag?.provider).toBe('builtin')
    expect(store.settings.syncServerUrl).toBe('http://localhost:3000')
    expect(store.settings.debugMode).toBe(false)
  })

  it('save() PUTs the current settings via bridge.setSettings (apiKey passthrough)', async () => {
    bridge.setSettings.mockResolvedValue({ ok: true })
    const store = useSettingsStore()
    store.settings.ai.model = 'gpt-4'
    store.settings.ai.apiKey = TEST_KEY_B
    await store.save()

    expect(bridge.setSettings).toHaveBeenCalledTimes(1)
    const sent = bridge.setSettings.mock.calls[0]![0] as { ai: { model: string; apiKey: string } }
    expect(sent.ai.model).toBe('gpt-4')
    expect(sent.ai.apiKey).toBe(TEST_KEY_B)
  })

  it('login() marks the store authenticated and returns the AuthResult', async () => {
    bridge.login.mockResolvedValue({ token: TEST_TOKEN_B, user: { id: '1', username: 'u1' } })
    const store = useSettingsStore()
    const result = await store.login('u1', TEST_PASSWORD_LONG)

    expect(bridge.login).toHaveBeenCalledWith({ username: 'u1', password: TEST_PASSWORD_LONG })
    expect(result.token).toBe(TEST_TOKEN_B)
    expect(store.isAuthenticated).toBe(true)
  })

  it('login() failure leaves isAuthenticated false and propagates the error', async () => {
    bridge.login.mockRejectedValue(new Error('invalid credentials'))
    const store = useSettingsStore()
    await expect(store.login('u1', 'bad')).rejects.toThrow('invalid credentials')
    expect(store.isAuthenticated).toBe(false)
  })

  it('register() marks the store authenticated', async () => {
    bridge.register.mockResolvedValue({ token: TEST_TOKEN_C, user: { id: '2', username: 'u2' } })
    const store = useSettingsStore()
    await store.register('u2', 'pw123456')
    expect(store.isAuthenticated).toBe(true)
  })

  it('me() restores the authenticated state', async () => {
    bridge.me.mockResolvedValue({ user: { id: '1', username: 'u1' } })
    const store = useSettingsStore()
    const result = await store.me()
    expect(result.user.username).toBe('u1')
    expect(store.isAuthenticated).toBe(true)
  })

  it('logout() calls bridge.logout, resets isAuthenticated and clears the settings cache', async () => {
    bridge.logout.mockResolvedValue(undefined)
    const store = useSettingsStore()
    store.isAuthenticated = true
    store.settings.ai.model = 'custom-model'
    store.settings.ai.apiKey = TEST_KEY_C

    await store.logout()

    expect(bridge.logout).toHaveBeenCalledTimes(1)
    expect(store.isAuthenticated).toBe(false)
    // settings cache cleared back to defaults
    expect(store.settings.ai.model).toBe('')
    expect(store.settings.ai.apiKey).toBeUndefined()
    expect(store.settings.ai.protocol).toBe('openai_chat')
  })
})

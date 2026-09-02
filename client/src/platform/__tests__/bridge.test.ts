/**
 * Bridge unit tests (Task 6) — everything runs against the globalThis.uni
 * stub; no real backend, no real WebSocket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformBridge } from '../bridge'
import { getBridge } from '../index'
import { resetBaseUrlCache } from '../config'
import { onUnauthorized, setToken } from '../token'
import { stubUni, type MockSocket } from './uniMock'
import { TEST_PASSWORD, TEST_PASSWORD_BAD, TEST_PASSWORD_SHORT, TEST_TOKEN_A, TEST_TOKEN_B } from '../../testFixtures'

function openFirstSocket(state: { sockets: MockSocket[] }): MockSocket {
  const socket = state.sockets[0]
  socket.emitOpen()
  return socket
}

describe('PlatformBridge', () => {
  let state: ReturnType<typeof stubUni>['state']

  beforeEach(() => {
    vi.useFakeTimers()
    const s = stubUni()
    state = s.state
    resetBaseUrlCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('platform mapping', () => {
    it('maps uniPlatform web → h5', () => {
      state.uniPlatform = 'web'
      expect(new PlatformBridge().platform).toBe('h5')
    })
    it('maps uniPlatform h5 → h5', () => {
      state.uniPlatform = 'h5'
      expect(new PlatformBridge().platform).toBe('h5')
    })
    it('maps uniPlatform mp-weixin → mp-weixin', () => {
      state.uniPlatform = 'mp-weixin'
      expect(new PlatformBridge().platform).toBe('mp-weixin')
    })
    it('maps uniPlatform app/app-plus → app', () => {
      state.uniPlatform = 'app'
      expect(new PlatformBridge().platform).toBe('app')
      state.uniPlatform = 'app-plus'
      expect(new PlatformBridge().platform).toBe('app')
    })
    it('falls back to h5 for unknown platforms', () => {
      state.uniPlatform = 'mp-alipay'
      expect(new PlatformBridge().platform).toBe('h5')
    })
  })

  describe('auth', () => {
    it('login posts credentials and stores the token', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { token: TEST_TOKEN_A, user: { id: '1', username: 'u1' } } })
      const bridge = new PlatformBridge()
      const result = await bridge.login({ username: 'u1', password: TEST_PASSWORD })
      expect(result.token).toBe(TEST_TOKEN_A)
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]).toMatchObject({
        url: '/api/auth/login',
        method: 'POST',
        data: { username: 'u1', password: TEST_PASSWORD },
      })
      expect(state.storage.get('aikp_token')).toBe(TEST_TOKEN_A)
    })

    it('register posts credentials and stores the token', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { token: TEST_TOKEN_B, user: { id: '2', username: 'u2' } } })
      const bridge = new PlatformBridge()
      await bridge.register({ username: 'u2', password: TEST_PASSWORD })
      expect(state.requests[0].url).toBe('/api/auth/register')
      expect(state.storage.get('aikp_token')).toBe(TEST_TOKEN_B)
    })

    it('login rejects when the response lacks a token', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { user: { id: '1', username: 'u1' } } })
      await expect(new PlatformBridge().login({ username: 'u1', password: TEST_PASSWORD_SHORT })).rejects.toThrow('登录响应异常')
    })

    it('me() calls GET /api/auth/me with the bearer header', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { user: { id: '1', username: 'u1' } } })
      setToken('tok123')
      const bridge = new PlatformBridge()
      const res = await bridge.me()
      expect(res.user.username).toBe('u1')
      expect(state.requests[0]).toMatchObject({ url: '/api/auth/me', method: 'GET' })
      expect(state.requests[0].header.Authorization).toBe('Bearer tok123')
    })

    it('logout clears the token and closes the WS connection', async () => {
      setToken('tok123')
      const bridge = new PlatformBridge()
      const p = bridge.connectWs()
      openFirstSocket(state)
      await p
      await bridge.logout()
      expect(state.storage.get('aikp_token')).toBeUndefined()
      expect(state.sockets[0].closeCalls).toBe(1)
    })
  })

  describe('401 handling', () => {
    it('fires onUnauthorized, clears the token and rejects on a protected endpoint', async () => {
      setToken('expired')
      const fired: string[] = []
      const off = bridgeUnauthorized(() => fired.push("unauthorized"))
      state.requestResponder = () => ({ statusCode: 401, data: { error: 'jwt expired' } })
      const bridge = new PlatformBridge()
      await expect(bridge.getSettings()).rejects.toThrow('未登录或登录已过期')
      expect(fired).toHaveLength(1)
      expect(state.storage.get('aikp_token')).toBeUndefined()
      off()
    })

    it('does NOT fire onUnauthorized for login/register 401 (bad credentials)', async () => {
      const fired: string[] = []
      const off = bridgeUnauthorized(() => fired.push("unauthorized"))
      state.requestResponder = () => ({ statusCode: 401, data: { error: 'invalid credentials' } })
      const bridge = new PlatformBridge()
      await expect(bridge.login({ username: 'u', password: TEST_PASSWORD_BAD })).rejects.toThrow('invalid credentials')
      await expect(bridge.register({ username: 'u', password: TEST_PASSWORD_BAD })).rejects.toThrow('invalid credentials')
      expect(fired).toHaveLength(0)
      off()
    })
  })

  describe('settings', () => {
    it('getSettings returns AppSettings without apiKey', async () => {
      state.requestResponder = () => ({
        statusCode: 200,
        data: { ai: { protocol: 'openai_chat', baseUrl: 'https://x', model: 'gpt-4o', temperature: 0.7, maxTokens: 1024 }, syncServerUrl: '' },
      })
      const bridge = new PlatformBridge()
      const s = await bridge.getSettings()
      expect(s.ai.protocol).toBe('openai_chat')
      expect(s.ai.apiKey).toBeUndefined()
    })

    it('setSettings PUTs the settings body', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      const settings = { ai: { protocol: 'anthropic_messages', baseUrl: '', model: 'claude-sonnet-4-20250514', temperature: 0.5, maxTokens: 512 }, syncServerUrl: '' }
      await expect(bridge.setSettings(settings as never)).resolves.toEqual({ ok: true })
      expect(state.requests[0]).toMatchObject({ url: '/api/settings', method: 'PUT' })
      expect(state.requests[0].data).toEqual(settings)
    })
  })

  describe('stories', () => {
    it('listStories GETs the list', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: [{ name: 'a.md', id: 'a.md' }] })
      const bridge = new PlatformBridge()
      await expect(bridge.listStories()).resolves.toEqual([{ name: 'a.md', id: 'a.md' }])
      expect(state.requests[0].url).toBe('/api/stories')
    })

    it('readStory unwraps { name, content } and encodes the id', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { name: 's.md', content: '第一章\n第二章' } })
      const bridge = new PlatformBridge()
      await expect(bridge.readStory('s.md')).resolves.toBe('第一章\n第二章')
      expect(state.requests[0].url).toBe('/api/stories/s.md')
    })

    it('readStoryForRag hits the /rag endpoint', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { name: 's.pdf', content: 'OCR 文本' } })
      const bridge = new PlatformBridge()
      await expect(bridge.readStoryForRag('s.pdf')).resolves.toBe('OCR 文本')
      expect(state.requests[0].url).toBe('/api/stories/s.pdf/rag')
    })

    it('deleteStory DELETEs and resolves void', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      await expect(bridge.deleteStory('a.md')).resolves.toBeUndefined()
      expect(state.requests[0]).toMatchObject({ url: '/api/stories/a.md', method: 'DELETE' })
    })
  })

  describe('uploads (importStory / importScript)', () => {
    it('importStory uploads via uni.uploadFile with field `file`', async () => {
      state.uploadResponder = () => ({ statusCode: 200, data: '{"ok":true,"id":"a.pdf","name":"a.pdf"}' })
      setToken('tok')
      const bridge = new PlatformBridge()
      bridge.setImportFilePath('/tmp/a.pdf')
      const result = await bridge.importStory()
      expect(result).toEqual({ ok: true, id: 'a.pdf', name: 'a.pdf' })
      expect(state.uploads).toHaveLength(1)
      expect(state.uploads[0]).toMatchObject({ url: '/api/stories/upload', filePath: '/tmp/a.pdf', name: 'file' })
      expect(state.uploads[0].header.Authorization).toBe('Bearer tok')
    })

    it('importStory without a pending file resolves { ok:false } without calling upload', async () => {
      const bridge = new PlatformBridge()
      await expect(bridge.importStory()).resolves.toEqual({ ok: false, error: 'no file selected' })
      expect(state.uploads).toHaveLength(0)
    })

    it('importStory accepts an explicit filePath argument', async () => {
      state.uploadResponder = () => ({ statusCode: 200, data: '{"ok":true,"id":"b.md","name":"b.md"}' })
      const bridge = new PlatformBridge()
      await expect(bridge.importStory('/tmp/b.md')).resolves.toEqual({ ok: true, id: 'b.md', name: 'b.md' })
      expect(state.uploads[0].filePath).toBe('/tmp/b.md')
    })

    it('importScript uploads to /api/scripts/upload', async () => {
      state.uploadResponder = () => ({ statusCode: 200, data: '{"ok":true,"id":"s.json","name":"s.json"}' })
      const bridge = new PlatformBridge()
      bridge.setImportFilePath('/tmp/s.json')
      await expect(bridge.importScript()).resolves.toEqual({ ok: true, id: 's.json', name: 's.json' })
      expect(state.uploads[0].url).toBe('/api/scripts/upload')
    })

    it('upload 401 clears token and emits unauthorized', async () => {
      const fired: string[] = []
      const off = bridgeUnauthorized(() => fired.push("unauthorized"))
      setToken('expired')
      state.uploadResponder = () => ({ statusCode: 401, data: '{"error":"jwt expired"}' })
      const bridge = new PlatformBridge()
      bridge.setImportFilePath('/tmp/a.pdf')
      await expect(bridge.importStory()).rejects.toThrow('未登录或登录已过期')
      expect(fired).toHaveLength(1)
      expect(state.storage.get('aikp_token')).toBeUndefined()
      off()
    })

    it('upload business failure returns { ok:false, error } from the body (200)', async () => {
      state.uploadResponder = () => ({ statusCode: 200, data: '{"ok":false,"error":"Invalid script format"}' })
      const bridge = new PlatformBridge()
      bridge.setImportFilePath('/tmp/bad.json')
      await expect(bridge.importScript()).resolves.toEqual({ ok: false, error: 'Invalid script format' })
    })
  })

  describe('scripts', () => {
    it('readScript unwraps content', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { name: 'x.json', content: '{"meta":{}}' } })
      const bridge = new PlatformBridge()
      await expect(bridge.readScript('x.json')).resolves.toBe('{"meta":{}}')
    })

    it('saveScript PUTs content to /api/scripts/:id', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      await expect(bridge.saveScript('x.json', 'new body')).resolves.toEqual({ ok: true })
      expect(state.requests[0]).toMatchObject({ url: '/api/scripts/x.json', method: 'PUT', data: { content: 'new body' } })
    })

    it('saveScriptToLibrary PUTs to the name id (upsert)', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      const result = await bridge.saveScriptToLibrary('My Script', 'body')
      expect(result).toEqual({ ok: true })
      expect(state.requests[0]).toMatchObject({ url: '/api/scripts/My%20Script', method: 'PUT', data: { content: 'body' } })
    })

    it('deleteScript DELETEs', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      await expect(bridge.deleteScript('x.json')).resolves.toBeUndefined()
      expect(state.requests[0]).toMatchObject({ url: '/api/scripts/x.json', method: 'DELETE' })
    })
  })

  describe('ai', () => {
    it('aiChat posts messages + optional params', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { stream: false, content: 'hi' } })
      const bridge = new PlatformBridge()
      const params = { messages: [{ role: 'user' as const, content: 'hello' }], temperature: 0.3, maxTokens: 64 }
      await expect(bridge.aiChat(params)).resolves.toEqual({ stream: false, content: 'hi' })
      expect(state.requests[0]).toMatchObject({ url: '/api/ai/chat', method: 'POST' })
      expect(state.requests[0].data).toEqual(params)
    })

    it('aiListModels appends the purpose query param', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: [{ value: 'm', label: 'M' }] })
      const bridge = new PlatformBridge()
      await expect(bridge.aiListModels({ purpose: 'embeddings' })).resolves.toEqual([{ value: 'm', label: 'M' }])
      expect(state.requests[0].url).toBe('/api/ai/models?purpose=embeddings')
    })
  })

  describe('kp stream (WS) — 退役（ADR-0002）', () => {
    it('bridge no longer exposes kp invoke/stream surface', () => {
      const bridge = new PlatformBridge() as unknown as Record<string, unknown>
      expect(bridge.kpInvoke).toBeUndefined()
      expect(bridge.kpInvokeStream).toBeUndefined()
      expect(bridge.onKpStream).toBeUndefined()
    })
  })

  describe('saves', () => {
    it('listSaves returns the id list', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: ['s1', 's2'] })
      await expect(new PlatformBridge().listSaves()).resolves.toEqual(['s1', 's2'])
    })

    it('readSave returns the raw snapshot', async () => {
      const snap = { version: 1, name: 's1', storyId: 'st' }
      state.requestResponder = () => ({ statusCode: 200, data: snap })
      await expect(new PlatformBridge().readSave('s1')).resolves.toEqual(snap)
      expect(state.requests[0].url).toBe('/api/saves/s1')
    })

    it('writeSave PUTs the snapshot body', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const snap = { version: 1, name: 's1' }
      const bridge = new PlatformBridge()
      await expect(bridge.writeSave('s1', snap as never)).resolves.toBeUndefined()
      expect(state.requests[0]).toMatchObject({ url: '/api/saves/s1', method: 'PUT' })
      expect(state.requests[0].data).toEqual(snap)
    })
  })

  describe('rag', () => {
    it('ragHealth GETs /api/rag/health', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { status: 'ok', service: 'builtin' } })
      await expect(new PlatformBridge().ragHealth()).resolves.toEqual({ status: 'ok', service: 'builtin' })
      expect(state.requests[0].url).toBe('/api/rag/health')
    })

    it('ragQuery posts query params', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { chunks: [] } })
      const bridge = new PlatformBridge()
      await bridge.ragQuery({ query: 'q', scriptId: 's1', sceneId: 'sc', topK: 7 })
      expect(state.requests[0]).toMatchObject({ url: '/api/rag/query', method: 'POST' })
      expect(state.requests[0].data).toEqual({ query: 'q', scriptId: 's1', sceneId: 'sc', topK: 7 })
    })

    it('ragDelete DELETEs /api/rag/index/:scriptId', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true, deleted: 3 } })
      await expect(new PlatformBridge().ragDelete('s1')).resolves.toEqual({ ok: true, deleted: 3 })
      expect(state.requests[0]).toMatchObject({ url: '/api/rag/index/s1', method: 'DELETE' })
    })

    it('ragIndex posts chunks', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true, indexed: 2 } })
      const bridge = new PlatformBridge()
      const params = { scriptId: 's1', chunks: [{ id: 'c1', content: 'x', type: 'text', metadata: {} }] }
      await expect(bridge.ragIndex(params)).resolves.toEqual({ ok: true, indexed: 2 })
      expect(state.requests[0].data).toEqual(params)
    })

    it('ragGetGraph accepts a null result', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: null })
      await expect(new PlatformBridge().ragGetGraph({ scriptId: 's1' })).resolves.toBeNull()
      expect(state.requests[0].url).toBe('/api/rag/graph/s1')
    })

    it('ragUserGraphAdd posts the event', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true } })
      const bridge = new PlatformBridge()
      const params = { storyId: 'st1', sessionId: 'sess', event: { type: 'clue', name: '信件' } }
      await expect(bridge.ragUserGraphAdd(params)).resolves.toEqual({ ok: true })
      expect(state.requests[0]).toMatchObject({ url: '/api/rag/user-graph/event', method: 'POST' })
      expect(state.requests[0].data).toEqual(params)
    })

    it('ragUserGraphSummary returns the summary', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { summary: 'sum' } })
      const bridge = new PlatformBridge()
      await expect(bridge.ragUserGraphSummary({ storyId: 'st1', sessionId: 'sess' })).resolves.toEqual({ summary: 'sum' })
      expect(state.requests[0].url).toBe('/api/rag/user-graph/summary')
    })

    it('ragTestEmbedding posts with no body', async () => {
      state.requestResponder = () => ({ statusCode: 200, data: { ok: true, vectorLength: 384 } })
      await expect(new PlatformBridge().ragTestEmbedding()).resolves.toEqual({ ok: true, vectorLength: 384 })
      expect(state.requests[0].data).toBeUndefined()
    })
  })

  describe('misc', () => {
    it('getBridge returns a stable singleton', () => {
      expect(getBridge()).toBe(getBridge())
    })

    it('rejects with a clear message when the base URL is unconfigured (non-H5)', async () => {
      state.uniPlatform = 'mp-weixin'
      resetBaseUrlCache()
      const bridge = new PlatformBridge()
      await expect(bridge.getSettings()).rejects.toThrow('VITE_API_BASE')
    })

    it('network failure rejects with 网络错误 and the errMsg', async () => {
      state.failNextRequest = { errMsg: 'request:fail timeout' }
      const bridge = new PlatformBridge()
      await expect(bridge.getSettings()).rejects.toThrow('request:fail timeout')
    })
  })
})

/** Register an onUnauthorized listener through the public API (returns unsubscribe). */
function bridgeUnauthorized(cb: () => void): () => void {
  return onUnauthorized(cb)
}

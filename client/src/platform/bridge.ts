/**
 * PlatformBridge (Task 6) — replaces `window.electronAPI` with HTTP + WS calls
 * through the uni.* API, per api-contract §9 (the mapping table is the source
 * of truth; every method below maps 1:1 to a contract endpoint).
 *
 * Design notes:
 * - Single implementation for H5 / mp-weixin / app: uni.request,
 *   uni.uploadFile, uni.connectSocket and uni storage work on all three.
 * - Token: stored under `aikp_token` (token.ts); every request attaches
 *   `Authorization: Bearer`. A 401 (except on login/register, where it means
 *   bad credentials) clears the token and fires `onUnauthorized` — the bridge
 *   only emits the event; page navigation is the page layer's job (Task 8).
 * - Streaming KP: kpInvokeStream returns a fresh streamId, lazily opens the
 *   shared WSService connection, and all chunk/end/error frames fan out to
 *   every onKpStream listener (callers filter by streamId, mirroring the
 *   original kpSessionService pattern).
 * - Uploads (importStory / importScript): uni.uploadFile multipart field
 *   `file`; responses parsed to `{ ok, name?, id?, error? }`.
 * - Runtime dependencies: none beyond uni globals (type-only imports from
 *   shared/ — no runtime import, so no bundling concerns).
 */
import type { AppSettings } from '../../../shared/types/settings'
import type { RoomServerFrame, RoomSnapshot, RoomAction, RoomListItem, RoomDetail, CharacterListItem } from '../../../shared/types/room'
import type {
  AuthResult,
  Bridge,
  BridgeUser,
  IndexedStory,
  KpStreamPayload,
  Platform,
  RAGContextParams,
  RAGIndexParams,
  RAGQueryParams,
  ToolCallResult,
} from '../../../shared/types/bridge'
import { getBaseUrl, getPlatform, joinApiUrl } from './config'
import { clearToken, emitUnauthorized, getToken, setToken } from './token'
import { WSService } from './ws'

/** Error surfaced by the bridge — message only, no stack content. */
export class BridgeError extends Error {
  readonly isBridgeError = true
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const CREDENTIAL_ENDPOINTS = new Set(['/api/auth/login', '/api/auth/register'])

function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError || (typeof err === 'object' && err !== null && (err as { isBridgeError?: unknown }).isBridgeError === true)
}

function parseBody<T>(data: unknown): T {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as T
    } catch {
      return data as unknown as T
    }
  }
  return data as T
}

function extractError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    const msg = (data as { error: string }).error
    if (msg) return msg
  }
  if (typeof data === 'string' && data) return data.slice(0, 200)
  return fallback
}

function generateStreamId(): string {
  const s4 = (): string => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`
}

// Return types derived from the Bridge contract (avoids drift with shared/).
type RagTestGraphRagExtractResult = Awaited<ReturnType<Bridge['ragTestGraphRagExtract']>>
type RagGetIndexResult = Awaited<ReturnType<Bridge['ragGetIndex']>>
type RagGetGraphResult = Awaited<ReturnType<Bridge['ragGetGraph']>>

/** Generic JSON request with bearer-token attachment and 401 handling. */
function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const base = getBaseUrl()
  if (!base) {
    return Promise.reject(new BridgeError('Bridge: 未配置后端地址 — 小程序/App 需设置 VITE_API_BASE 为绝对 URL，H5 默认同源 /api'))
  }
  const url = joinApiUrl(base, path)
  const header: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) header.Authorization = `Bearer ${token}`
  return new Promise<T>((resolve, reject) => {
    uni.request({
      url,
      method,
      ...(body !== undefined ? { data: body as UniApp.RequestOptions['data'] } : {}),
      header,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parseBody<T>(res.data))
        } else if (res.statusCode === 401 && !CREDENTIAL_ENDPOINTS.has(path)) {
          // JWT expired / invalid → clear token and notify (login page handles nav)
          emitUnauthorized()
          reject(new BridgeError('未登录或登录已过期'))
        } else {
          reject(new BridgeError(extractError(res.data, `请求失败 (${res.statusCode})`)))
        }
      },
      fail: (err) => {
        const msg = err && typeof err === 'object' && typeof (err as { errMsg?: unknown }).errMsg === 'string' ? (err as { errMsg: string }).errMsg : ''
        reject(new BridgeError(`网络错误：${msg || '请求失败'}`))
      },
    })
  })
}

export interface UploadResult {
  ok: boolean
  error?: string
  id?: string
  name?: string
}

/** multipart upload (field `file`) with the same auth/401 handling as request(). */
function uploadFile(path: string, filePath: string): Promise<UploadResult> {
  const base = getBaseUrl()
  if (!base) {
    return Promise.reject(new BridgeError('Bridge: 未配置后端地址 — 小程序/App 需设置 VITE_API_BASE 为绝对 URL，H5 默认同源 /api'))
  }
  const url = joinApiUrl(base, path)
  const header: Record<string, string> = {}
  const token = getToken()
  if (token) header.Authorization = `Bearer ${token}`
  return new Promise<UploadResult>((resolve, reject) => {
    uni.uploadFile({
      url,
      filePath,
      name: 'file',
      header,
      success: (res) => {
        const data = parseBody<UploadResult>(res.data)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data && typeof data === 'object' ? data : { ok: true })
        } else if (res.statusCode === 401) {
          emitUnauthorized()
          reject(new BridgeError('未登录或登录已过期'))
        } else {
          reject(new BridgeError(extractError(res.data, `上传失败 (${res.statusCode})`)))
        }
      },
      fail: (err) => {
        const msg = err && typeof err === 'object' && typeof (err as { errMsg?: unknown }).errMsg === 'string' ? (err as { errMsg: string }).errMsg : ''
        reject(new BridgeError(`网络错误：${msg || '上传失败'}`))
      },
    })
  })
}

/** Unwrap `{ name, content }` responses into the raw content string. */
function unwrapContent(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object' && typeof (data as { content?: unknown }).content === 'string') {
    return (data as { content: string }).content
  }
  return ''
}

export class PlatformBridge implements Bridge {
  readonly platform: Platform = getPlatform()

  private readonly ws: WSService
  private readonly kpListeners = new Set<(payload: KpStreamPayload) => void>()
  private pendingImportPath: string | null = null

  constructor(ws?: WSService) {
    this.ws = ws ?? new WSService()
  }

  /**
   * Set the temp file path for the NEXT importStory()/importScript() call
   * (file picking is platform-specific and owned by the page layer, Task 8+).
   * The interface methods themselves take no params (mirroring the original
   * Electron file dialog); passing a path directly also works.
   */
  setImportFilePath(filePath: string): void {
    this.pendingImportPath = filePath
  }

  /** Explicit WS open (preconnect / warm-up). Idempotent. */
  connectWs(): Promise<void> {
    return this.ws.connect()
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  async login(params: { username: string; password: string }): Promise<AuthResult> {
    const result = await request<AuthResult>('POST', '/api/auth/login', params)
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new BridgeError('登录响应异常：缺少 token')
    }
    setToken(result.token)
    return result
  }

  async register(params: { username: string; password: string }): Promise<AuthResult> {
    const result = await request<AuthResult>('POST', '/api/auth/register', params)
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new BridgeError('注册响应异常：缺少 token')
    }
    setToken(result.token)
    return result
  }

  async logout(): Promise<void> {
    clearToken()
    this.ws.close()
  }

  me(): Promise<{ user: BridgeUser }> {
    return request<{ user: BridgeUser }>('GET', '/api/auth/me')
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  getSettings(): Promise<AppSettings> {
    return request<AppSettings>('GET', '/api/settings')
  }

  setSettings(settings: AppSettings): Promise<{ ok: true }> {
    return request<{ ok: true }>('PUT', '/api/settings', settings)
  }

  // ── Stories ──────────────────────────────────────────────────────────────

  listStories(): Promise<{ name: string; id: string }[]> {
    return request<{ name: string; id: string }[]>('GET', '/api/stories')
  }

  async readStory(id: string): Promise<string> {
    const data = await request<unknown>('GET', `/api/stories/${encodeURIComponent(id)}`)
    return unwrapContent(data)
  }

  async readStoryForRag(id: string): Promise<string> {
    const data = await request<unknown>('GET', `/api/stories/${encodeURIComponent(id)}/rag`)
    return unwrapContent(data)
  }

  importStory(filePath?: string): Promise<UploadResult> {
    const fp = filePath ?? this.pendingImportPath
    this.pendingImportPath = null
    if (!fp) return Promise.resolve({ ok: false, error: 'no file selected' })
    return uploadFile('/api/stories/upload', fp)
  }

  async deleteStory(id: string): Promise<void> {
    await request<{ ok: boolean }>('DELETE', `/api/stories/${encodeURIComponent(id)}`)
  }

  // ── Scripts ──────────────────────────────────────────────────────────────

  listScripts(): Promise<{ name: string; id: string }[]> {
    return request<{ name: string; id: string }[]>('GET', '/api/scripts')
  }

  async readScript(id: string): Promise<string> {
    const data = await request<unknown>('GET', `/api/scripts/${encodeURIComponent(id)}`)
    return unwrapContent(data)
  }

  /** Threads the server's actual response through (task-7 minor fix ③). */
  async saveScript(id: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', `/api/scripts/${encodeURIComponent(id)}`, { content })
  }

  /**
   * PUT /api/scripts/:id is an upsert — the server sanitizes the id
   * (fileNames.sanitizeFilename); the stored id is not guaranteed to equal
   * `name` verbatim, so it may be omitted here (callers can listScripts()).
   * The server response (currently `{ ok: true }`) is returned as-is.
   */
  async saveScriptToLibrary(name: string, content: string): Promise<{ ok: boolean; id?: string }> {
    return request<{ ok: boolean; id?: string }>('PUT', `/api/scripts/${encodeURIComponent(name)}`, { content })
  }

  async deleteScript(id: string): Promise<void> {
    await request<{ ok: boolean }>('DELETE', `/api/scripts/${encodeURIComponent(id)}`)
  }

  importScript(filePath?: string): Promise<UploadResult> {
    const fp = filePath ?? this.pendingImportPath
    this.pendingImportPath = null
    if (!fp) return Promise.resolve({ ok: false, error: 'no file selected' })
    return uploadFile('/api/scripts/upload', fp)
  }

  // ── AI ───────────────────────────────────────────────────────────────────

  aiChat(params: {
    messages: { role: string; content: string }[]
    temperature?: number
    maxTokens?: number
    stream?: boolean
  }): Promise<{ stream: boolean; content?: string; chunks?: string[] }> {
    return request('POST', '/api/ai/chat', params)
  }

  aiListModels(params: { purpose?: 'chat' | 'embeddings' } = {}): Promise<{ value: string; label: string }[]> {
    const purpose = params.purpose ?? 'chat'
    return request('GET', `/api/ai/models?purpose=${encodeURIComponent(purpose)}`)
  }

  // ── KP Agent ─────────────────────────────────────────────────────────────

  kpInvoke(params: {
    messages: { role: string; content: string }[]
    storyContext?: unknown
  }): Promise<{ content?: string; toolCalls?: ToolCallResult[] }> {
    return request('POST', '/api/kp/invoke', params)
  }

  /** Open the shared WS connection (lazy), subscribe, and send kp:invoke. */
  async kpInvokeStream(params: {
    messages: { role: string; content: string }[]
    storyContext?: unknown
    /** Phase A2: 服务端图内工具循环 — 传角色卡快照，服务端执行工具并回传更新。 */
    characterSheet?: unknown
  }): Promise<{ streamId: string }> {
    try {
      await this.ws.connect()
    } catch (err) {
      // WS-layer failures (not logged in / connect failure / closed) surface
      // as BridgeError so `isBridgeError` checks stay uniform everywhere
      // (task-7 minor fix ②).
      throw err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err))
    }
    const streamId = generateStreamId()
    this.ws.subscribe(streamId, {
      onChunk: (chunk) => this.fanOut({ streamId, type: 'chunk', chunk }),
      onEnd: (payload) => this.fanOut({ streamId, type: 'end', content: payload.content, toolCalls: payload.toolCalls, displayMessages: payload.displayMessages, worldDeltas: payload.worldDeltas, characterSheet: payload.characterSheet }),
      onError: (error) => this.fanOut({ streamId, type: 'error', error }),
      onTrace: (traceEvents) => this.fanOut({ streamId, type: 'trace', traceEvents }),
    })
    try {
      if (params.characterSheet !== undefined && params.characterSheet !== null) {
        this.ws.sendTurn(streamId, params.messages, params.storyContext ?? null, params.characterSheet)
      } else {
        this.ws.sendInvoke(streamId, params.messages, params.storyContext)
      }
    } catch (err) {
      this.ws.unsubscribe(streamId)
      throw err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err))
    }
    return { streamId }
  }

  /** Register a stream listener; returns an unsubscribe function. */
  onKpStream(handler: (payload: KpStreamPayload) => void): () => void {
    this.kpListeners.add(handler)
    return () => {
      this.kpListeners.delete(handler)
    }
  }

  private fanOut(payload: KpStreamPayload): void {
    for (const listener of [...this.kpListeners]) {
      try {
        listener(payload)
      } catch {
        // a listener must never break delivery to the others
      }
    }
  }

  // ── Rooms（Phase B3，多人联机）──────────────────────────────────────────
  roomCreate(storyId?: string): Promise<{ ok: boolean; roomId: string; inviteCode: string; ownerId: number; ownerName: string }> {
    return request('POST', '/api/rooms', { ...(storyId ? { storyId } : {}) })
  }
  roomList(): Promise<RoomListItem[]> {
    return request<RoomListItem[]>('GET', '/api/rooms')
  }
  roomJoin(inviteCode: string): Promise<{ ok: boolean; roomId: string }> {
    return request('POST', '/api/rooms/join', { inviteCode })
  }
  roomDetail(roomId: string): Promise<RoomDetail> {
    return request<RoomDetail>('GET', `/api/rooms/${encodeURIComponent(roomId)}`)
  }
  roomStart(roomId: string, storyId: string): Promise<{ ok: boolean }> {
    return request('POST', `/api/rooms/${encodeURIComponent(roomId)}/start`, { storyId })
  }
  /** B6 房主控制：修改回合窗口（0..60000，0=严格排队）。 */
  roomSetTurnWindow(roomId: string, turnWindowMs: number): Promise<{ ok: boolean; turnWindowMs?: number }> {
    return request('PUT', `/api/rooms/${encodeURIComponent(roomId)}/settings`, { turnWindowMs })
  }
  roomBindCharacter(roomId: string, characterId: string): Promise<{ ok: boolean }> {
    return request('POST', `/api/rooms/${encodeURIComponent(roomId)}/character`, { characterId })
  }
  roomDelete(roomId: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/api/rooms/${encodeURIComponent(roomId)}`)
  }
  /** 房间 WS 帧：订阅（返回取消函数）。 */
  onRoomFrame(handler: (frame: RoomServerFrame) => void): () => void {
    return this.ws.onRoomFrame(handler)
  }
  /** 房间 WS 帧：发送（join/leave/sync/action）。 */
  sendRoomFrame(type: 'room:join' | 'room:leave' | 'room:sync' | 'room:action', body: Record<string, unknown>): void {
    this.ws.sendRoomFrame(type, body)
  }

  // ── Characters（Phase B4，角色卡持久化）───────────────────────────────
  characterCreate(name: string, sheet: unknown): Promise<{ ok: boolean; id: string; name: string }> {
    return request('POST', '/api/characters', { name, sheet })
  }
  characterList(): Promise<CharacterListItem[]> {
    return request<CharacterListItem[]>('GET', '/api/characters')
  }
  characterDetail(id: string): Promise<CharacterListItem> {
    return request<CharacterListItem>('GET', `/api/characters/${encodeURIComponent(id)}`)
  }
  characterDelete(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/api/characters/${encodeURIComponent(id)}`)
  }

  // ── Saves ────────────────────────────────────────────────────────────────

  listSaves(): Promise<string[]> {
    return request<string[]>('GET', '/api/saves')
  }

  readSave(saveId: string): Promise<unknown> {
    return request<unknown>('GET', `/api/saves/${encodeURIComponent(saveId)}`)
  }

  async writeSave(saveId: string, data: unknown): Promise<void> {
    await request<{ ok: boolean }>('PUT', `/api/saves/${encodeURIComponent(saveId)}`, data)
  }

  // ── RAG ──────────────────────────────────────────────────────────────────

  ragHealth(): Promise<{ status: string; service: string }> {
    return request('GET', '/api/rag/health')
  }

  ragTestEmbedding(): Promise<{ ok: boolean; vectorLength?: number; error?: string }> {
    return request('POST', '/api/rag/test-embedding')
  }

  ragTestGraphRagExtract(params: { scriptId: string; maxChunks?: number; maxBatches?: number }): Promise<RagTestGraphRagExtractResult> {
    return request<RagTestGraphRagExtractResult>('POST', '/api/rag/test-graphrag-extract', params)
  }

  ragIndex(params: RAGIndexParams): Promise<{ ok: boolean; indexed: number }> {
    return request('POST', '/api/rag/index', params)
  }

  ragDelete(scriptId: string): Promise<{ ok: boolean; deleted: number }> {
    return request('DELETE', `/api/rag/index/${encodeURIComponent(scriptId)}`)
  }

  ragQuery(params: RAGQueryParams): Promise<{ chunks: { content: string; metadata: Record<string, string>; distance: number }[] }> {
    return request('POST', '/api/rag/query', params)
  }

  ragContext(params: RAGContextParams): Promise<{ context: string; graphSummary?: string; chunkCount?: number }> {
    return request('POST', '/api/rag/context', params)
  }

  ragListStories(): Promise<IndexedStory[]> {
    return request<IndexedStory[]>('GET', '/api/rag/stories')
  }

  ragStoryOverview(params: { storyId: string; topK?: number }): Promise<{ overview: string; storyName: string }> {
    return request('POST', '/api/rag/story-overview', params)
  }

  ragGetIndex(params: { scriptId: string }): Promise<RagGetIndexResult> {
    return request<RagGetIndexResult>('GET', `/api/rag/index/${encodeURIComponent(params.scriptId)}`)
  }

  ragGetGraph(params: { scriptId: string }): Promise<RagGetGraphResult> {
    return request<RagGetGraphResult>('GET', `/api/rag/graph/${encodeURIComponent(params.scriptId)}`)
  }

  ragUserGraphAdd(params: {
    storyId: string
    sessionId: string
    event: { type: string; name: string; description?: string }
  }): Promise<{ ok: boolean }> {
    return request('POST', '/api/rag/user-graph/event', params)
  }

  ragUserGraphSync(params: {
    storyId: string
    sessionId: string
    state: { cluesObtained: { id: string; description: string }[]; currentScene: string }
  }): Promise<{ ok: boolean }> {
    return request('POST', '/api/rag/user-graph/sync', params)
  }

  ragUserGraphSummary(params: { storyId: string; sessionId: string }): Promise<{ summary: string }> {
    return request('POST', '/api/rag/user-graph/summary', params)
  }
}

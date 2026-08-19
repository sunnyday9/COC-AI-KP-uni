/**
 * WSService (Task 6) — one shared WebSocket connection for all KP streams.
 *
 * State machine (per task-6-brief decision 4/5):
 *
 *   idle ──connect()──▶ connecting ──onOpen──▶ open
 *                    ▲                          │
 *                    │  backoff (1s→2s→4s→…     │ onError / onClose
 *                    │  cap 30s) then retry     │ (auto; not user-close)
 *                    └───────────◀──────────────┘
 *
 * - Lazy connect: the socket is only opened on the first `kpInvokeStream`
 *   (i.e. the first `connect()`/`sendInvoke`).
 * - Heartbeat: `{ type: 'ping' }` every 30s while open; the server answers
 *   `{ type: 'pong' }` (ignored here).
 * - Routing: server frames carry `streamId`; per-stream handlers are looked
 *   up in a subscription map. Multiple streams share the one connection.
 * - Ignore-after-error: once an `error` frame is seen for a streamId, ALL
 *   subsequent frames for that streamId are dropped (timeout-race guard from
 *   the Task 3 review); markers are pruned after 10 minutes when the map
 *   grows past 128 entries.
 * - When an established connection drops, active streams are failed with a
 *   synthetic error so callers never hang; the caller may retry.
 * - Frames of unknown type (e.g. server→client `rag:progress`, `trace`) are
 *   ignored at this layer, mirroring the server's unknown-frame handling.
 */
import { getWsBaseUrl } from './config'
import { getToken } from './token'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface KpStreamHandlers {
  onChunk: (chunk: string) => void
  onEnd: (payload: { content: string; toolCalls?: ToolCall[] }) => void
  onError: (error: string) => void
  /** Optional: server graph trace events (delivered when the frame arrives). */
  onTrace?: (traceEvents: unknown[]) => void
}

export interface WSServiceOptions {
  /** Heartbeat ping interval (default 30s). */
  heartbeatMs?: number
  /** First reconnect delay (default 1s). */
  baseBackoffMs?: number
  /** Reconnect delay cap (default 30s). */
  maxBackoffMs?: number
  /** WS endpoint builder (default: config.getWsBaseUrl). */
  wsUrl?: () => string
  /** Token provider (default: token.getToken). */
  token?: () => string | null
  /** Clock for error-marker pruning. */
  now?: () => number
}

/**
 * Structural subset of the uni SocketTask used by this service.
 * Declared locally because @dcloudio/types' promisify patch types
 * `uni.connectSocket` as returning a Promise (a known typing quirk — the
 * runtime always returns a SocketTask synchronously).
 */
export interface SocketTaskLike {
  send(options: { data: string; success?: () => void; fail?: (err: unknown) => void }): void
  close(options?: { code?: number; reason?: string }): void
  onOpen(callback: (res: unknown) => void): void
  onMessage(callback: (res: { data: unknown }) => void): void
  onClose(callback: (res: unknown) => void): void
  onError(callback: (err: unknown) => void): void
}

/** Wrap whatever uni.connectSocket returns into the structural task type. */
function toSocketTask(task: unknown): SocketTaskLike {
  return task as SocketTaskLike
}

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const ERROR_MARKER_TTL_MS = 10 * 60_000
const ERROR_MARKER_CAP = 128

interface WsFrame {
  type?: unknown
  streamId?: unknown
  chunk?: unknown
  content?: unknown
  toolCalls?: unknown
  error?: unknown
  traceEvents?: unknown
}

export class WSService {
  private socket: SocketTaskLike | null = null
  private socketOpen = false
  private connectPromise: Promise<void> | null = null
  private resolveConnect: (() => void) | null = null
  private rejectConnect: ((err: Error) => void) | null = null
  private streams = new Map<string, KpStreamHandlers>()
  private errorTerminal = new Map<string, number>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private backoffMs = 0
  private closedByUser = false
  private failed = false

  private readonly heartbeatMs: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly wsUrl: () => string
  private readonly token: () => string | null
  private readonly now: () => number

  constructor(options: WSServiceOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.wsUrl = options.wsUrl ?? getWsBaseUrl
    this.token = options.token ?? getToken
    this.now = options.now ?? (() => Date.now())
  }

  isConnected(): boolean {
    return this.socketOpen && this.socket !== null
  }

  /**
   * Lazily open the connection. An explicit call cancels any pending
   * backoff wait and retries immediately (backoff governs automatic
   * reconnects only). Rejects when not logged in or on connect failure.
   */
  connect(): Promise<void> {
    if (this.isConnected()) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.backoffMs = 0
    }
    return this.openSocket()
  }

  /**
   * User-initiated shutdown (logout / app teardown). No reconnect.
   * In-flight streams are failed with a terminal error so callers waiting
   * on a stream never hang (task-7 minor fix ①).
   */
  close(): void {
    this.closedByUser = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.dropPendingConnect(new Error('Bridge: WebSocket 已关闭'))
    this.failActiveStreams('连接已关闭')
    this.errorTerminal.clear()
    this.backoffMs = 0
    const socket = this.socket
    this.socket = null
    this.socketOpen = false
    if (socket) {
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
  }

  /** Subscribe per-stream handlers (called before sendInvoke). */
  subscribe(streamId: string, handlers: KpStreamHandlers): void {
    this.streams.set(streamId, handlers)
  }

  unsubscribe(streamId: string): void {
    this.streams.delete(streamId)
  }

  /** Send a `kp:invoke` frame. Requires an open connection. */
  sendInvoke(streamId: string, messages: { role: string; content: string }[], storyContext?: unknown): void {
    if (!this.isConnected() || !this.socket) {
      throw new Error('Bridge: WebSocket 未连接')
    }
    const frame: Record<string, unknown> = { type: 'kp:invoke', streamId, messages }
    if (storyContext !== undefined && storyContext !== null) frame.storyContext = storyContext
    this.socket.send({
      data: JSON.stringify(frame),
      fail: () => this.handleFailure('消息发送失败'),
    })
  }

  // ── internals ────────────────────────────────────────────────────────────

  private buildUrl(): string {
    const token = this.token()
    if (!token) throw new Error('Bridge: 未登录 — 无法建立 WebSocket 连接')
    const base = this.wsUrl().replace(/\/+$/, '')
    return `${base}?token=${encodeURIComponent(token)}`
  }

  private openSocket(): Promise<void> {
    let url: string
    try {
      url = this.buildUrl()
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve
      this.rejectConnect = reject
    })
    this.connectPromise = promise
    this.failed = false
    this.closedByUser = false

    let socket: SocketTaskLike
    try {
      // Pass success/fail so uni.connectSocket returns the SocketTask
      // synchronously on EVERY platform — on this uni-h5 runtime the
      // callback-less form returns a Promise that resolves to `{ errMsg }`
      // only (the task is otherwise unreachable); mp-weixin/app return the
      // task either way. The success callback fires on task creation (not on
      // socket open — that arrives via onOpen).
      socket = toSocketTask(
        uni.connectSocket({
          url,
          success: () => {},
          fail: () => {},
        }),
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.dropPendingConnect(new Error(`Bridge: 连接失败（${reason}）`))
      this.scheduleReconnect()
      return promise
    }
    this.socket = socket

    socket.onOpen(() => {
      if (this.socket !== socket) return
      this.socketOpen = true
      this.failed = false
      this.backoffMs = 0
      this.startHeartbeat()
      const resolve = this.resolveConnect
      this.resolveConnect = null
      this.rejectConnect = null
      this.connectPromise = null
      resolve?.()
    })

    socket.onMessage((res) => {
      if (this.socket !== socket) return
      this.handleMessage(typeof res?.data === 'string' ? res.data : '')
    })

    socket.onError(() => {
      if (this.socket !== socket) return
      this.handleFailure('连接错误')
    })

    socket.onClose(() => {
      if (this.socket !== socket) return
      this.socketOpen = false
      if (this.closedByUser) return
      this.handleFailure('连接已断开')
    })

    return promise
  }

  private handleFailure(reason: string): void {
    if (this.failed) return
    this.failed = true
    this.socketOpen = false
    this.stopHeartbeat()

    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // already closed
      }
    }

    this.dropPendingConnect(new Error(`Bridge: ${reason}`))
    this.failActiveStreams(reason)
    this.scheduleReconnect()
  }

  private dropPendingConnect(err: Error): void {
    const reject = this.rejectConnect
    this.resolveConnect = null
    this.rejectConnect = null
    this.connectPromise = null
    reject?.(err)
  }

  private failActiveStreams(reason: string): void {
    const active = [...this.streams.values()]
    this.streams.clear()
    for (const h of active) {
      try {
        h.onError(reason)
      } catch {
        // handler failures never break the teardown loop
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = this.nextBackoff()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closedByUser || this.isConnected() || this.connectPromise) return
      void this.openSocket().catch(() => {
        // failure already routed through handleFailure → schedules next retry
      })
    }, delay)
  }

  private nextBackoff(): number {
    if (this.backoffMs <= 0) {
      this.backoffMs = this.baseBackoffMs
    } else {
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    }
    return this.backoffMs
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected() || !this.socket) return
      this.socket.send({
        data: JSON.stringify({ type: 'ping' }),
        fail: () => this.handleFailure('心跳发送失败'),
      })
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleMessage(raw: string): void {
    if (!raw) return
    let frame: WsFrame
    try {
      frame = JSON.parse(raw) as WsFrame
    } catch {
      return // non-JSON frame ignored (server never sends binary)
    }
    if (typeof frame !== 'object' || frame === null) return
    const type = frame.type
    if (type === 'pong' || type === 'rag:progress') return

    // trace frames are delivered to the stream's onTrace handler (the
    // kpSessionService subscribes with a trace listener; previously they were
    // silently dropped here, making the server's trace events dead on the
    // wire — see test-agent REPORT).
    if (type === 'trace') {
      const streamId = typeof frame.streamId === 'string' ? frame.streamId : ''
      if (!streamId || this.errorTerminal.has(streamId)) return
      const handlers = this.streams.get(streamId)
      if (handlers?.onTrace && Array.isArray(frame.traceEvents)) {
        try {
          handlers.onTrace(frame.traceEvents)
        } catch {
          // handler failures never break the message loop
        }
      }
      return
    }

    if (type !== 'chunk' && type !== 'end' && type !== 'error') return
    const streamId = typeof frame.streamId === 'string' ? frame.streamId : ''
    if (!streamId) return

    // Ignore-after-error: no frames for an errored stream are delivered.
    if (this.errorTerminal.has(streamId)) return

    if (type === 'error') {
      this.markErrorTerminal(streamId)
      const handlers = this.streams.get(streamId)
      this.streams.delete(streamId)
      if (handlers) {
        try {
          handlers.onError(typeof frame.error === 'string' && frame.error ? frame.error : 'KP 流错误')
        } catch {
          // handler failures never break the message loop
        }
      }
      return
    }

    if (type === 'end') {
      const handlers = this.streams.get(streamId)
      this.streams.delete(streamId)
      if (handlers) {
        try {
          handlers.onEnd({
            content: typeof frame.content === 'string' ? frame.content : '',
            toolCalls: Array.isArray(frame.toolCalls) ? (frame.toolCalls as ToolCall[]) : undefined,
          })
        } catch {
          // see above
        }
      }
      return
    }

    // chunk
    const handlers = this.streams.get(streamId)
    if (handlers && typeof frame.chunk === 'string') {
      try {
        handlers.onChunk(frame.chunk)
      } catch {
        // see above
      }
    }
  }

  private markErrorTerminal(streamId: string): void {
    const now = this.now()
    this.errorTerminal.set(streamId, now)
    if (this.errorTerminal.size > ERROR_MARKER_CAP) {
      for (const [sid, ts] of this.errorTerminal) {
        if (now - ts > ERROR_MARKER_TTL_MS) this.errorTerminal.delete(sid)
      }
    }
  }
}

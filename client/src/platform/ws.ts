/**
 * WSService (Task 6) — one shared WebSocket connection for the room protocol.
 *
 * State machine (per task-6-brief decision 4/5):
 *
 *   idle ──connect()──▶ connecting ──onOpen──▶ open
 *                    ▲                          │
 *                    │  backoff (1s→2s→4s→…     │ onError / onClose
 *                    │  cap 30s) then retry     │ (auto; not user-close)
 *                    └───────────◀──────────────┘
 *
 * - Lazy connect: the socket is only opened on the first `connect()`
 *   (roomStore.joinRoom → bridge.connectWs).
 * - Heartbeat: `{ type: 'ping' }` every 30s while open; the server answers
 *   `{ type: 'pong' }` (ignored here).
 * - Routing: room frames (`room:state` / `room:event` / `room:sync:done` /
 *   `room:error`) are forwarded to every RoomFrameHandler (ADR-0002 — the KP
 *   `kp:` 前缀帧已退役，回合输出走房间事件流).
 * - When an established connection drops, roomStore is notified via
 *   onReconnect after the automatic reconnect succeeds.
 * - Frames of unknown type (e.g. server→client `rag:progress`) are ignored at
 *   this layer, mirroring the server's unknown-frame handling.
 */
import { getWsBaseUrl } from './config'
import { getToken } from './token'
import type { RoomServerFrame } from '../../../shared/types/room'

/** Phase B3: 房间帧监听器（room:state / room:event / room:sync:done / room:error）。 */
export type RoomFrameHandler = (frame: RoomServerFrame) => void

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

interface WsFrame {
  type?: unknown
}

export class WSService {
  private socket: SocketTaskLike | null = null
  private socketOpen = false
  private connectPromise: Promise<void> | null = null
  private resolveConnect: (() => void) | null = null
  private rejectConnect: ((err: Error) => void) | null = null
  private roomHandlers = new Set<RoomFrameHandler>()
  /** 重连成功后通知（roomStore 据此重新订阅房间——审查修复 #2）。 */
  private reconnectListeners = new Set<() => void>()
  /** 上次连接是否因故障断开（区分首次连接与重连）。 */
  private wasDisconnected = false
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

  constructor(options: WSServiceOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.wsUrl = options.wsUrl ?? getWsBaseUrl
    this.token = options.token ?? getToken
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
   */
  close(): void {
    this.closedByUser = true
    this.wasDisconnected = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.dropPendingConnect(new Error('Bridge: WebSocket 已关闭'))
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

  // ── 房间帧（ADR-0002：唯一的应用层帧族） ─────────────────────────────

  /** 订阅房间帧（room:state/event/sync:done/error）。返回取消函数。 */
  onRoomFrame(handler: RoomFrameHandler): () => void {
    this.roomHandlers.add(handler)
    return () => {
      this.roomHandlers.delete(handler)
    }
  }

  /** 订阅重连通知（断线自动重连成功后触发）。返回取消函数。 */
  onReconnect(handler: () => void): () => void {
    this.reconnectListeners.add(handler)
    return () => {
      this.reconnectListeners.delete(handler)
    }
  }

  /** 发送 room:* 帧（join/leave/sync/action）。Requires an open connection. */
  sendRoomFrame(type: 'room:join' | 'room:leave' | 'room:sync' | 'room:action', body: Record<string, unknown>): void {
    if (!this.isConnected() || !this.socket) {
      throw new Error('Bridge: WebSocket 未连接')
    }
    this.socket.send({
      data: JSON.stringify({ type, ...body }),
      fail: () => this.handleFailure('房间消息发送失败'),
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
      const isReconnect = this.wasDisconnected
      this.socketOpen = true
      this.failed = false
      this.wasDisconnected = false
      this.backoffMs = 0
      this.startHeartbeat()
      const resolve = this.resolveConnect
      this.resolveConnect = null
      this.rejectConnect = null
      this.connectPromise = null
      resolve?.()
      if (isReconnect) {
        // 审查修复 #2：自动重连成功后通知订阅者（roomStore 重新 room:join）
        for (const l of [...this.reconnectListeners]) {
          try {
            l()
          } catch {
            // listener failures never break the reconnect loop
          }
        }
      }
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
    this.wasDisconnected = true
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
    this.scheduleReconnect()
  }

  private dropPendingConnect(err: Error): void {
    const reject = this.rejectConnect
    this.resolveConnect = null
    this.rejectConnect = null
    this.connectPromise = null
    reject?.(err)
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

    // 房间帧（room:*）逐帧转发给订阅者（roomStore）。
    if (type === 'room:state' || type === 'room:event' || type === 'room:sync:done' || type === 'room:error') {
      for (const h of this.roomHandlers) {
        try {
          h(frame as unknown as RoomServerFrame)
        } catch {
          // a handler must never break the message loop
        }
      }
      return
    }

    // unknown types ignored (kp: 前缀帧已随 ADR-0002 退役)
  }
}

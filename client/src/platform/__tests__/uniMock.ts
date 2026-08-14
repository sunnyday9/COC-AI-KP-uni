/**
 * Test-only uni stub (task-6-brief decision 8) — mocks globalThis.uni so the
 * bridge/ws unit tests never touch the network or a real WebSocket.
 *
 * Usage:
 *   const { uni, state } = createUniMock()
 *   vi.stubGlobal('uni', uni)
 *   state.requestResponder = (opts) => ({ statusCode: 200, data: {...} })
 *
 * Socket lifecycle is driven manually via MockSocket.emitOpen/emitMessage/
 * emitError/emitClose (connectSocket never dials anything).
 */
import { vi } from 'vitest'

export interface MockRequestOptions {
  url: string
  method: string
  data?: unknown
  header: Record<string, string>
}

export interface MockUploadOptions {
  url: string
  filePath: string
  name: string
  header: Record<string, string>
}

export interface MockRequestResult {
  statusCode: number
  data: unknown
}

export interface MockSocket {
  url: string
  /** raw frame strings sent by WSService */
  sent: string[]
  closeCalls: number
  /** set true to make the next send() invoke its fail callback */
  failNextSend: boolean
  onOpen: ((res: unknown) => void) | null
  onMessage: ((res: { data: string }) => void) | null
  onClose: ((res: unknown) => void) | null
  onError: ((err: unknown) => void) | null
  emitOpen(): void
  emitMessage(obj: unknown): void
  emitError(err?: unknown): void
  emitClose(): void
}

export function createMockSocket(url: string): MockSocket {
  const socket: MockSocket = {
    url,
    sent: [],
    closeCalls: 0,
    failNextSend: false,
    onOpen: null,
    onMessage: null,
    onClose: null,
    onError: null,
    emitOpen() {
      socket.onOpen?.({})
    },
    emitMessage(obj) {
      socket.onMessage?.({ data: JSON.stringify(obj) })
    },
    emitError(err) {
      socket.onError?.(err ?? {})
    },
    emitClose() {
      socket.onClose?.({})
    },
  }
  return socket
}

export interface UniMockState {
  storage: Map<string, unknown>
  requests: MockRequestOptions[]
  uploads: MockUploadOptions[]
  sockets: MockSocket[]
  uniPlatform: string
  requestResponder: ((opts: MockRequestOptions) => MockRequestResult) | null
  uploadResponder: ((opts: MockUploadOptions) => MockRequestResult) | null
  connectSocketImpl: ((url: string) => MockSocket) | null
  failNextRequest: { errMsg: string } | null
  failNextUpload: { errMsg: string } | null
}

export function createUniMock(): { uni: Record<string, unknown>; state: UniMockState } {
  const state: UniMockState = {
    storage: new Map(),
    requests: [],
    uploads: [],
    sockets: [],
    uniPlatform: 'web',
    requestResponder: null,
    uploadResponder: null,
    connectSocketImpl: null,
    failNextRequest: null,
    failNextUpload: null,
  }

  const uni: Record<string, unknown> = {
    getSystemInfoSync: () => ({ uniPlatform: state.uniPlatform }),
    getStorageSync: (key: string) => state.storage.get(key),
    setStorageSync: (key: string, value: unknown) => {
      state.storage.set(key, value)
    },
    removeStorageSync: (key: string) => {
      state.storage.delete(key)
    },
    request: (opts: {
      url: string
      method: string
      data?: unknown
      header: Record<string, string>
      success?: (res: MockRequestResult) => void
      fail?: (err: { errMsg: string }) => void
    }) => {
      state.requests.push({ url: opts.url, method: opts.method, data: opts.data, header: opts.header })
      if (state.failNextRequest) {
        const { errMsg } = state.failNextRequest
        state.failNextRequest = null
        opts.fail?.({ errMsg })
        return
      }
      const res = state.requestResponder ? state.requestResponder({ url: opts.url, method: opts.method, data: opts.data, header: opts.header }) : { statusCode: 200, data: { ok: true } }
      opts.success?.(res)
    },
    uploadFile: (opts: {
      url: string
      filePath: string
      name: string
      header: Record<string, string>
      success?: (res: MockRequestResult) => void
      fail?: (err: { errMsg: string }) => void
    }) => {
      state.uploads.push({ url: opts.url, filePath: opts.filePath, name: opts.name, header: opts.header })
      if (state.failNextUpload) {
        const { errMsg } = state.failNextUpload
        state.failNextUpload = null
        opts.fail?.({ errMsg })
        return
      }
      const res = state.uploadResponder
        ? state.uploadResponder({ url: opts.url, filePath: opts.filePath, name: opts.name, header: opts.header })
        : { statusCode: 200, data: '{"ok":true}' }
      opts.success?.(res)
    },
    connectSocket: (opts: { url: string }) => {
      const socket = state.connectSocketImpl ? state.connectSocketImpl(opts.url) : createMockSocket(opts.url)
      state.sockets.push(socket)
      return {
        url: socket.url,
        send: (sendOpts: { data: string; fail?: () => void }) => {
          if (socket.failNextSend) {
            socket.failNextSend = false
            sendOpts.fail?.()
            return
          }
          socket.sent.push(sendOpts.data)
        },
        close: () => {
          socket.closeCalls += 1
          socket.onClose?.({})
        },
        onOpen: (cb: (res: unknown) => void) => {
          socket.onOpen = cb
        },
        onMessage: (cb: (res: { data: string }) => void) => {
          socket.onMessage = cb
        },
        onClose: (cb: (res: unknown) => void) => {
          socket.onClose = cb
        },
        onError: (cb: (err: unknown) => void) => {
          socket.onError = cb
        },
      }
    },
  }
  return { uni, state }
}

/** Install the stub as the global `uni` (vi.stubGlobal semantics). */
export function stubUni(): { state: UniMockState } {
  const { uni, state } = createUniMock()
  vi.stubGlobal('uni', uni)
  return { state }
}

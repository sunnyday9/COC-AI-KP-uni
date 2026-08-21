/**
 * WSService unit tests (Task 6) — connection state machine, heartbeat,
 * backoff reconnect, streamId routing, ignore-after-error. All socket
 * behavior is driven through the uni stub (no real WebSocket).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSService, type KpStreamHandlers, type WSServiceOptions } from '../ws'
import { stubUni } from './uniMock'

const noopHandlers = (): KpStreamHandlers => ({ onChunk: () => {}, onEnd: () => {}, onError: () => {} })

describe('WSService', () => {
  let state: ReturnType<typeof stubUni>['state']

  beforeEach(() => {
    vi.useFakeTimers()
    const s = stubUni()
    state = s.state
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function makeWs(overrides: Partial<WSServiceOptions> = {}): WSService {
    return new WSService({
      token: () => 'tok',
      wsUrl: () => 'ws://host/ws',
      baseBackoffMs: 1_000,
      maxBackoffMs: 3_000,
      ...overrides,
    })
  }

  describe('connect', () => {
    it('is lazy — no socket is opened until connect()', () => {
      const ws = makeWs()
      expect(state.sockets).toHaveLength(0)
      void ws.connect()
      expect(state.sockets).toHaveLength(1)
      expect(state.sockets[0].url).toBe('ws://host/ws?token=tok')
    })

    it('resolves on open and reports isConnected', async () => {
      const ws = makeWs()
      const p = ws.connect()
      expect(ws.isConnected()).toBe(false)
      state.sockets[0].emitOpen()
      await p
      expect(ws.isConnected()).toBe(true)
    })

    it('rejects when no token is available and never opens a socket', async () => {
      const ws = makeWs({ token: () => null })
      await expect(ws.connect()).rejects.toThrow('未登录')
      expect(state.sockets).toHaveLength(0)
    })

    it('rejects a connect that fails before open, then schedules a reconnect', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitError()
      await expect(p).rejects.toThrow('Bridge:')
      expect(ws.isConnected()).toBe(false)
      // backoff retry fires after 1s
      vi.advanceTimersByTime(1_000)
      expect(state.sockets).toHaveLength(2)
    })

    it('re-connect() while connecting returns the same pending promise', () => {
      const ws = makeWs()
      const p1 = ws.connect()
      const p2 = ws.connect()
      expect(p1).toBe(p2)
      state.sockets[0].emitOpen()
      void p1
      void p2
    })
  })

  describe('heartbeat', () => {
    it('sends { type: ping } every 30s while open', async () => {
      const ws = makeWs({ heartbeatMs: 30_000 })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      expect(socket.sent).toHaveLength(0)
      vi.advanceTimersByTime(30_000)
      expect(socket.sent).toHaveLength(1)
      expect(JSON.parse(socket.sent[0])).toEqual({ type: 'ping' })
      vi.advanceTimersByTime(30_000)
      expect(socket.sent).toHaveLength(2)
    })

    it('stops heartbeating after close()', async () => {
      const ws = makeWs({ heartbeatMs: 30_000 })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      ws.close()
      vi.advanceTimersByTime(120_000)
      expect(socket.sent).toHaveLength(0)
    })
  })

  describe('routing', () => {
    it('delivers chunk / end / error frames to the matching stream handlers', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const chunks: string[] = []
      const end: Array<{ content: string; toolCalls?: unknown[] }> = []
      const errors: string[] = []
      ws.subscribe('s1', { onChunk: (c) => chunks.push(c), onEnd: (e) => end.push(e), onError: (e) => errors.push(e) })

      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'a' })
      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'b' })
      socket.emitMessage({ type: 'end', streamId: 's1', content: 'ab', toolCalls: [{ id: 't', name: 'n', arguments: '{}' }] })

      expect(chunks).toEqual(['a', 'b'])
      expect(end).toEqual([{ content: 'ab', toolCalls: [{ id: 't', name: 'n', arguments: '{}' }] }])
      expect(errors).toHaveLength(0)
    })

    it('delivers error frames and removes the handler', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const errors: string[] = []
      const h = noopHandlers()
      h.onError = (e) => errors.push(e)
      ws.subscribe('s1', h)
      socket.emitMessage({ type: 'error', streamId: 's1', error: 'boom' })
      expect(errors).toEqual(['boom'])
      // handler removed: late frames are dropped
      socket.emitMessage({ type: 'end', streamId: 's1', content: 'late' })
      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'late' })
      expect(errors).toHaveLength(1)
    })

    it('ignores ALL subsequent frames for a streamId after its error frame', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const chunks: string[] = []
      const ends: unknown[] = []
      const errors: string[] = []
      ws.subscribe('s1', { onChunk: (c) => chunks.push(c), onEnd: (e) => ends.push(e), onError: (e) => errors.push(e) })

      socket.emitMessage({ type: 'error', streamId: 's1', error: 'timeout' })
      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'racer' })
      socket.emitMessage({ type: 'end', streamId: 's1', content: 'racer' })
      socket.emitMessage({ type: 'error', streamId: 's1', error: 'again' })
      expect(chunks).toHaveLength(0)
      expect(ends).toHaveLength(0)
      expect(errors).toEqual(['timeout'])
    })

    it('does not deliver frames for unsubscribed streams', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const chunks: string[] = []
      ws.subscribe('s1', { onChunk: (c) => chunks.push(c), onEnd: () => {}, onError: () => {} })
      ws.unsubscribe('s1')
      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'x' })
      expect(chunks).toHaveLength(0)
    })

    it('routes concurrent streams independently', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const a: string[] = []
      const b: string[] = []
      ws.subscribe('a', { onChunk: (c) => a.push(c), onEnd: () => {}, onError: () => {} })
      ws.subscribe('b', { onChunk: (c) => b.push(c), onEnd: () => {}, onError: () => {} })
      socket.emitMessage({ type: 'chunk', streamId: 'a', chunk: 'A1' })
      socket.emitMessage({ type: 'chunk', streamId: 'b', chunk: 'B1' })
      socket.emitMessage({ type: 'chunk', streamId: 'a', chunk: 'A2' })
      expect(a).toEqual(['A1', 'A2'])
      expect(b).toEqual(['B1'])
    })

    it('ignores non-stream frames (pong, rag:progress, trace, unknown) without crashing', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      const errors: string[] = []
      ws.subscribe('s1', { ...noopHandlers(), onError: (e) => errors.push(e) })
      socket.emitMessage({ type: 'pong' })
      socket.emitMessage({ type: 'rag:progress', payload: { done: 1 } })
      socket.emitMessage({ type: 'trace', streamId: 's1', traceEvents: [] })
      socket.emitMessage({ type: 'nope' })
      socket.emitMessage('not json')
      expect(errors).toHaveLength(0)
    })
  })

  describe('reconnect', () => {
    it('backs off 1s → 2s → 3s (capped) while reconnects keep failing', async () => {
      const ws = makeWs({ baseBackoffMs: 1_000, maxBackoffMs: 3_000 })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p

      state.sockets[0].emitClose()
      vi.advanceTimersByTime(999)
      expect(state.sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(state.sockets).toHaveLength(2) // 1s

      state.sockets[1].emitError() // retry fails before open → 2s
      vi.advanceTimersByTime(1_999)
      expect(state.sockets).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(state.sockets).toHaveLength(3) // 2s

      state.sockets[2].emitError() // still failing → 3s (capped)
      vi.advanceTimersByTime(2_999)
      expect(state.sockets).toHaveLength(3)
      vi.advanceTimersByTime(1)
      expect(state.sockets).toHaveLength(4) // capped at 3s

      state.sockets[3].emitError() // stays capped
      vi.advanceTimersByTime(3_000)
      expect(state.sockets).toHaveLength(5)
    })

    it('resets the backoff after a successful reconnect', async () => {
      const ws = makeWs({ baseBackoffMs: 1_000, maxBackoffMs: 3_000 })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p

      state.sockets[0].emitClose()
      vi.advanceTimersByTime(1_000)
      state.sockets[1].emitOpen()

      state.sockets[1].emitClose()
      vi.advanceTimersByTime(1_000) // back to 1s, not 2s
      expect(state.sockets).toHaveLength(3)
    })

    it('an explicit connect() cancels the pending backoff wait', async () => {
      const ws = makeWs({ baseBackoffMs: 1_000 })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      state.sockets[0].emitClose()
      vi.advanceTimersByTime(500)
      const p2 = ws.connect()
      expect(state.sockets).toHaveLength(2) // immediate attempt, no waiting
      state.sockets[1].emitOpen()
      await p2
    })

    it('close() stops reconnecting and ignores later close events', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      ws.close()
      state.sockets[0].emitClose()
      vi.advanceTimersByTime(10_000)
      expect(state.sockets).toHaveLength(1)
    })

    it('onReconnect fires once after an automatic reconnect succeeds (not on first connect)', async () => {
      const ws = makeWs({ baseBackoffMs: 1_000 })
      const onReconnect = vi.fn()
      ws.onReconnect(onReconnect)
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      expect(onReconnect).not.toHaveBeenCalled() // first connect is not a reconnect

      state.sockets[0].emitClose()
      vi.advanceTimersByTime(1_000)
      state.sockets[1].emitOpen()
      expect(onReconnect).toHaveBeenCalledTimes(1)
    })

    it('onReconnect unsubscribe works', async () => {
      const ws = makeWs({ baseBackoffMs: 1_000 })
      const onReconnect = vi.fn()
      const off = ws.onReconnect(onReconnect)
      off()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      state.sockets[0].emitClose()
      vi.advanceTimersByTime(1_000)
      state.sockets[1].emitOpen()
      expect(onReconnect).not.toHaveBeenCalled()
    })
  })

  describe('failure handling', () => {
    it('fails active streams with the drop reason when the connection dies', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const errors: string[] = []
      ws.subscribe('s1', { ...noopHandlers(), onError: (e) => errors.push(e) })
      state.sockets[0].emitClose()
      expect(errors).toEqual(['连接已断开'])
    })

    it('a failed send triggers failure handling and a reconnect', async () => {
      const ws = makeWs()
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]
      socket.failNextSend = true
      ws.sendInvoke('s1', [{ role: 'user', content: 'hi' }])
      expect(ws.isConnected()).toBe(false)
      vi.advanceTimersByTime(1_000)
      expect(state.sockets).toHaveLength(2)
    })

    it('sendInvoke throws when not connected', () => {
      const ws = makeWs()
      expect(() => ws.sendInvoke('s1', [])).toThrow('未连接')
    })
  })

  describe('error-terminal pruning', () => {
    it('bounds the error-marker map and prunes entries older than 10 minutes', async () => {
      let fakeNow = 1_000_000
      const ws = makeWs({ now: () => fakeNow })
      const p = ws.connect()
      state.sockets[0].emitOpen()
      await p
      const socket = state.sockets[0]

      for (let i = 0; i < 130; i++) {
        ws.subscribe(`sid${i}`, noopHandlers())
        socket.emitMessage({ type: 'error', streamId: `sid${i}`, error: 'e' })
      }
      // nothing pruned yet (markers younger than TTL) — late frame still ignored
      socket.emitMessage({ type: 'end', streamId: 'sid0', content: 'late' })
      fakeNow += 11 * 60_000
      ws.subscribe('fresh', noopHandlers())
      socket.emitMessage({ type: 'error', streamId: 'fresh', error: 'e' })
      // old markers pruned, fresh one retained — and no frames were ever sent
      expect(socket.sent).toHaveLength(0)
    })
  })
})

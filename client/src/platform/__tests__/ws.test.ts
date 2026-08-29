/**
 * WSService unit tests (Task 6; ADR-0002 更新) — connection state machine,
 * heartbeat, backoff reconnect, room-frame routing. All socket behavior is
 * driven through the uni stub (no real WebSocket). kp: 前缀流已退役。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSService, type WSServiceOptions } from '../ws'
import { stubUni } from './uniMock'

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

  async function openWs(overrides: Partial<WSServiceOptions> = {}): Promise<{ ws: WSService; socket: ReturnType<typeof stubUni>['state']['sockets'][number] }> {
    const ws = makeWs(overrides)
    const p = ws.connect()
    state.sockets[0].emitOpen()
    await p
    return { ws, socket: state.sockets[0] }
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
      const { ws, socket } = await openWs({ heartbeatMs: 30_000 })
      expect(socket.sent).toHaveLength(0)
      vi.advanceTimersByTime(30_000)
      expect(socket.sent).toHaveLength(1)
      expect(JSON.parse(socket.sent[0])).toEqual({ type: 'ping' })
      vi.advanceTimersByTime(30_000)
      expect(socket.sent).toHaveLength(2)
      ws.close()
    })

    it('stops heartbeating after close()', async () => {
      const { ws, socket } = await openWs({ heartbeatMs: 30_000 })
      ws.close()
      vi.advanceTimersByTime(120_000)
      expect(socket.sent).toHaveLength(0)
    })
  })

  describe('room-frame routing', () => {
    it('forwards room:state / room:event / room:sync:done / room:error to handlers', async () => {
      const { ws, socket } = await openWs()
      const frames: unknown[] = []
      const off = ws.onRoomFrame((f) => frames.push(f))

      socket.emitMessage({ type: 'room:state', roomId: 'r1', seq: 0, snapshot: {} })
      socket.emitMessage({ type: 'room:event', roomId: 'r1', seq: 1, eventType: 'room_meta', payload: {} })
      socket.emitMessage({ type: 'room:sync:done', roomId: 'r1', seq: 2 })
      socket.emitMessage({ type: 'room:error', roomId: 'r1', error: 'boom' })
      expect(frames).toHaveLength(4)

      off()
      socket.emitMessage({ type: 'room:event', roomId: 'r1', seq: 3, eventType: 'room_meta', payload: {} })
      expect(frames).toHaveLength(4)
    })

    it('a handler failure never breaks the message loop', async () => {
      const { ws, socket } = await openWs()
      const seen: string[] = []
      ws.onRoomFrame(() => {
        throw new Error('handler bug')
      })
      ws.onRoomFrame((f) => seen.push((f as { type: string }).type))
      socket.emitMessage({ type: 'room:state', roomId: 'r1', seq: 0, snapshot: {} })
      expect(seen).toEqual(['room:state'])
    })

    it('ignores non-room frames (pong, rag:progress, kp:*, unknown) without crashing', async () => {
      const { socket } = await openWs()
      const frames: unknown[] = []
      // (listener registered via a fresh service would see nothing here anyway)
      socket.emitMessage({ type: 'pong' })
      socket.emitMessage({ type: 'rag:progress', payload: { done: 1 } })
      socket.emitMessage({ type: 'kp:turn', streamId: 's1' }) // 已退役帧
      socket.emitMessage({ type: 'chunk', streamId: 's1', chunk: 'x' })
      socket.emitMessage({ type: 'end', streamId: 's1', content: 'x' })
      socket.emitMessage({ type: 'nope' })
      socket.emitMessage('not json')
      expect(frames).toHaveLength(0)
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
    it('a failed room send triggers failure handling and a reconnect', async () => {
      const { ws } = await openWs()
      state.sockets[0].failNextSend = true
      ws.sendRoomFrame('room:join', { roomId: 'r1' })
      expect(ws.isConnected()).toBe(false)
      vi.advanceTimersByTime(1_000)
      expect(state.sockets).toHaveLength(2)
    })

    it('sendRoomFrame throws when not connected', () => {
      const ws = makeWs()
      expect(() => ws.sendRoomFrame('room:join', { roomId: 'r1' })).toThrow('未连接')
    })
  })
})

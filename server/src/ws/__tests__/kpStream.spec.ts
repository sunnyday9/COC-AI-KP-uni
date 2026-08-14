import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { createWsServer } from '../index.js'
import { signToken } from '../../middleware/auth.js'
import type { KpTraceEvent } from '../../agent/kpGraph.js'

/**
 * WS endpoint tests (api-contract §4): real HTTP server + real ws client.
 * kpAgentService.invokeKpStream is mocked; the dispatcher, JWT gate and
 * streamId-tagged frame routing are exercised for real.
 */

interface StreamHandlers {
  onChunk: (chunk: string) => void
  onTrace: (traceEvents: KpTraceEvent[]) => void
  onEnd: (result: { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }) => void
  onError: (error: string) => void
}

const state = vi.hoisted(() => ({
  mode: 'end' as 'end' | 'error' | 'throw',
}))

vi.mock('../../services/kpAgentService.js', () => ({
  invokeKpStream: vi.fn(async (_userId: number, _body: unknown, handlers: StreamHandlers) => {
    if (state.mode === 'throw') throw new Error('dispatcher boom')
    if (state.mode === 'error') {
      handlers.onError('graph boom')
      return
    }
    handlers.onChunk('你好')
    handlers.onChunk('，调查员。')
    handlers.onTrace([{ span: 'kp_agent', type: 'intent_classified', data: { intent: 'narrative' } }])
    handlers.onEnd({ content: '你好，调查员。', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{}' }] })
  }),
}))

let server: Server
let wss: WebSocketServer
let port: number

async function startServer(): Promise<void> {
  server = createServer()
  wss = createWsServer(server)
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port
      resolve()
    })
  })
}

function wsUrl(token?: string): string {
  return `ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`
}

/** Open a client; resolves with the socket on 'open'. */
function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** Collect parsed JSON frames until `until` returns true. */
function collect(ws: WebSocket, until: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]> {
  const msgs: Record<string, unknown>[] = []
  return new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      msgs.push(msg)
      if (until(msg)) resolve(msgs)
    })
    ws.on('close', () => reject(new Error('connection closed before done')))
    ws.on('error', reject)
  })
}

async function closeSocket(ws: WebSocket | null): Promise<void> {
  if (!ws) return
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close()
  }
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.on('close', () => resolve())
  })
}

beforeEach(async () => {
  state.mode = 'end'
  await startServer()
})

afterEach(async () => {
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.unstubAllGlobals()
})

describe('ws auth gate', () => {
  it('rejects connections without a token (close 4001)', async () => {
    const ws = new WebSocket(wsUrl())
    const code = await new Promise<number | undefined>((resolve) => {
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => {})
    })
    expect(code).toBe(4001)
  })

  it('rejects connections with an invalid token (close 4001)', async () => {
    const ws = new WebSocket(wsUrl('not-a-jwt'))
    const code = await new Promise<number | undefined>((resolve) => {
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => {})
    })
    expect(code).toBe(4001)
  })

  it('accepts connections with a valid token and answers ping with pong', async () => {
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    const pong = collect(ws, (m) => m.type === 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    const msgs = await pong
    expect(msgs).toEqual([{ type: 'pong' }])
    await closeSocket(ws)
  })
})

describe('ws kp:invoke streaming', () => {
  it('pushes chunk / trace / end frames tagged with the streamId', async () => {
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    const received = collect(ws, (m) => m.type === 'end')
    ws.send(
      JSON.stringify({
        type: 'kp:invoke',
        streamId: 'stream-1',
        messages: [{ role: 'user', content: '我搜索一下房间' }],
      }),
    )
    const msgs = await received
    expect(msgs.map((m) => m.type)).toEqual(['chunk', 'chunk', 'trace', 'end'])
    for (const m of msgs) {
      expect(m.streamId).toBe('stream-1')
    }
    expect(msgs[0].chunk).toBe('你好')
    expect(msgs[1].chunk).toBe('，调查员。')
    const end = msgs[3]
    expect(end.content).toBe('你好，调查员。')
    expect(end.toolCalls).toEqual([{ id: 't1', name: 'skill_check', arguments: '{}' }])
    await closeSocket(ws)
  })

  it('pushes an error frame when the graph fails', async () => {
    state.mode = 'error'
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    const received = collect(ws, (m) => m.type === 'error')
    ws.send(JSON.stringify({ type: 'kp:invoke', streamId: 'stream-2', messages: [{ role: 'user', content: 'hi' }] }))
    const msgs = await received
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].streamId).toBe('stream-2')
    expect(msgs[0].error).toBe('graph boom')
    await closeSocket(ws)
  })

  it('pushes an error frame when the dispatch itself throws', async () => {
    state.mode = 'throw'
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    const received = collect(ws, (m) => m.type === 'error')
    ws.send(JSON.stringify({ type: 'kp:invoke', streamId: 'stream-3', messages: [{ role: 'user', content: 'hi' }] }))
    const msgs = await received
    expect(msgs).toHaveLength(1)
    expect(msgs[0].error).toBe('dispatcher boom')
    await closeSocket(ws)
  })

  it('keeps concurrent streams on one connection isolated by streamId', async () => {
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    let endCount = 0
    const received = collect(ws, () => ++endCount >= 2)
    ws.send(JSON.stringify({ type: 'kp:invoke', streamId: 'concurrent-a', messages: [{ role: 'user', content: 'a' }] }))
    ws.send(JSON.stringify({ type: 'kp:invoke', streamId: 'concurrent-b', messages: [{ role: 'user', content: 'b' }] }))
    const msgs = await received
    const ends = msgs.filter((m) => m.type === 'end')
    expect(ends).toHaveLength(2)
    const streamIds = ends.map((m) => m.streamId).sort()
    expect(streamIds).toEqual(['concurrent-a', 'concurrent-b'])
    // every frame is tagged with one of the two streamIds
    for (const m of msgs) {
      expect(['concurrent-a', 'concurrent-b']).toContain(m.streamId)
    }
    await closeSocket(ws)
  })

  it('ignores unknown message types', async () => {
    const token = signToken(42)
    const ws = await connect(wsUrl(token))
    let gotPong = false
    const received = collect(ws, () => gotPong)
    ws.send(JSON.stringify({ type: 'mystery', data: 1 }))
    ws.send(JSON.stringify({ type: 'ping' }))
    gotPong = true
    const msgs = await received
    expect(msgs).toEqual([{ type: 'pong' }])
    await closeSocket(ws)
  })
})

// @vitest-environment node
/**
 * rag:progress push channel tests (api-contract §4): real HTTP server + real
 * ws clients. Verifies that pushRagProgress delivers `{ type:'rag:progress',
 * payload }` only to the target user's live connections and that sockets are
 * unregistered on close.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { createWsServer } from '../index.js'
import { pushRagProgress } from '../progress.js'
import { signToken } from '../../middleware/auth.js'

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

function wsUrl(token: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${token}`
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

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
  await startServer()
})

afterEach(async () => {
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ws rag:progress push', () => {
  it('delivers rag:progress only to the target user connection', async () => {
    const tokenA = signToken(7)
    const tokenB = signToken(8)
    const wsA = await connect(wsUrl(tokenA))
    const wsB = await connect(wsUrl(tokenB))

    const receivedB: Record<string, unknown>[] = []
    wsB.on('message', (data) => receivedB.push(JSON.parse(data.toString())))

    const receivedA = collect(wsA, (m) => m.type === 'rag:progress')
    pushRagProgress(7, { stage: 'graph_extract', scriptId: 's1', percent: 50, message: 'batch 1/2' })
    const msgs = await receivedA

    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({
      type: 'rag:progress',
      payload: { stage: 'graph_extract', scriptId: 's1', percent: 50, message: 'batch 1/2' },
    })
    // the other user's connection receives nothing
    expect(receivedB).toHaveLength(0)

    await closeSocket(wsA)
    await closeSocket(wsB)
  })

  it('silently skips closed sockets after disconnect', async () => {
    const token = signToken(9)
    const ws = await connect(wsUrl(token))
    const received = collect(ws, (m) => m.type === 'rag:progress')
    pushRagProgress(9, { stage: 'parse', scriptId: 's2' })
    const msgs = await received
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({ type: 'rag:progress', payload: { stage: 'parse', scriptId: 's2' } })

    await closeSocket(ws)
    // No throw even though the socket is gone.
    pushRagProgress(9, { stage: 'parse', scriptId: 's3' })
    pushRagProgress(999, { stage: 'parse', scriptId: 's4' })
  })
})

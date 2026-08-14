import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { invokeKpStream } from '../services/kpAgentService.js'
import type { KpMessage } from '../agent/kpGraph.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/**
 * WebSocket endpoint `ws://<host>/ws?token=<JWT>` (api-contract §4).
 * - Authenticates via ?token= JWT; closes with 4001 when invalid.
 * - Answers heartbeat `{ "type": "ping" }` → `{ "type": "pong" }`.
 * - `kp:invoke` dispatch (Task 3): client sends
 *   `{ "type": "kp:invoke", "streamId", "messages" }`; the server runs the KP
 *   graph once and pushes `chunk` / `trace` / `end` / `error` messages tagged
 *   with the same streamId (mirrors the original `kp:stream` IPC events).
 *   Concurrent streams on one connection are independent — every invocation
 *   closes over its own streamId and sends are guarded by readyState.
 * - `rag:progress` is server→client only (Task 4); unknown types are ignored.
 * - JSON text frames only (no binary frames).
 */
export function createWsServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (socket: WebSocket, req) => {
    let userId: number | null = null
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const token = url.searchParams.get('token')
      const auth = token ? verifyToken(token) : null
      userId = auth ? auth.userId : null
    } catch {
      userId = null
    }
    if (userId === null) {
      socket.close(4001, 'unauthorized')
      return
    }
    logger.info('ws client connected', { userId })

    socket.on('message', (data) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // non-JSON frame ignored
      }
      if (typeof msg !== 'object' || msg === null) return
      const type = (msg as { type?: unknown }).type
      switch (type) {
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong' }))
          break
        case 'kp:invoke':
          handleKpInvoke(socket, userId as number, msg)
          break
        case 'rag:progress':
          // Task 4: RAG index progress (server → client only)
          break
        default:
          // unknown message types ignored
          break
      }
    })

    socket.on('close', () => {
      logger.info('ws client disconnected', { userId })
    })

    socket.on('error', (err) => {
      logger.warn('ws socket error', { userId, error: String(err) })
    })
  })

  return wss
}

/**
 * Dispatch a `kp:invoke` message: validate the payload, run the graph
 * asynchronously, and stream chunk/end/error back on the same streamId.
 * Never throws into the socket message handler.
 */
function handleKpInvoke(socket: WebSocket, userId: number, raw: unknown): void {
  const payload = raw as { streamId?: unknown; messages?: unknown }
  const streamId = typeof payload.streamId === 'string' && payload.streamId ? payload.streamId : 'unknown'

  const send = (obj: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj))
    }
  }

  try {
    void invokeKpStream(
      userId,
      { messages: payload.messages as KpMessage[] },
      {
        onChunk: (chunk) => send({ type: 'chunk', streamId, chunk }),
        onTrace: (traceEvents) => send({ type: 'trace', streamId, traceEvents }),
        onEnd: (result) =>
          send({
            type: 'end',
            streamId,
            content: result.content ?? '',
            toolCalls: result.toolCalls,
          }),
        onError: (error) => send({ type: 'error', streamId, error }),
      },
    ).catch((err) => {
      // invokeKpStream catches its own failures; this guards unexpected throws
      // (e.g. validation errors from malformed message entries).
      send({ type: 'error', streamId, error: errorMessage(err) })
    })
  } catch (err) {
    send({ type: 'error', streamId, error: errorMessage(err) })
  }
}

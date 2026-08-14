import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { logger } from '../utils/logging.js'

/**
 * WebSocket endpoint `ws://<host>/ws?token=<JWT>` (api-contract §4).
 * - Authenticates via ?token= JWT; closes with 4001 when invalid.
 * - Answers heartbeat `{ "type": "ping" }` → `{ "type": "pong" }`.
 * - Message dispatch switch reserved for `kp:invoke` / `rag:progress` (Tasks 2-4);
 *   unknown types are ignored.
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
          // Task 3: route to KP Agent streaming (kp:stream)
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

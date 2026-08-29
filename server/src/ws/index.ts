import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { logger } from '../utils/logging.js'
import { registerProgressSocket, unregisterProgressSocket } from './progress.js'
import { cleanupSocketRooms, handleRoomAction, handleRoomJoin, handleRoomLeave, handleRoomSync } from './rooms.js'

/**
 * WebSocket endpoint `ws://<host>/ws?token=<JWT>` (api-contract §4).
 * - Authenticates via ?token= JWT; closes with 4001 when invalid.
 * - Answers heartbeat `{ "type": "ping" }` → `{ "type": "pong" }`.
 * - KP 回合只走房间协议（ADR-0002：单人=单成员房间，无 kp: 前缀帧）；
 *   玩家输入经 `room:action{chat}` → RoomService 串行回合 → `room:event` 广播。
 * - `rag:progress` is server→client only (Task 4): connected sockets are
 *   registered per user (see ./progress.ts) so long RAG tasks can push
 *   `{ type: 'rag:progress', payload }` frames; unknown client types ignored.
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
    registerProgressSocket(userId, socket)

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
        case 'room:join':
          handleRoomJoin(socket, userId as number, msg)
          break
        case 'room:leave':
          handleRoomLeave(socket, String((msg as { roomId?: unknown }).roomId ?? ''))
          break
        case 'room:sync':
          handleRoomSync(socket, userId as number, msg)
          break
        case 'room:action':
          handleRoomAction(socket, userId as number, msg)
          break
        case 'rag:progress':
          // Task 4: RAG index progress (server → client only)
          break
        default:
          // unknown message types ignored（kp: 前缀帧已随 ADR-0002 退役）
          break
      }
    })

    socket.on('close', () => {
      unregisterProgressSocket(socket)
      cleanupSocketRooms(socket)
      logger.info('ws client disconnected', { userId })
    })

    socket.on('error', (err) => {
      unregisterProgressSocket(socket)
      cleanupSocketRooms(socket)
      logger.warn('ws socket error', { userId, error: String(err) })
    })
  })

  return wss
}


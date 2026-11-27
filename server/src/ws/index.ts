import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { registerProgressSocket, unregisterProgressSocket } from './progress.js'
import { cleanupSocketRooms, handleRoomAction, handleRoomJoin, handleRoomLeave, handleRoomSync } from './rooms.js'
import { markTransportReset, sendFrame } from './sendFrame.js'

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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 128 * 1024 })

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

    const currentUserId = userId
    const disconnected = new AbortController()
    let pending = 0
    let frameQueue = Promise.resolve()
    const cleanUp = () => {
      disconnected.abort()
      unregisterProgressSocket(socket)
      void cleanupSocketRooms(socket, currentUserId).catch((error) => {
        logger.warn('room disconnect cleanup failed', { userId, error: errorMessage(error) })
      })
    }

    socket.on('message', (data) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // non-JSON frame ignored
      }
      if (typeof msg !== 'object' || msg === null) return
      const type = (msg as { type?: unknown }).type
      if (type === 'ping') {
        sendFrame(socket, '{"type":"pong"}')
        return
      }
      if (type !== 'room:join' && type !== 'room:leave' && type !== 'room:sync' && type !== 'room:action') return
      const roomId = String((msg as { roomId?: unknown }).roomId ?? '')
      if (pending >= 64) {
        sendFrame(socket, JSON.stringify({ type: 'room:error', roomId, error: 'Too many pending room frames. Try again.' }))
        return
      }
      pending++
      frameQueue = frameQueue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return
        switch (type) {
          case 'room:join': return handleRoomJoin(socket, currentUserId, msg, disconnected.signal)
          case 'room:leave': return handleRoomLeave(socket, roomId)
          case 'room:sync': return handleRoomSync(socket, currentUserId, msg, disconnected.signal)
          case 'room:action': return handleRoomAction(socket, currentUserId, msg, disconnected.signal)
        }
      }).catch((error) => {
        logger.warn('room frame failed', { userId, roomId, error: errorMessage(error) })
        sendFrame(socket, JSON.stringify({ type: 'room:error', roomId, error: 'room operation unavailable' }))
      }).finally(() => { pending-- })
    })

    socket.on('close', () => {
      cleanUp()
      logger.info('ws client disconnected', { userId })
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      // ws has already initiated a 1009 close for the inbound message limit.
      if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') markTransportReset(socket)
      cleanUp()
      logger.warn('ws socket error', { userId, error: String(err) })
    })
  })

  return wss
}


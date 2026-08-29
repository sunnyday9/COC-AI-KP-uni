import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { invokeKpStream } from '../services/kpAgentService.js'
import { runKpTurn } from '../services/kpTurnService.js'
import { createCharacterMutatorFactory } from '../rule-engine/characterMutators.js'
import type { KpMessage } from '../agent/kpGraph.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { registerProgressSocket, unregisterProgressSocket } from './progress.js'
import { cleanupSocketRooms, handleRoomAction, handleRoomJoin, handleRoomLeave, handleRoomSync } from './rooms.js'

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
        case 'kp:invoke':
          handleKpInvoke(socket, userId as number, msg)
          break
        case 'kp:turn':
          handleKpTurn(socket, userId as number, msg)
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
          // unknown message types ignored
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

/**
 * Dispatch a `kp:turn` message (Phase A2 服务端图内工具循环):
 *  - client sends `{ type: 'kp:turn', streamId, messages, storyContext, characterSheet }`
 *  - server runs the full graph + tool-execution loop (rule-engine), applying
 *    character mutations to the provided sheet snapshot, and streams back
 *    `chunk` / `trace` / `end` (content + displayMessages + updated characterSheet).
 * Never throws into the socket message handler.
 */
function handleKpTurn(socket: WebSocket, userId: number, raw: unknown): void {
  const payload = raw as {
    streamId?: unknown
    messages?: unknown
    storyContext?: unknown
    characterSheet?: unknown
  }
  const streamId = typeof payload.streamId === 'string' && payload.streamId ? payload.streamId : 'unknown'

  const send = (obj: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    let frame: string
    try {
      frame = JSON.stringify(obj)
    } catch (err) {
      logger.warn('ws send serialization failed, frame dropped', { streamId, error: errorMessage(err) })
      return
    }
    socket.send(frame)
  }

  // 角色卡：客户端不再执行规则，回合开始时需把当前快照带上，服务端更新后随 end 帧回传。
  // kp:turn 契约 = 单卡（多卡只属于房间路径；评审候选 1 删除从不发送的 payload.characters 分支）。
  const characterSheet = (payload.characterSheet as COCCharacterSheet | null | undefined) ?? null
  const characters: Record<string, COCCharacterSheet> | null = characterSheet ? { default: characterSheet } : null

  try {
    void runKpTurn(
      userId,
      {
        messages: payload.messages as KpMessage[],
        storyContext: (payload.storyContext as Record<string, unknown> | null | undefined) ?? null,
      },
      {
        characters,
        activeCharacterId: characterSheet ? 'default' : null,
        // 15 个变更语义的唯一实现（评审候选 1）；单人路径无 world 回调——worldDeltas 由 kpTurnService 收集
        mutatorFactory: createCharacterMutatorFactory({
          resolveSheet: (id) => (id && characters ? characters[id] ?? null : null),
        }),
        handlers: {
          onChunk: (chunk) => send({ type: 'chunk', streamId, chunk }),
          onToolExecuted: (info) => send({ type: 'tool', streamId, tool: info }),
          onEnd: (result) =>
            send({
              type: 'end',
              streamId,
              content: result.content ?? '',
              displayMessages: result.displayMessages ?? [],
              toolCalls: result.toolCalls ?? [],
              worldDeltas: result.worldDeltas ?? { cluesAdded: [] },
              characterSheet: result.characterSheet ?? null,
            }),
          onError: (error) => send({ type: 'error', streamId, error }),
        },
      },
    ).catch((err) => {
      send({ type: 'error', streamId, error: errorMessage(err) })
    })
  } catch (err) {
    send({ type: 'error', streamId, error: errorMessage(err) })
  }
}

/**
 * Dispatch a `kp:invoke` message: validate the payload, run the graph
 * asynchronously, and stream chunk/end/error back on the same streamId.
 * Never throws into the socket message handler.
 */
function handleKpInvoke(socket: WebSocket, userId: number, raw: unknown): void {
  const payload = raw as { streamId?: unknown; messages?: unknown; storyContext?: unknown }
  const streamId = typeof payload.streamId === 'string' && payload.streamId ? payload.streamId : 'unknown'

  const send = (obj: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    let frame: string
    try {
      frame = JSON.stringify(obj)
    } catch (err) {
      logger.warn('ws send serialization failed, frame dropped', { streamId, error: errorMessage(err) })
      return
    }
    socket.send(frame)
  }

  try {
    void invokeKpStream(
      userId,
      {
        messages: payload.messages as KpMessage[],
        storyContext: (payload.storyContext as Record<string, unknown> | null | undefined) ?? null,
      },
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

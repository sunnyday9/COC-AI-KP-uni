import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../middleware/auth.js'
import { invokeKpStream } from '../services/kpAgentService.js'
import { runKpTurn } from '../services/kpTurnService.js'
import type { KpMessage } from '../agent/kpGraph.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import { errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { registerProgressSocket, unregisterProgressSocket } from './progress.js'

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
      logger.info('ws client disconnected', { userId })
    })

    socket.on('error', (err) => {
      unregisterProgressSocket(socket)
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

  // 角色卡：客户端不再执行规则，但回合开始时需把当前快照带上，服务端更新后随 end 帧回传。
  const characterSheet = (payload.characterSheet as COCCharacterSheet | null | undefined) ?? null

  try {
    void runKpTurn(
      userId,
      {
        messages: payload.messages as KpMessage[],
        storyContext: (payload.storyContext as Record<string, unknown> | null | undefined) ?? null,
      },
      characterSheet,
      {
        updateCharacterHP: (delta) => { if (characterSheet?.derived) characterSheet.derived.hp = Math.max(0, (characterSheet.derived.hp ?? 0) + delta) },
        updateCharacterMP: (delta) => { if (characterSheet?.derived) characterSheet.derived.mp = Math.max(0, (characterSheet.derived.mp ?? 0) + delta) },
        updateCharacterSAN: (delta) => { if (characterSheet?.derived) characterSheet.derived.san = Math.max(0, (characterSheet.derived.san ?? 0) + delta) },
        updateCharacterLuck: (delta) => { if (characterSheet?.attributes) characterSheet.attributes.luck = Math.max(0, (characterSheet.attributes.luck ?? 0) + delta) },
        addCharacterDailySanLoss: (amount) => { if (characterSheet) characterSheet.dailySanLoss = (characterSheet.dailySanLoss ?? 0) + amount },
        resetCharacterDailySanLoss: () => { if (characterSheet) characterSheet.dailySanLoss = 0 },
        updateCharacterInsanityState: (state, phobias, manias) => {
          if (!characterSheet) return
          characterSheet.insanityState = state
          if (phobias) characterSheet.phobias = phobias
          if (manias) characterSheet.manias = manias
        },
        setCharacterMajorWound: (v) => { if (characterSheet) characterSheet.hasMajorWound = v },
        setCharacterDying: (v) => { if (characterSheet) characterSheet.isDying = v },
        growCharacterSkill: (id, v) => { if (characterSheet?.skills) characterSheet.skills[id] = v },
        increaseCthulhuMythos: (gain) => { if (characterSheet) characterSheet.cthulhuMythos = (characterSheet.cthulhuMythos ?? 0) + gain },
        transitionToScene: () => { /* 世界增量由 kpTurnService 收集进 worldDeltas，随 end 帧回传 */ },
        addClue: () => { /* 同上 */ },
        endGame: () => { /* 同上 */ },
        generateId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      },
      {
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

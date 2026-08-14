import { WebSocket } from 'ws'

/**
 * Server→client `rag:progress` push channel (api-contract §4 通用消息).
 *
 * Payload shape (task-4-brief decision 4):
 *   { type: 'rag:progress', payload: { stage, scriptId, percent?, message? } }
 * - stage:   progress stage id, e.g. 'graph_extract' (per-batch extraction)
 * - scriptId: the story/script being processed
 * - percent?: 0-100 completion estimate (when meaningful)
 * - message?: human-readable hint
 *
 * The registry maps userId → connected sockets so long tasks (RAG indexing,
 * extraction) can push progress to every live connection of the requesting
 * user. Unknown/unreachable sockets are skipped (send guarded by readyState).
 */

export interface RagProgressPayload {
  stage: string
  scriptId: string
  percent?: number
  message?: string
}

const userSockets = new Map<number, Set<WebSocket>>()

/** Attach an authenticated socket to its user's push set. */
export function registerProgressSocket(userId: number, socket: WebSocket): void {
  let set = userSockets.get(userId)
  if (!set) {
    set = new Set()
    userSockets.set(userId, set)
  }
  set.add(socket)
}

/** Detach a socket (on close/error). */
export function unregisterProgressSocket(socket: WebSocket): void {
  for (const [userId, set] of userSockets) {
    if (set.delete(socket) && set.size === 0) {
      userSockets.delete(userId)
    }
  }
}

/**
 * Broadcast a rag:progress frame to every live connection of `userId`.
 * Never throws; sockets that are not OPEN are silently skipped.
 */
export function pushRagProgress(userId: number, payload: RagProgressPayload): void {
  const sockets = userSockets.get(userId)
  if (!sockets || sockets.size === 0) return
  const frame = JSON.stringify({ type: 'rag:progress', payload })
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(frame)
      } catch {
        // skip dead sockets; close handler will unregister them
      }
    }
  }
}

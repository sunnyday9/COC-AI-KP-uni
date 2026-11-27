import { WebSocket } from 'ws'

export type FrameRecipient = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'terminate'>

const MAX_PENDING_BYTES = 2 * 1024 * 1024
const transportResets = new WeakSet<FrameRecipient>()

export function markTransportReset(socket: FrameRecipient): void {
  transportResets.add(socket)
}

export function isTransportReset(socket: FrameRecipient): boolean {
  return transportResets.has(socket)
}

export function roomEventFrame(roomId: string, seq: number, { type, payload }: { type: string; payload: unknown }) {
  return { type: 'room:event', roomId, seq, eventType: type, payload } as const
}

/** Permit one large restored snapshot. Stop adding frames behind a slow client. */
export function sendFrame(socket: FrameRecipient, frame: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > 0 && socket.bufferedAmount + Buffer.byteLength(frame) > MAX_PENDING_BYTES) {
    markTransportReset(socket)
    socket.terminate()
    return
  }
  socket.send(frame, (error) => {
    if (error) socket.terminate()
  })
}

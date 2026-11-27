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

export function encodeRoomReplay(
  roomId: string, events: readonly { seq: number; type: string; payload: unknown }[], maxBytes: number,
): string[] | null {
  const frames: string[] = []
  let bytes = 0
  for (const event of events) {
    const frame = JSON.stringify(roomEventFrame(roomId, event.seq, event))
    bytes += Buffer.byteLength(frame)
    if (bytes > maxBytes) return null
    frames.push(frame)
  }
  return frames
}

/** Permit one large restored snapshot. Stop adding frames behind a slow client. */
export function canSendFrame(socket: FrameRecipient, frame: string): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  if (socket.bufferedAmount > 0 && socket.bufferedAmount + Buffer.byteLength(frame) > MAX_PENDING_BYTES) {
    markTransportReset(socket)
    socket.terminate()
    return false
  }
  return true
}

export function sendFrame(socket: FrameRecipient, frame: string): void {
  if (!canSendFrame(socket, frame)) return
  socket.send(frame, (error) => {
    if (error) socket.terminate()
  })
}

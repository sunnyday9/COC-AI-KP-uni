import type { Message } from '../../../shared/types/game.js'
import type { RoomSnapshot } from './roomService.js'

const HOT_TRANSCRIPT_MESSAGES = 40
const HOT_TRANSCRIPT_BYTES = 512 * 1024

export function isNarrative(message: Message): boolean {
  return message?.role === 'player' || message?.role === 'kp'
}

export function boundTranscript(snapshot: Pick<RoomSnapshot, 'messages' | 'transcript' | 'hasNarrative'>): void {
  const { messages } = snapshot
  if (!snapshot.hasNarrative && messages.some(isNarrative)) snapshot.hasNarrative = true
  let cutoff = messages.length
  let bytes = 0
  const earliest = Math.max(0, messages.length - HOT_TRANSCRIPT_MESSAGES)
  while (cutoff > earliest) {
    bytes += Buffer.byteLength(JSON.stringify(messages[cutoff - 1])) + 1
    if (bytes > HOT_TRANSCRIPT_BYTES) break
    cutoff--
  }
  if (cutoff > 0) snapshot.messages = messages.slice(cutoff)
  if (cutoff > 0 || snapshot.transcript) snapshot.transcript = { before: snapshot.messages[0]?.id ?? null }
}

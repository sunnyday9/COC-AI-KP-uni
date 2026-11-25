import { setTimeout as delay } from 'node:timers/promises'
import { readRoomOutbox } from '../services/roomOutbox.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import { roomIdsOfSocket, subscribeSocket, subscribersOf, unsubscribeSocket, type RoomSubscriber } from './roomLedger.js'
import { releaseGatewayPresence } from './gatewayPresence.js'
import { sendFrame } from './sendFrame.js'

interface Subscription {
  userId: number
  seq: number
}

const subscriptions = new Map<string, Map<RoomSubscriber, Subscription>>()
let subscriptionCount = 0

export function subscribeGatewaySocket(socket: RoomSubscriber, roomId: string, userId: number, seq: number): boolean {
  const rooms = roomIdsOfSocket(socket)
  let listeners = subscriptions.get(roomId)
  const previous = listeners?.get(socket)
  if (previous && previous.seq > seq) {
    sendFrame(socket, JSON.stringify({ type: 'room:sync:done', roomId, seq: previous.seq }))
    return false
  }
  if (!previous && (rooms.length >= 8 || subscriptionCount >= 4096 ||
      (!listeners && subscriptions.size >= 1024) || (listeners?.size ?? 0) >= 256)) {
    sendFrame(socket, JSON.stringify({ type: 'room:error', roomId, error: 'Room subscription limit reached.' }))
    return false
  }
  if (!listeners) {
    listeners = new Map()
    subscriptions.set(roomId, listeners)
  }
  listeners.set(socket, { userId, seq })
  subscribeSocket(socket, roomId)
  if (!previous) subscriptionCount++
  return true
}

export function unsubscribeGatewaySocket(socket: RoomSubscriber, roomId: string): void {
  releaseGatewayPresence(socket, roomId)
  const listeners = subscriptions.get(roomId)
  if (!listeners?.delete(socket)) return
  if (listeners.size === 0) subscriptions.delete(roomId)
  subscriptionCount--
  unsubscribeSocket(socket, roomId)
}

export async function runGatewayRoomFanout(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const activeRooms = [...subscriptions.keys()]
    for (let first = 0; first < activeRooms.length && !signal.aborted; first += 16) {
      const page = activeRooms.slice(first, first + 16).flatMap((roomId) => {
        const listeners = subscriptions.get(roomId)
        return listeners ? [{ roomId, listeners: new Map(listeners) }] : []
      })
      if (!page.length) continue
      try {
        const changes = await readRoomOutbox(page.map(({ roomId, listeners }) => ({
          roomId,
          seq: Math.min(...[...listeners.values()].map((sub) => sub.seq)),
          userIds: [...new Set([...listeners.values()].map((sub) => sub.userId))],
        })))
        for (const { roomId, roomExists, members, events } of changes) {
          const selected = page.find((entry) => entry.roomId === roomId)?.listeners
          for (const socket of subscribersOf(roomId)) {
            const subscription = subscriptions.get(roomId)?.get(socket)
            if (!subscription || subscription !== selected?.get(socket)) continue
            if (!members.has(subscription.userId)) {
              unsubscribeGatewaySocket(socket, roomId)
              sendFrame(socket, JSON.stringify({
                type: 'room:error', roomId, error: 'not a room member',
                removedReason: roomExists ? 'kicked' : 'dissolved',
              }))
              continue
            }
            for (const event of events) {
              if (event.seq <= subscription.seq) continue
              sendFrame(socket, JSON.stringify({
                type: 'room:event', roomId, seq: event.seq, eventType: event.type, payload: event.payload,
              }))
              subscription.seq = event.seq
            }
          }
        }
      } catch (error) {
        logger.warn('Gateway room fanout unavailable', { error: errorMessage(error) })
      }
    }
    await delay(75, undefined, { signal }).catch(() => {})
  }
}

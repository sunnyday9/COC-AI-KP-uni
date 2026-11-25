import { setTimeout as delay } from 'node:timers/promises'
import { routeSocketCommand } from '../services/roomCommands.js'
import { readRoomOutbox, ROOM_EVENT_WINDOW } from '../services/roomService.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import {
  gatewayRoomIds, gatewaySubscribers, reserveGatewaySubscription, unsubscribeGatewaySocket, type RoomSubscriber,
} from './roomLedger.js'
import { markTransportReset, sendFrame } from './sendFrame.js'

const MAX_REPLAY_BYTES = 512 * 1024

type OutboxEvent = Awaited<ReturnType<typeof readRoomOutbox>>[number]['events'][number]

function eventFrame(roomId: string, { seq, type, payload }: OutboxEvent): string {
  return JSON.stringify({ type: 'room:event', roomId, seq, eventType: type, payload })
}

function buildReplay(roomId: string, cursor: number, highWater: number | null, events: OutboxEvent[]): string[] | null {
  if (highWater === null || cursor > highWater || highWater - cursor > ROOM_EVENT_WINDOW) return null
  const frames: string[] = []
  let bytes = 0
  let seq = cursor
  for (const event of events) {
    if (event.seq <= seq) continue
    if (event.seq !== seq + 1 || event.seq > highWater) return null
    const frame = eventFrame(roomId, event)
    bytes += Buffer.byteLength(frame)
    if (bytes > MAX_REPLAY_BYTES) return null
    frames.push(frame)
    seq = event.seq
  }
  return seq === highWater ? frames : null
}

export async function resumeGatewaySocket(
  socket: RoomSubscriber, roomId: string, userId: number, lastSeq: number, signal?: AbortSignal,
): Promise<void> {
  const subscription = reserveGatewaySubscription(socket, roomId, userId)
  const send = (frame: unknown) => sendFrame(socket, JSON.stringify(frame))
  if (!subscription) {
    send({ type: 'room:error', roomId, error: 'Room subscription limit reached.' })
    return
  }

  const current = () => socket.readyState === 1 && subscription === gatewaySubscribers(roomId)?.get(socket)
  try {
    if (lastSeq > 0) {
      const [result] = await readRoomOutbox([{ roomId, userIds: [userId], seq: lastSeq }], ROOM_EVENT_WINDOW)
      if (!current()) return
      if (!result.members.has(userId)) {
        send({ type: 'room:error', roomId, error: 'not a room member' })
        return
      }
      const replay = buildReplay(roomId, lastSeq, result.highWater, result.events)
      if (replay && result.highWater !== null) {
        for (const frame of replay) sendFrame(socket, frame)
        send({ type: 'room:sync:done', roomId, seq: result.highWater, actionReceipts: true })
        subscription.seq = result.highWater
        return
      }
    }
    const result = await routeSocketCommand('snapshot', userId, roomId, [], signal)
    if (!current()) return
    if (!result) {
      send({ type: 'room:error', roomId, error: 'not a room member' })
      return
    }
    send({ type: 'room:state', roomId, actionReceipts: true, ...result })
    subscription.seq = result.seq
  } finally {
    if (subscription.seq === null && subscription === gatewaySubscribers(roomId)?.get(socket)) {
      unsubscribeGatewaySocket(socket, roomId)
    }
  }
}

function resetForReplay(socket: RoomSubscriber): void {
  markTransportReset(socket)
  socket.terminate()
}

export async function runGatewayRoomFanout(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const activeRooms = gatewayRoomIds()
    for (let first = 0; first < activeRooms.length && !signal.aborted; first += 16) {
      const page = activeRooms.slice(first, first + 16).flatMap((roomId) => {
        const listeners = new Map(
          [...gatewaySubscribers(roomId) ?? []].filter(([, subscription]) => subscription.seq !== null),
        )
        return listeners.size ? [{ roomId, listeners }] : []
      })
      if (!page.length) continue
      try {
        const changes = await readRoomOutbox(page.map(({ roomId, listeners }) => ({
          roomId,
          seq: Math.min(...[...listeners.values()].map((sub) => sub.seq!)),
          userIds: [...new Set([...listeners.values()].map((sub) => sub.userId))],
        })))
        for (const { roomId, roomExists, highWater, members, events } of changes) {
          const selected = page.find((entry) => entry.roomId === roomId)?.listeners
          for (const [socket, subscription] of selected ?? []) {
            if (subscription.seq === null || subscription !== gatewaySubscribers(roomId)?.get(socket)) continue
            if (!members.has(subscription.userId)) {
              unsubscribeGatewaySocket(socket, roomId)
              sendFrame(socket, JSON.stringify({
                type: 'room:error', roomId, error: 'not a room member',
                removedReason: roomExists ? 'kicked' : 'dissolved',
              }))
              continue
            }
            if (events.length === 0 && highWater !== null && subscription.seq < highWater) {
              resetForReplay(socket)
              continue
            }
            for (const event of events) {
              if (event.seq <= subscription.seq) continue
              if (event.seq !== subscription.seq + 1) {
                resetForReplay(socket)
                break
              }
              sendFrame(socket, eventFrame(roomId, event))
              if (socket.readyState !== 1) break
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

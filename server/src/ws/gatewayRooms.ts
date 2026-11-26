import { setTimeout as delay } from 'node:timers/promises'
import { routeSocketCommand } from '../services/roomCommands.js'
import { planCommittedRoomReplay, readRoomOutbox } from '../services/roomService.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import {
  gatewayRoomIds, gatewaySubscribers, reserveGatewaySubscription, unsubscribeGatewaySocket, type RoomSubscriber,
} from './roomLedger.js'
import { activateGatewayPresence, joinGatewayPresence } from './gatewayPresence.js'
import { markTransportReset, sendFrame } from './sendFrame.js'

const MAX_REPLAY_BYTES = 512 * 1024

type OutboxEvent = Awaited<ReturnType<typeof readRoomOutbox>>[number]['events'][number]

function eventFrame(roomId: string, { seq, type, payload }: OutboxEvent): string {
  return JSON.stringify({ type: 'room:event', roomId, seq, eventType: type, payload })
}

function encodeReplay(roomId: string, events: OutboxEvent[]): string[] | null {
  const frames: string[] = []
  let bytes = 0
  for (const event of events) {
    const frame = eventFrame(roomId, event)
    bytes += Buffer.byteLength(frame)
    if (bytes > MAX_REPLAY_BYTES) return null
    frames.push(frame)
  }
  return frames
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
    const present = await joinGatewayPresence(socket, roomId, userId)
    if (!current()) return
    if (!present) {
      send({ type: 'room:error', roomId, error: 'not a room member' })
      return
    }
    if (lastSeq > 0) {
      const replay = await planCommittedRoomReplay(roomId, userId, lastSeq, MAX_REPLAY_BYTES)
      if (!current()) return
      if (replay.kind === 'not-member') {
        send({ type: 'room:error', roomId, error: 'not a room member' })
        return
      }
      if (replay.kind === 'delta') {
        const frames = encodeReplay(roomId, replay.events)
        if (frames) {
          for (const frame of frames) sendFrame(socket, frame)
          send({ type: 'room:sync:done', roomId, seq: replay.seq, actionReceipts: true })
          if (current()) {
            subscription.seq = replay.seq
            activateGatewayPresence(socket, roomId)
          }
          return
        }
      }
    }
    const result = await routeSocketCommand('snapshot', userId, roomId, [], signal)
    if (!current()) return
    if (!result) {
      send({ type: 'room:error', roomId, error: 'not a room member' })
      return
    }
    send({ type: 'room:state', roomId, actionReceipts: true, ...result })
    if (current()) {
      subscription.seq = result.seq
      activateGatewayPresence(socket, roomId)
    }
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

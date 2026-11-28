import { setTimeout as delay } from 'node:timers/promises'
import { planCommittedRoomDelivery } from '../services/roomService.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'
import {
  gatewayRoomIds, gatewaySubscribers, planGatewayResume, reserveGatewaySubscription, unsubscribeGatewaySocket, type RoomSubscriber,
} from './roomLedger.js'
import { confirmGatewayPresence } from './gatewayPresence.js'
import { canSendFrame, markTransportReset, roomEventFrame, sendFrame, writeResumeFrame } from './sendFrame.js'

export async function resumeGatewaySocket(
  socket: RoomSubscriber, roomId: string, userId: number, lastSeq: number, signal?: AbortSignal,
): Promise<void> {
  const previousSeq = gatewaySubscribers(roomId)?.get(socket)?.seq
  const subscription = reserveGatewaySubscription(socket, roomId, userId)
  const send = (frame: unknown) => sendFrame(socket, JSON.stringify(frame))
  if (!subscription) {
    send({ type: 'room:error', roomId, error: 'Room subscription limit reached.' })
    return
  }

  let membershipLost = false
  const reserved = () => subscription === gatewaySubscribers(roomId)?.get(socket)
  const current = () => socket.readyState === 1 && reserved()
  const notMember = () => {
    membershipLost = true
    send({ type: 'room:error', roomId, error: 'not a room member' })
  }
  const finish = async (frame: unknown, seq: number) => {
    const encoded = JSON.stringify(frame)
    if (!current() || !canSendFrame(socket, encoded)) return
    let frameWritten = false
    try {
      const present = await confirmGatewayPresence(
        socket, roomId, userId, current, async () => {
          frameWritten = await writeResumeFrame(socket, encoded)
          return frameWritten
        },
      )
      if (present && reserved()) {
        // An ordinary close can start after the first frame and before presence commits.
        subscription.seq = seq
      } else if (current()) {
        if (frameWritten) resetForReplay(socket)
        else notMember()
      }
    } catch (error) {
      if (frameWritten && current()) resetForReplay(socket)
      throw error
    }
  }
  try {
    const plan = await planGatewayResume(roomId, userId, lastSeq, current, signal)
    if (!plan || !current()) return
    if (plan.kind === 'not-member') {
      notMember()
      return
    }
    for (const frame of plan.frames) sendFrame(socket, frame)
    await finish(plan.terminal, plan.seq)
  } finally {
    if (subscription.seq === null && reserved()) {
      if (previousSeq != null && !membershipLost) subscription.seq = previousSeq
      else unsubscribeGatewaySocket(socket, roomId)
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
        const changes = await planCommittedRoomDelivery(page.map(({ roomId, listeners }) => ({
          roomId,
          seq: Math.min(...[...listeners.values()].map((sub) => sub.seq!)),
          userIds: [...new Set([...listeners.values()].map((sub) => sub.userId))],
        })))
        for (const { roomId, deliveryFor } of changes) {
          const selected = page.find((entry) => entry.roomId === roomId)?.listeners
          for (const [socket, subscription] of selected ?? []) {
            if (subscription.seq === null || subscription !== gatewaySubscribers(roomId)?.get(socket)) continue
            const delivery = deliveryFor(subscription.userId, subscription.seq)
            if (delivery.kind === 'removed') {
              unsubscribeGatewaySocket(socket, roomId)
              sendFrame(socket, JSON.stringify({
                type: 'room:error', roomId, error: 'not a room member',
                removedReason: delivery.reason,
              }))
              continue
            }
            for (const event of delivery.events) {
              sendFrame(socket, JSON.stringify(roomEventFrame(roomId, event.seq, event)))
              if (socket.readyState !== 1) break
              subscription.seq = event.seq
            }
            if (delivery.needsReplay && socket.readyState === 1) resetForReplay(socket)
          }
        }
      } catch (error) {
        logger.warn('Gateway room fanout unavailable', { error: errorMessage(error) })
      }
    }
    await delay(75, undefined, { signal }).catch(() => {})
  }
}

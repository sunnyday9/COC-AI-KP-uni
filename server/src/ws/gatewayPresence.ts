import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { postgresError } from '../db/postgres.js'
import { reapRoomPresence, registerRoomPresence, removeRoomPresence, renewRoomPresence, type RoomPresence } from '../services/roomService.js'
import { CapacityError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { isTransportReset, type FrameRecipient } from './sendFrame.js'

interface GatewayPresence extends RoomPresence {
  ready: Promise<boolean>
  confirmed: boolean
}

const sockets = new WeakMap<FrameRecipient, Map<string, GatewayPresence>>()
const live = new Set<GatewayPresence>()
const pendingRemovals = new Set<Promise<void>>()
const capacity = 4096
let draining = false

export function markGatewayDraining(): void {
  draining = true
}

export async function waitForGatewayPresenceCleanup(): Promise<void> {
  await Promise.all(pendingRemovals)
}

function forget(rooms: Map<string, GatewayPresence>, entry: GatewayPresence): void {
  if (rooms.get(entry.roomId) === entry) rooms.delete(entry.roomId)
  live.delete(entry)
}

export async function confirmGatewayPresence(
  socket: FrameRecipient, roomId: string, userId: number, current: () => boolean, writeResume: () => Promise<boolean>,
): Promise<boolean> {
  const stillCurrent = () => current() && !draining && !isTransportReset(socket)
  if (!stillCurrent()) return false
  const writeWhileServing = async () => {
    if (!stillCurrent()) return false
    const written = await writeResume()
    return written && !draining && !isTransportReset(socket)
  }
  let rooms = sockets.get(socket)
  if (!rooms) {
    rooms = new Map()
    sockets.set(socket, rooms)
  }
  const previous = rooms.get(roomId)
  if (previous) return await previous.ready && await writeWhileServing()
  if (live.size + pendingRemovals.size >= capacity) throw new CapacityError('Room presence capacity reached. Retry joining.')
  const socketRooms = rooms
  const entry: GatewayPresence = {
    roomId, userId, subscriptionId: randomUUID(), ready: Promise.resolve(false), confirmed: false,
  }
  live.add(entry)
  rooms.set(roomId, entry)
  entry.ready = registerRoomPresence(roomId, userId, entry.subscriptionId, stillCurrent, writeWhileServing).then((registered) => {
    entry.confirmed = registered
    if (!registered) forget(socketRooms, entry)
    return registered && socketRooms.get(roomId) === entry && !draining
  }).catch((error) => {
    forget(socketRooms, entry)
    throw postgresError(error)
  })
  return entry.ready
}

export function releaseGatewaySocketPresence(socket: FrameRecipient, ordinary: boolean): void {
  for (const roomId of sockets.get(socket)?.keys() ?? []) releaseGatewayPresence(socket, roomId, ordinary)
}

export function releaseGatewayPresence(socket: FrameRecipient, roomId: string, ordinary = false): void {
  const rooms = sockets.get(socket)
  const entry = rooms?.get(roomId)
  if (!rooms || !entry) return
  // Drain can begin while registration or the removal transaction is pending.
  const ordinaryDisconnect = ordinary && !draining
  forget(rooms, entry)
  const removal = entry.ready.catch(() => false)
    .then(() => removeRoomPresence(entry, entry.confirmed && ordinaryDisconnect))
    .catch((error) => logger.warn('Gateway presence cleanup failed', { roomId, error: postgresError(error).message }))
    .finally(() => pendingRemovals.delete(removal))
  pendingRemovals.add(removal)
}

export async function runGatewayPresence(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const entries = [...live].filter((entry) => entry.confirmed)
      const renewed = entries.length ? await renewRoomPresence(entries) : new Set<string>()
      for (const entry of entries) {
        if (renewed.has(entry.subscriptionId) || !live.has(entry)) continue
        // Another gateway may have pruned a very old lease after a storage outage.
        await registerRoomPresence(entry.roomId, entry.userId, entry.subscriptionId, () => live.has(entry) && !draining)
        if (!live.has(entry)) await removeRoomPresence(entry, false)
      }
      await reapRoomPresence()
    } catch (error) {
      logger.warn('Gateway presence heartbeat failed', { error: postgresError(error).message })
    }
    await delay(3_000, undefined, { signal }).catch(() => {})
  }
}

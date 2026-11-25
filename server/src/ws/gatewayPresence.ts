import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { postgresError } from '../db/postgres.js'
import { routeOwnerDisconnect } from '../services/roomCommands.js'
import { reapRoomPresence, registerRoomPresence, removeRoomPresence, renewRoomPresence, type RoomPresence } from '../services/roomPresence.js'
import { logger } from '../utils/logging.js'
import type { FrameRecipient } from './sendFrame.js'

interface GatewayPresence extends RoomPresence {
  ready: Promise<boolean>
  active: boolean
}

const sockets = new WeakMap<FrameRecipient, Map<string, GatewayPresence>>()
const live = new Set<GatewayPresence>()
const capacity = 4096
let draining = false

export function markGatewayDraining(): void {
  draining = true
}

function forget(rooms: Map<string, GatewayPresence>, entry: GatewayPresence): void {
  if (rooms.get(entry.roomId) === entry) rooms.delete(entry.roomId)
  live.delete(entry)
}

export function joinGatewayPresence(socket: FrameRecipient, roomId: string, userId: number): Promise<boolean> {
  if (socket.readyState !== 1 || draining) return Promise.resolve(false)
  let rooms = sockets.get(socket)
  if (!rooms) {
    rooms = new Map()
    sockets.set(socket, rooms)
  }
  const previous = rooms.get(roomId)
  if (previous) return previous.ready
  if (live.size >= capacity) return Promise.resolve(false)
  const socketRooms = rooms
  const entry: GatewayPresence = { roomId, userId, subscriptionId: randomUUID(), ready: Promise.resolve(false), active: false }
  live.add(entry)
  rooms.set(roomId, entry)
  entry.ready = registerRoomPresence(roomId, userId, entry.subscriptionId).then((registered) => {
    if (!registered) forget(socketRooms, entry)
    return registered && socketRooms.get(roomId) === entry && !draining
  }).catch((error) => {
    forget(socketRooms, entry)
    throw postgresError(error)
  })
  return entry.ready
}

export function activateGatewayPresence(socket: FrameRecipient, roomId: string): void {
  const entry = sockets.get(socket)?.get(roomId)
  if (entry) entry.active = true
}

export function releaseGatewaySocketPresence(socket: FrameRecipient, ordinary: boolean): void {
  for (const roomId of sockets.get(socket)?.keys() ?? []) releaseGatewayPresence(socket, roomId, ordinary)
}

export function releaseGatewayPresence(socket: FrameRecipient, roomId: string, ordinary = false): void {
  const rooms = sockets.get(socket)
  const entry = rooms?.get(roomId)
  if (!rooms || !entry) return
  forget(rooms, entry)
  void entry.ready.catch(() => false).then(async () => {
    const removedWhileLive = await removeRoomPresence(roomId, entry.userId, entry.subscriptionId)
    if (removedWhileLive && entry.active && ordinary && !draining) await routeOwnerDisconnect(entry.userId, roomId)
  }).catch((error) => logger.warn('Gateway presence cleanup failed', { roomId, error: postgresError(error).message }))
}

export async function runGatewayPresence(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const entries = [...live]
      const renewed = entries.length ? await renewRoomPresence(entries) : new Set<string>()
      for (const entry of entries) {
        if (renewed.has(entry.subscriptionId) || !live.has(entry) || !await entry.ready) continue
        // Another gateway may have pruned a very old lease after a storage outage.
        await registerRoomPresence(entry.roomId, entry.userId, entry.subscriptionId)
        if (!live.has(entry)) await removeRoomPresence(entry.roomId, entry.userId, entry.subscriptionId)
      }
      await reapRoomPresence()
    } catch (error) {
      logger.warn('Gateway presence heartbeat failed', { error: postgresError(error).message })
    }
    await delay(3_000, undefined, { signal }).catch(() => {})
  }
}

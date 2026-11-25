import { ROOM_RUNTIME } from '../config.js'
import type { RoomActionResult } from '../../../shared/types/room.js'
import { RoomRelayUnavailable, sendRoomCommand, withRoomRelayDeadline } from './roomMailbox.js'
import {
  bindRoomCharacter, deleteRoomAsOwner, handleOwnerWsDisconnect, hasRoomCapacity, isRoomMember, joinRoom,
  joinRoomByInviteCode, kickRoomMember, leaveRoomAsMember, resolveRoomInvite,
  setMemberReady, setRoomTurnWindow, startRoom, transferOwnership,
} from './roomService.js'

const missing = { ok: false, reason: 'not-found', message: 'room not found' } as const
const notMember = { status: 'rejected', code: 'not_member', error: '你已不在该房间内。' } as const
const busy = { status: 'busy', code: 'room_busy', error: '房间待处理的操作已满，请稍后重试。' } as const

const commandHandlers = {
  async invite(userId: number, _roomId: string, code: string) {
    return joinRoomByInviteCode(userId, code)
  },
  start: startRoom,
  bind: bindRoomCharacter,
  ready: setMemberReady,
  leave: leaveRoomAsMember,
  async disconnected(userId: number, roomId: string) {
    await handleOwnerWsDisconnect(roomId, userId)
    return true
  },
  kick: kickRoomMember,
  transfer: transferOwnership,
  settings: setRoomTurnWindow,
  delete: deleteRoomAsOwner,
  async snapshot(userId: number, roomId: string) {
    if (!await isRoomMember(roomId, userId)) return null
    if (!hasRoomCapacity(roomId)) throw new RoomRelayUnavailable()
    const room = await joinRoom(roomId, userId, 'user_' + userId)
    if (!room) return null
    const snapshot = room.snapshot()
    const kpTurnPending = snapshot.phase === 'playing' && !snapshot.kpSetupRequired &&
      (snapshot.pendingTurnMessages?.length ?? 0) > 0
    return { snapshot, seq: snapshot.seq, kpTurnPending }
  },
  async chat(userId: number, roomId: string, content: string, actionId?: string): Promise<RoomActionResult> {
    if (!await isRoomMember(roomId, userId)) return notMember
    if (!hasRoomCapacity(roomId)) return busy
    const room = await joinRoom(roomId, userId, 'user_' + userId)
    if (!room) return notMember
    return await room.queuePlayerChat(userId, content, actionId) ?? busy
  },
  async retry(userId: number, roomId: string) {
    if (!await isRoomMember(roomId, userId)) return false
    const room = await joinRoom(roomId, userId, 'user_' + userId)
    return room ? await room.enqueueClientAction(() => room.retryKpTurn(userId)) ?? false : false
  },
}

type RoomCommandName = keyof typeof commandHandlers
type SocketCommand = 'snapshot' | 'chat' | 'retry'
type RestCommand = Exclude<RoomCommandName, SocketCommand | 'disconnected'>

type CommandArgs<K extends RoomCommandName> =
  Parameters<typeof commandHandlers[K]> extends [number, string, ...infer Args] ? Args : never
type CommandResults = {
  [Name in RoomCommandName]: Awaited<ReturnType<typeof commandHandlers[Name]>>
}
type CommandResult<K extends RoomCommandName> = CommandResults[K]

function call<K extends RoomCommandName>(
  name: K, userId: number, roomId: string, args: CommandArgs<K>,
): Promise<CommandResult<K>> {
  const handler = commandHandlers[name] as unknown as (userId: number, roomId: string, ...args: CommandArgs<K>) => Promise<CommandResult<K>>
  return handler(userId, roomId, ...args)
}

async function relay<K extends RoomCommandName>(
  name: K, userId: number, roomId: string, args: CommandArgs<K>, signal: AbortSignal, expiresAt: number,
): Promise<CommandResult<K>> {
  // Mailbox rows are written by authenticated server processes only. The worker
  // rechecks room membership and invokes the same domain handlers as direct mode.
  return await sendRoomCommand(roomId, userId, { name, args }, signal, expiresAt) as CommandResult<K>
}

export async function routeRoomMutation<K extends RestCommand>(
  name: K, userId: number, roomId: string, args: CommandArgs<K>, signal?: AbortSignal,
): Promise<CommandResult<K> | typeof missing> {
  if (ROOM_RUNTIME !== 'gateway') return call(name, userId, roomId, args)
  return withRoomRelayDeadline<CommandResult<K> | typeof missing>(signal, async (pending, expiresAt) => {
    if (!await isRoomMember(roomId, userId)) return missing
    return await relay(name, userId, roomId, args, pending, expiresAt)
  })
}

export async function routeRoomInvite(userId: number, code: string, signal?: AbortSignal) {
  if (ROOM_RUNTIME !== 'gateway') return joinRoomByInviteCode(userId, code)
  return withRoomRelayDeadline(signal, async (pending, expiresAt) => {
    const roomId = await resolveRoomInvite(code)
    return roomId ? relay('invite', userId, roomId, [code], pending, expiresAt) : missing
  })
}

export async function routeSocketCommand<K extends SocketCommand>(
  name: K, userId: number, roomId: string, args: CommandArgs<K>, signal?: AbortSignal,
): Promise<CommandResult<K> | null> {
  return withRoomRelayDeadline<CommandResult<K> | null>(signal, async (pending, expiresAt) => {
    if (!await isRoomMember(roomId, userId)) return null
    return await relay(name, userId, roomId, args, pending, expiresAt)
  })
}

export async function routeOwnerDisconnect(userId: number, roomId: string): Promise<void> {
  await withRoomRelayDeadline(undefined, (signal, expiresAt) =>
    relay('disconnected', userId, roomId, [], signal, expiresAt),
  )
}

export async function executeRoomCommand(roomId: string, userId: number, raw: unknown): Promise<unknown> {
  const command = raw as { name: RoomCommandName; args: CommandArgs<RoomCommandName> }
  if (!Object.hasOwn(commandHandlers, command.name) || !Array.isArray(command.args)) throw new RoomRelayUnavailable()
  if (command.name !== 'snapshot' && command.name !== 'chat' && command.name !== 'retry' && command.name !== 'disconnected') {
    if (command.name === 'invite') {
      const [invite] = command.args
      if (typeof invite !== 'string' || await resolveRoomInvite(invite) !== roomId) return missing
    } else if (!await isRoomMember(roomId, userId)) {
      return missing
    }
    // RoomService holds the actor lease or acquires a temporary lease for a
    // dormant room. REST commands do not use an active room slot.
  }
  return call(command.name, userId, roomId, command.args)
}

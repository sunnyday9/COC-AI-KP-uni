import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { getDb } from '../../db/index.js'
import { signToken } from '../../middleware/auth.js'
import { _clearRoomRegistryForTests, createRoom, getRoomDetail, joinRoomByInviteCode } from '../../services/roomService.js'
import { createWsServer } from '../index.js'
import { hasSubscribers } from '../roomLedger.js'

it.each([
  { cutoff: 'backpressure', hasSuccessor: true },
  { cutoff: 'backpressure', hasSuccessor: false },
  { cutoff: 'message size', hasSuccessor: true },
])('retains the host after a $cutoff cutoff (has successor: $hasSuccessor)', async ({ cutoff, hasSuccessor }) => {
  const ownerId = 8201
  const successorId = 8202
  const addUser = getDb().prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'fixture', 0)",
  )
  addUser.run(ownerId, 'ws_cutoff_host')
  addUser.run(successorId, 'ws_cutoff_successor')
  const { roomId, inviteCode } = await createRoom(ownerId, null)
  if (hasSuccessor) expect(await joinRoomByInviteCode(successorId, inviteCode)).toMatchObject({ ok: true })

  const server = createServer()
  const wss = createWsServer(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo

  async function connectToRoom() {
    const connection = once(wss, 'connection')
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${signToken(ownerId)}`)
    await once(client, 'open')
    const [peer] = await connection
    const joined = once(client, 'message')
    client.send(JSON.stringify({ type: 'room:join', roomId }))
    const [data] = await joined
    expect(JSON.parse(data.toString())).toMatchObject({ type: 'room:state', roomId })
    return { client, peer }
  }

  try {
    const { client, peer } = await connectToRoom()
    expect(hasSubscribers(roomId)).toBe(true)
    const serverClosed = new Promise<void>((resolve) => peer.once('close', resolve))
    const clientClosed = once(client, 'close')
    if (cutoff === 'backpressure') {
      // Set the server-side buffer deterministically without relying on TCP timing.
      Object.defineProperty(peer, 'bufferedAmount', { value: 2 * 1024 * 1024 })
    }
    const content = cutoff === 'message size' ? 'x'.repeat(128 * 1024) : 'We wait.'
    client.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content } } }))
    const [[code]] = await Promise.all([clientClosed, serverClosed])
    expect(code).toBe(cutoff === 'message size' ? 1009 : 1006)

    expect(hasSubscribers(roomId)).toBe(false)
    expect(await getRoomDetail(ownerId, roomId)).toMatchObject({ ok: true, detail: { ownerId } })

    const rejoined = await connectToRoom()
    const closed = Promise.all([once(rejoined.client, 'close'), once(rejoined.peer, 'close')])
    rejoined.client.close()
    await closed
    expect(hasSubscribers(roomId)).toBe(false)
    if (hasSuccessor) {
      expect(await getRoomDetail(successorId, roomId)).toMatchObject({ ok: true, detail: { ownerId: successorId } })
    } else {
      expect(await getRoomDetail(ownerId, roomId)).toMatchObject({ ok: false, reason: 'not-found' })
    }
  } finally {
    for (const peer of wss.clients) peer.terminate()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    _clearRoomRegistryForTests()
  }
})

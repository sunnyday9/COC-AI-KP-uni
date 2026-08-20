/**
 * roomStore unit tests (Phase B3/C1) — event-driven view model.
 *
 * Driven through the uni stub (no real network): stubUni provides MockSocket
 * for WS frames; REST endpoints (roomDetail/me) are served by requestResponder.
 *
 * Module isolation: the bridge singleton + WSService + the module-level
 * frame-wiring flag live in module scope, so every test reloads the platform
 * and roomStore modules via vi.resetModules() to get fresh instances.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { stubUni, type UniMockState } from '../../platform/__tests__/uniMock'
import { useRoomStore } from '../roomStore'

type RoomStore = ReturnType<typeof useRoomStore>

describe('roomStore', () => {
  let state: UniMockState
  let store: RoomStore

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const s = stubUni()
    state = s.state
    state.requestResponder = ({ url }) => {
      if (url.includes('/api/rooms/') && !url.endsWith('/rooms')) {
        return { statusCode: 200, data: { roomId: 'room_x', inviteCode: 'ABC123', storyId: null, phase: 'lobby', ownerId: 1, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: null }], state: {}, createdAt: 1 } }
      }
      if (url.includes('/api/auth/me')) {
        return { statusCode: 200, data: { user: { id: '1', username: 'alice' } } }
      }
      return { statusCode: 200, data: { ok: true } }
    }
    setActivePinia(createPinia())
    const platform = await import('../../platform')
    platform.setToken('test-token')
    const roomModule = await import('../roomStore')
    store = roomModule.useRoomStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function openSocket(): void {
    const sock = state.sockets[0]
    expect(sock).toBeDefined()
    sock.emitOpen()
  }

  function emitFrame(frame: unknown): void {
    state.sockets[0].emitMessage(frame)
  }

  function sentFrames(): Record<string, unknown>[] {
    return state.sockets[0].sent.map((f) => JSON.parse(f) as Record<string, unknown>)
  }

  const SNAP0 = {
    seq: 0,
    phase: 'lobby',
    storyId: null,
    messages: [],
    characters: {},
    clues: [],
    scene: null,
    ending: null,
    turnWindowMs: 5000,
    updatedAt: 1,
  }

  async function joinAndSync(): Promise<void> {
    const p = store.joinRoom('room_x')
    openSocket()
    await p
    emitFrame({ type: 'room:state', roomId: 'room_x', seq: 0, snapshot: SNAP0 })
  }

  it('joins a room: connects WS, sends room:join, applies full snapshot', async () => {
    const p = store.joinRoom('room_x')
    expect(store.connectionState).toBe('joining')
    openSocket()
    await p
    expect(store.connectionState).toBe('joining') // still waiting for room:state
    expect(store.isSyncing).toBe(true)

    // Server answers with the full snapshot
    emitFrame({
      type: 'room:state',
      roomId: 'room_x',
      seq: 5,
      snapshot: {
        ...SNAP0,
        seq: 5,
        phase: 'playing',
        storyId: 'story_1',
        messages: [{ id: 'm1', timestamp: 1, role: 'kp', content: 'welcome' }],
        clues: [{ id: 'c1', description: '铜钥匙' }],
        scene: '旧图书馆',
      },
    })
    expect(store.connectionState).toBe('joined')
    expect(store.isSyncing).toBe(false)
    expect(store.lastSeq).toBe(5)
    expect(store.phase).toBe('playing')
    expect(store.storyId).toBe('story_1')
    expect(store.messages).toHaveLength(1)
    expect(store.clues[0].description).toBe('铜钥匙')
    expect(store.scene).toBe('旧图书馆')
    expect(store.isOwner).toBe(true) // me().id=1 == ownerId=1
    expect(store.inviteCode).toBe('ABC123')

    // join frame actually sent on the socket
    expect(sentFrames().some((f) => f.type === 'room:join' && f.roomId === 'room_x')).toBe(true)
  })

  it('applies incremental events in seq order and drops duplicates', async () => {
    await joinAndSync()

    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { pendingId: 'm1', author: { userId: 2, roleName: 'bob' }, content: 'hello', kind: 'player' } })
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'state_patch', payload: { path: 'scene', value: '地下室' } })
    // duplicate seq=1 — must be ignored
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { pendingId: 'm1', author: { userId: 2, roleName: 'bob' }, content: 'hello', kind: 'player' } })

    expect(store.lastSeq).toBe(2)
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].content).toBe('hello')
    expect(store.scene).toBe('地下室')
  })

  it('applies characters state_patch by merging', async () => {
    await joinAndSync()
    emitFrame({ type: 'room:state', roomId: 'room_x', seq: 0, snapshot: { ...SNAP0, characters: { char_a: { derived: { hp: 10 } } } } })

    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'state_patch', payload: { path: 'characters.char_a', value: { derived: { hp: 8 } } } })
    expect((store.characters.char_a as { derived: { hp: number } }).derived.hp).toBe(8)
    expect(Object.keys(store.characters.char_a as object)).toEqual(['derived'])
  })

  it('handles dice_result by appending a system message', async () => {
    await joinAndSync()
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 3, eventType: 'dice_result', payload: { rolls: [12], expr: '1d20', displayText: '侦查: 1d20 → 12' } })
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].role).toBe('system')
    expect(store.messages[0].content).toContain('12')
  })

  it('room_meta updates phase and members', async () => {
    await joinAndSync()
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 4, eventType: 'room_meta', payload: { phase: 'playing', turnWindowMs: 5000, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: null }, { userId: 2, username: 'bob', role: 'member', characterId: null }] } })
    expect(store.phase).toBe('playing')
    expect(store.members).toHaveLength(2)
  })

  it('sendChat sends room:action without optimistic echo', async () => {
    await joinAndSync()
    store.sendChat('  我要调查书架  ')
    expect(store.messages).toHaveLength(0) // no echo
    const action = sentFrames().find((f) => f.type === 'room:action')
    expect(action).toBeDefined()
    expect(action!.roomId).toBe('room_x')
    expect((action!.action as { type: string }).type).toBe('chat')
    expect(((action!.action as { payload: { content: string } }).payload).content).toBe('我要调查书架')
  })

  it('resync requests delta with lastSeq watermark', async () => {
    await joinAndSync()
    emitFrame({ type: 'room:state', roomId: 'room_x', seq: 7, snapshot: { ...SNAP0, seq: 7 } })
    store.resync()
    const sync = sentFrames().find((f) => f.type === 'room:sync')
    expect(sync).toBeDefined()
    expect(sync!.lastSeq).toBe(7)
    expect(store.isSyncing).toBe(true)
  })

  it('leaveRoom clears state and sends room:leave', async () => {
    await joinAndSync()
    store.sendChat('hi')

    store.leaveRoom()
    expect(store.roomId).toBeNull()
    expect(store.connectionState).toBe('idle')
    expect(store.messages).toHaveLength(0)
    expect(sentFrames().some((f) => f.type === 'room:leave')).toBe(true)
  })

  it('room:error frame surfaces the error and drops the joining state', async () => {
    const p = store.joinRoom('room_x')
    openSocket()
    await p
    emitFrame({ type: 'room:error', roomId: 'room_x', error: 'not a room member' })
    expect(store.connectionState).toBe('error')
    expect(store.errorMessage).toBe('not a room member')
    expect(store.isSyncing).toBe(false)
  })

  it('ignores frames for a room the client has left', async () => {
    await joinAndSync()
    store.leaveRoom()

    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { pendingId: 'm1', author: { userId: 2, roleName: 'bob' }, content: 'late', kind: 'player' } })
    expect(store.messages).toHaveLength(0)
    expect(store.roomId).toBeNull()
  })
})

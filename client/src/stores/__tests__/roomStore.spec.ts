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

  /** 以成员身份加入（REST 详情 ownerId=2，我=1 是 member）——治理场景夹具。 */
  async function joinAndSyncAsMember(): Promise<void> {
    state.requestResponder = ({ url }) => {
      if (url.includes('/api/rooms/') && !url.endsWith('/rooms')) {
        return { statusCode: 200, data: { roomId: 'room_x', inviteCode: 'ABC123', storyId: null, phase: 'lobby', ownerId: 2, members: [{ userId: 1, username: 'alice', role: 'member', characterId: null }, { userId: 2, username: 'bob', role: 'owner', characterId: null }], state: {}, createdAt: 1 } }
      }
      if (url.includes('/api/auth/me')) {
        return { statusCode: 200, data: { user: { id: '1', username: 'alice' } } }
      }
      return { statusCode: 200, data: { ok: true } }
    }
    await joinAndSync()
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

    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { message: { id: 'm1', timestamp: 1720000000000, role: 'player', playerName: 'bob', content: 'hello' }, author: { userId: 2, roleName: 'bob' } } })
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'state_patch', payload: { path: 'scene', value: '地下室' } })
    // duplicate seq=1 — must be ignored
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { message: { id: 'm1', timestamp: 1720000000000, role: 'player', playerName: 'bob', content: 'hello' }, author: { userId: 2, roleName: 'bob' } } })

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

  it('room_meta 成员资格自检：成员列表不再含自己 → removedReason=kicked（被踢感知）', async () => {
    await joinAndSyncAsMember()
    expect(store.removedReason).toBeNull()
    expect(store.isOwner).toBe(false)
    // 房主把我（1）移出：room_meta 成员列表只剩 owner（2）→ kicked
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'room_meta', payload: { phase: 'lobby', turnWindowMs: 5000, members: [{ userId: 2, username: 'bob', role: 'owner', characterId: null }] } })
    expect(store.removedReason).toBe('kicked')
  })

  it('room_meta 转让：本人成为 owner → promotedNotice 一次 + isOwner 翻转为 true', async () => {
    await joinAndSyncAsMember()
    // owner（2）把房主转让给我（1）：role member → owner → 一次性提示 + isOwner 翻转
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'room_meta', payload: { phase: 'lobby', turnWindowMs: 5000, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: null }, { userId: 2, username: 'bob', role: 'member', characterId: null }] } })
    expect(store.promotedNotice).toBe(true)
    expect(store.isOwner).toBe(true)
    // 后续 room_meta（成员状态变化）不再重复提示
    store.promotedNotice = false
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'room_meta', payload: { phase: 'lobby', turnWindowMs: 5000, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: null, ready: false }, { userId: 2, username: 'bob', role: 'member', characterId: null, ready: true }] } })
    expect(store.promotedNotice).toBe(false)
  })

  it('selfReady 只反映非房主成员的就绪状态（owner 无 ready 语义）', async () => {
    await joinAndSyncAsMember()
    // 我是 member 且未就绪
    expect(store.selfReady).toBe(false)
    // 就绪 → true
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'room_meta', payload: { phase: 'lobby', turnWindowMs: 5000, members: [{ userId: 1, username: 'alice', role: 'member', characterId: null, ready: true }, { userId: 2, username: 'bob', role: 'owner', characterId: null, ready: false }] } })
    expect(store.selfReady).toBe(true)
    // 被转让成 owner → 无 ready 语义（服务端 owner 行 ready 恒 0）
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'room_meta', payload: { phase: 'lobby', turnWindowMs: 5000, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: null, ready: false }, { userId: 2, username: 'bob', role: 'member', characterId: null, ready: false }] } })
    expect(store.selfReady).toBe(false)
  })

  it('治理动作 REST：setReady / leaveAndClear / kickMember / transferOwner 走对应端点', async () => {
    await joinAndSync()
    await store.setReady(true)
    const readyReq = state.requests.find((r) => r.url.includes('/ready'))
    expect(readyReq).toBeDefined()
    expect(readyReq!.data).toEqual({ ready: true })

    await store.kickMember(2)
    expect(state.requests.some((r) => r.url.includes('/members/2') && r.method === 'DELETE')).toBe(true)

    await store.transferOwner(2)
    const transferReq = state.requests.find((r) => r.url.includes('/transfer'))
    expect(transferReq).toBeDefined()
    expect(transferReq!.data).toEqual({ userId: 2 })

    // leaveAndClear：REST leave + 本地清理（room:leave 也发）
    await store.leaveAndClear()
    expect(state.requests.some((r) => r.url.includes('/leave') && r.method === 'POST')).toBe(true)
    expect(store.roomId).toBeNull()
    expect(store.removedReason).toBeNull() // 主动离开不置被移出标记
    expect(store.promotedNotice).toBe(false)
  })

  it('sendChat appends an optimistic pending message and sends room:action (ADR-0002)', async () => {
    await joinAndSync()
    store.sendChat('  我要调查书架  ')
    // 唯一乐观面：自己的消息立即显示（pending 标记）+ KP 推进中
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].pending).toBe(true)
    expect(store.messages[0].content).toBe('我要调查书架')
    expect(store.awaitingKp).toBe(true)
    const action = sentFrames().find((f) => f.type === 'room:action')
    expect(action).toBeDefined()
    expect(action!.roomId).toBe('room_x')
    expect((action!.action as { type: string }).type).toBe('chat')
    expect(((action!.action as { payload: { content: string } }).payload).content).toBe('我要调查书架')
  })

  it('server echo of my own message aligns the optimistic entry and KP reply clears awaitingKp', async () => {
    await joinAndSync()
    store.sendChat('我要调查书架')
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].pending).toBe(true)

    // 我自己的 echo 到达（author.userId = selfUserId 1）→ pending 移除，服务端权威消息替换
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { message: { id: 'm_own', timestamp: 1720000000000, role: 'player', playerName: 'alice', content: '我要调查书架' }, author: { userId: 1, roleName: 'alice' } } })
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].id).toBe('m_own')
    expect(store.messages[0].pending).toBeUndefined()

    // KP 回复到达 → 推进中清位
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'message_appended', payload: { message: { id: 'm_kp', timestamp: 1720000000001, role: 'kp', content: '你发现…' }, author: { userId: 1, roleName: 'KP' } } })
    expect(store.awaitingKp).toBe(false)
    expect(store.messages).toHaveLength(2)
  })

  it('selfCharacterSheet resolves my bound character from state_patch', async () => {
    await joinAndSync()
    expect(store.selfCharacterSheet).toBeNull() // 未绑定
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'state_patch', payload: { path: 'characters.char_a', value: { playerName: 'alice', derived: { hp: 10 } } } })
    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 2, eventType: 'room_meta', payload: { phase: 'playing', turnWindowMs: 0, members: [{ userId: 1, username: 'alice', role: 'owner', characterId: 'char_a' }] } })
    expect(store.selfCharacterSheet).not.toBeNull()
    expect((store.selfCharacterSheet as { playerName: string }).playerName).toBe('alice')
    expect(store.selfName).toBe('alice')
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

    emitFrame({ type: 'room:event', roomId: 'room_x', seq: 1, eventType: 'message_appended', payload: { message: { id: 'm1', timestamp: 1720000000000, role: 'player', playerName: 'bob', content: 'late' }, author: { userId: 2, roleName: 'bob' } } })
    expect(store.messages).toHaveLength(0)
    expect(store.roomId).toBeNull()
  })
})

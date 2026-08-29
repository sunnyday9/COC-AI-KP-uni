/**
 * RoomLedger（房间订阅簿）表驱动测试（架构评审候选 4 / D-33）。
 * 真实 RoomService 实例（纯内存）+ 假 socket（记录 send 的帧）；
 * 测试环境的每 worker 独立临时 DB（test/setup.ts）供成员资格查询。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSubscriber } from '../roomLedger.js'
import {
  cleanupSocket,
  ensureFanout,
  planAction,
  planJoin,
  planSync,
  subscribeSocket,
  subscribersOf,
  unsubscribeSocket,
} from '../roomLedger.js'
import { _clearRoomRegistryForTests, getRoom, type RoomService } from '../../services/roomService.js'
import * as roomStorage from '../../services/roomStorage.js'
import { getDb } from '../../db/index.js'

const suite = `ledger_${Date.now()}`

/** 记录 send 帧的假 socket。 */
function makeFakeSocket(readyState = 1): RoomSubscriber & { sent: string[] } {
  return {
    readyState,
    sent: [],
    send(frame: string) { this.sent.push(frame) },
  }
}

let ownerId: number

beforeEach(() => {
  _clearRoomRegistryForTests()
  // 种子用户 + 房间 + owner 成员（成员资格查询用）
  ownerId = 9100 + (Date.now() % 100)
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`)
    .run(ownerId, `ledger_owner_${ownerId}`, Date.now())
})

afterEach(() => {
  _clearRoomRegistryForTests()
})

function seedRoom(tag: string): string {
  const roomId = `${suite}_${tag}`
  roomStorage.insertRoom(roomId, ownerId, `L${tag}`.padEnd(6, 'X'), null)
  roomStorage.insertMember(roomId, ownerId, 'owner')
  return roomId
}

describe('RoomLedger 订阅簿', () => {
  it('planJoin：非成员拒绝；成员通过并 materialize 实例', () => {
    const roomId = seedRoom('join')
    const outsider = ownerId + 500
    expect(planJoin(roomId, outsider, 'outsider').ok).toBe(false)
    const plan = planJoin(roomId, ownerId, 'owner')
    expect(plan.ok).toBe(true)
    expect(getRoom(roomId)).not.toBeNull()
  })

  it('订阅注册表：重复 subscribeSocket 幂等；unsubscribe 清理；cleanupSocket 全清', () => {
    const roomId = seedRoom('reg')
    const a = makeFakeSocket()
    const b = makeFakeSocket()
    subscribeSocket(a, roomId)
    subscribeSocket(a, roomId) // 重复 join 幂等
    subscribeSocket(b, roomId)
    expect(subscribersOf(roomId)).toHaveLength(2)
    unsubscribeSocket(a, roomId)
    expect(subscribersOf(roomId)).toHaveLength(1)
    cleanupSocket(b)
    expect(subscribersOf(roomId)).toHaveLength(0)
  })

  it('ensureFanout 幂等：重复挂接不产生重复回调', () => {
    const roomId = seedRoom('fanout')
    const room = planJoin(roomId, ownerId, 'owner') as { ok: true; room: RoomService }
    expect(room.ok).toBe(true)
    const listener = vi.fn()
    ensureFanout(room.room, listener)
    ensureFanout(room.room, listener) // 重复挂接
    room.room.appendMessage(
      { id: 'm1', timestamp: Date.now(), role: 'player', playerName: 'owner', content: 'x' },
      { userId: ownerId, roleName: 'owner' },
    )
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('planSync：lastSeq=0 / 缺口过大 → 全量；窗口内 → 增量', () => {
    const roomId = seedRoom('sync')
    const room = (planJoin(roomId, ownerId, 'owner') as { ok: true; room: RoomService }).room
    room.appendMessage({ id: 'm1', timestamp: Date.now(), role: 'player', playerName: 'o', content: '一' }, { userId: ownerId, roleName: 'o' })
    room.appendMessage({ id: 'm2', timestamp: Date.now(), role: 'player', playerName: 'o', content: '二' }, { userId: ownerId, roleName: 'o' })
    room.appendMessage({ id: 'm3', timestamp: Date.now(), role: 'player', playerName: 'o', content: '三' }, { userId: ownerId, roleName: 'o' })

    const full0 = planSync(roomId, ownerId, 0)
    expect(full0.kind).toBe('full') // 0 < eventLogStartSeq=1 → 缺口过大兜底
    const fullGap = planSync(roomId, ownerId, 99)
    expect(fullGap.kind).toBe('full')
    const delta = planSync(roomId, ownerId, 1)
    expect(delta.kind).toBe('delta')
    if (delta.kind === 'delta') {
      expect(delta.events.map((e) => e.seq)).toEqual([2, 3])
    }
  })

  it('planSync：非成员与房间不活跃 → error', () => {
    const roomId = seedRoom('sync2')
    expect(planSync(roomId, ownerId + 501, 0).kind).toBe('error')
    const plan = planSync(roomId, ownerId, 0)
    // 成员但实例未 materialize（无 join）→ room not active
    if (plan.kind === 'error') expect(plan.error).toBe('room not active')
    else throw new Error('expected room not active')
  })

  it('planAction：非成员拒绝；成员 + 活跃实例通过', () => {
    const roomId = seedRoom('action')
    expect(planAction(roomId, ownerId + 502).ok).toBe(false)
    expect(planAction(roomId, ownerId).ok).toBe(false) // 成员但未激活
    planJoin(roomId, ownerId, 'owner')
    const plan = planAction(roomId, ownerId)
    expect(plan.ok).toBe(true)
  })

  it('端到端扇出：ensureFanout + 订阅后，appendMessage 推送 room:event 帧（seq 一致）', () => {
    const roomId = seedRoom('e2e')
    const room = (planJoin(roomId, ownerId, 'owner') as { ok: true; room: RoomService }).room
    const socket = makeFakeSocket()
    subscribeSocket(socket, roomId)
    // listener 镜像 adapter 的 broadcast 合约：经 subscribersOf 查注册表 + readyState 守卫
    ensureFanout(room, (event, seq) => {
      for (const s of subscribersOf(roomId)) {
        if (s.readyState === 1) s.send(JSON.stringify({ type: 'room:event', roomId, seq, eventType: event.type, payload: event.payload }))
      }
    })
    room.appendMessage(
      { id: 'kp_1', timestamp: 1720000000000, role: 'kp', content: '检定结果' },
      { userId: ownerId, roleName: 'KP' },
    )
    expect(socket.sent).toHaveLength(1)
    const frame = JSON.parse(socket.sent[0]!) as { type: string; seq: number; eventType: string; payload: { message?: { role: string } } }
    expect(frame.type).toBe('room:event')
    expect(frame.eventType).toBe('message_appended')
    expect(frame.seq).toBe(1)
    expect(frame.payload.message?.role).toBe('kp')
    // 断连清理后不再接收
    cleanupSocket(socket)
    room.appendMessage({ id: 'kp_2', timestamp: Date.now(), role: 'kp', content: '二' }, { userId: ownerId, roleName: 'KP' })
    expect(socket.sent).toHaveLength(1)
  })

  it('断开连接的 socket（readyState≠1）被扇出跳过', () => {
    const roomId = seedRoom('closed')
    const room = (planJoin(roomId, ownerId, 'owner') as { ok: true; room: RoomService }).room
    const closed = makeFakeSocket(3 /* CLOSED */)
    subscribeSocket(closed, roomId)
    ensureFanout(room, (event, seq) => {
      for (const s of subscribersOf(roomId)) {
        if (s.readyState === 1) s.send(JSON.stringify({ seq, eventType: event.type }))
      }
    })
    room.appendMessage({ id: 'm1', timestamp: Date.now(), role: 'player', playerName: 'o', content: 'x' }, { userId: ownerId, roleName: 'o' })
    expect(closed.sent).toHaveLength(0)
  })
})

/**
 * #86 房间 TTL 回收链直测——`reapStaleRooms` / `startRoomReaper` / `isStale`。
 *
 * 票面验收：
 *  1. 只清 stale 房：空闲超 ROOM_TTL_MS（30min，roomService.ts:79，未导出故此处同值硬编码）
 *     的实例被 persistSnapshot 落库 + dispose + 逐出注册表；活房（enqueue 保活，lastActivityAt
 *     在入队时 bump，:218）保留——逐出后 DB 数据完好，可经 getOrCreateRoom 重物化。
 *  2. solo / multi / ended 各形态按实际逻辑覆盖：isStale 只看 lastActivityAt（不看 kind/phase），
 *     三形态都到点逐出；ended 房重物化后仍为 ended（列权威 + #54 自愈）。
 *  3. 错误安全（#86 装配级 catch）：persistSnapshot 落库抛错（better-sqlite3 同步 UPDATE）
 *     不产生 unhandledRejection、不同步抛、dispose/逐出仍在 finally 执行。
 *  4. startRoomReaper 接线行为（fake timers）：周期触发 reap；回调抛错被 interval 的
 *     try/catch 吞掉且 interval 存活；clearInterval 停扫。
 *
 * 时间控制：全部用 fake timers 的 setSystemTime 推进时钟（不触发 constructor 的
 * snapshotTimer——它只 advance 才会跑，避免与被测逻辑互相污染）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 与 roomEndedPhase.spec 同口径：桩掉 KP 回合与知识层 IO（真实链会懒加载
// embedding 模型 → 空 MODELS_DIR 下网络等待拖挂）。
vi.mock('../kpTurnService.js', () => ({
  runKpTurn: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../turnKnowledge.js', () => ({
  assembleTurnKnowledge: vi.fn(async () => ({
    ragContext: '',
    sceneBlock: '',
    verifyBlock: '',
    supplement: '',
    coverage: null,
    storyName: '',
    wireInjectionText: '',
  })),
  buildStoryLookup: vi.fn(() => undefined),
}))
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async () => ''),
}))

import {
  createSoloRoom,
  getOrCreateRoom,
  getRoom,
  reapStaleRooms,
  startRoomReaper,
  _clearRoomRegistryForTests,
} from '../roomService.js'
import * as roomStorage from '../roomStorage.js'
import { getDb } from '../../db/index.js'

/** 与 roomService.ROOM_TTL_MS 同值（private 常量，改动时此处同步）。 */
const TTL_MS = 30 * 60_000
const BASE = Date.parse('2026-01-01T00:00:00Z')

let userIdSeq = 8600
function seedUser(username: string): number {
  const id = ++userIdSeq
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

const validSheet = {
  playerName: '回收员',
  occupationName: '侦探',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 55, sanMax: 55, damageBonus: '0', moveRate: 8 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 60 },
  skills: {},
} as never

async function makeSoloRoom(username: string, storyId: string) {
  const userId = seedUser(username)
  const created = await createSoloRoom(userId, { storyId, name: username, sheet: validSheet })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error('createSoloRoom failed')
  return { userId, roomId: created.roomId }
}

/** 造一行 multi 房（多人形态；governance 路径无需走通，registry 物化即可）。 */
function seedMultiRoom(username: string): { userId: number; roomId: string } {
  const userId = seedUser(username)
  const roomId = `reap_multi_${++userIdSeq}`
  getDb()
    .prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, version, updated_at, created_at)
               VALUES (?, ?, ?, 'story_rm', 'multi', 'lobby', '{}', 0, ?, ?)`)
    .run(roomId, userId, `R${userIdSeq}`, Date.now(), Date.now())
  getDb().prepare(`INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'owner', NULL)`).run(roomId, userId)
  return { userId, roomId }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  // 先清注册表（dispose 里 clearInterval 需在 fake 世界内执行），再还原时钟。
  _clearRoomRegistryForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#86 reapStaleRooms — 只清 stale 房', () => {
  it('超 TTL 空闲的逐出（最终态已落库、可重物化），enqueue 保活的活房保留', async () => {
    const stale = await makeSoloRoom('reaper_stale', 'story_r1')
    const fresh = await makeSoloRoom('reaper_fresh', 'story_r2')
    const staleRoom = getOrCreateRoom(stale.roomId, stale.userId, 'reaper_stale', 'story_r1')
    const freshRoom = getOrCreateRoom(fresh.roomId, fresh.userId, 'reaper_fresh', 'story_r2')
    staleRoom.submitPlayerChat(stale.userId, 'TTL 回收前的最后一句')

    // 推进到 TTL 之外；fresh 房此刻有动作（enqueue 在入队时 bump lastActivityAt）
    vi.setSystemTime(BASE + TTL_MS + 60_000)
    freshRoom.enqueue(() => undefined)

    const versionBefore = getRoomRowVersion(stale.roomId)
    reapStaleRooms()
    // 逐出发生在 persistSnapshot().finally() 微任务里——排空后再断言
    await vi.advanceTimersByTimeAsync(0)

    expect(getRoom(stale.roomId)).toBeNull() // stale 房已逐出
    expect(getRoom(fresh.roomId)).toBe(freshRoom) // 活房原实例保留
    // 逐出前最终态已落库（updateRoomStateSnapshot bump version）
    expect(getRoomRowVersion(stale.roomId)).toBeGreaterThan(versionBefore)
    // 数据无损：重物化拿回消息流（懒激活自愈，getOrCreateRoom 注释 :788-789 依赖此路径）
    const restored = getOrCreateRoom(stale.roomId, stale.userId, 'reaper_stale', 'story_r1')
    expect(restored.getMessages().some((m) => m.content.includes('TTL 回收前'))).toBe(true)
  })

  it('solo / multi / ended 三形态一致逐出：isStale 只看 lastActivityAt，不看 kind/phase', async () => {
    const solo = await makeSoloRoom('reaper_solo', 'story_r3')
    const multi = seedMultiRoom('reaper_multi')
    const ended = await makeSoloRoom('reaper_ended', 'story_r4')
    getOrCreateRoom(solo.roomId, solo.userId, 'reaper_solo', 'story_r3')
    getOrCreateRoom(multi.roomId, multi.userId, 'reaper_multi', 'story_rm')
    const endedRoom = getOrCreateRoom(ended.roomId, ended.userId, 'reaper_ended', 'story_r4')
    endedRoom.setEnding({ outcome: 'victory', title: '落幕', summary: '调查结束。' })

    vi.setSystemTime(BASE + TTL_MS + 60_000)
    reapStaleRooms()
    await vi.advanceTimersByTimeAsync(0) // 逐出在 finally 微任务里，先排空

    expect(getRoom(solo.roomId)).toBeNull()
    expect(getRoom(multi.roomId)).toBeNull()
    expect(getRoom(ended.roomId)).toBeNull()
    // ended 房重物化仍是 ended（列权威），不会复活成进行中
    const restoredEnded = getOrCreateRoom(ended.roomId, ended.userId, 'reaper_ended', 'story_r4')
    expect(restoredEnded.getPhase()).toBe('ended')
  })
})

describe('#86 装配级错误安全 — reap 不打崩进程', () => {
  it('persistSnapshot 落库抛错：不同步抛、无 unhandledRejection、dispose/逐出仍执行', async () => {
    const { userId, roomId } = await makeSoloRoom('reaper_dberr', 'story_r5')
    getOrCreateRoom(roomId, userId, 'reaper_dberr', 'story_r5')
    vi.setSystemTime(BASE + TTL_MS + 60_000)

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    const spy = vi.spyOn(roomStorage, 'updateRoomStateSnapshot').mockImplementation(() => {
      throw new Error('db down')
    })
    try {
      expect(() => reapStaleRooms()).not.toThrow()
      // 排空微任务：拒绝链（persistSnapshot → finally → catch）settle
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).toHaveLength(0)
      // finally 里的 dispose/逐出不受落库失败影响
      expect(getRoom(roomId)).toBeNull()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      spy.mockRestore()
    }
  })

  it('startRoomReaper 周期触发 reap；回调抛错被吞且 interval 存活；clearInterval 停扫', async () => {
    const { userId, roomId } = await makeSoloRoom('reaper_timer', 'story_r6')
    const room = getOrCreateRoom(roomId, userId, 'reaper_timer', 'story_r6')

    const handle = startRoomReaper(1_000)
    // 第一跳：isStale 同步炸——startRoomReaper 的 try/catch 必须兜住，房间不被误清
    const boom = vi.spyOn(room, 'isStale').mockImplementation(() => {
      throw new Error('boom')
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getRoom(roomId)).toBe(room)

    // 第二跳：恢复正常——到点正常 reap
    boom.mockRestore()
    vi.setSystemTime(BASE + TTL_MS + 60_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getRoom(roomId)).toBeNull()

    // 停扫：clearInterval 后新 stale 房不再被回收
    clearInterval(handle)
    const later = await makeSoloRoom('reaper_stopped', 'story_r7')
    getOrCreateRoom(later.roomId, later.userId, 'reaper_stopped', 'story_r7')
    vi.setSystemTime(BASE + 2 * TTL_MS)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getRoom(later.roomId)).not.toBeNull()
  })
})

/** rooms.version 列（updateRoomStateSnapshot 每次 +1，roomStorage.ts:128）。 */
function getRoomRowVersion(roomId: string): number {
  const row = getDb().prepare(`SELECT version FROM rooms WHERE room_id = ?`).get(roomId) as { version: number } | undefined
  return row?.version ?? -1
}

/**
 * Solo 房间领域直测（ADR-0002：单人=单成员房间）——RoomService 领域方法缝，
 * node:sqlite 临时库（test/setup.ts 每 worker 独立 DATA_DIR），唯一 id 隔离用例。
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  createSoloRoom,
  listRoomsForUser,
  listSoloRoomsForUser,
  getRoomDetail,
  getOrCreateRoom,
  _clearRoomRegistryForTests,
} from '../roomService.js'
import { getRoomRow } from '../roomStorage.js'
import { getDb } from '../../db/index.js'

const suite = `solo_${Date.now()}`

let userIdSeq = 9520
function seedUser(username: string): number {
  const id = ++userIdSeq
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

const validSheet = {
  derived: { hp: 10, mp: 8, san: 55, luck: 60, damageBonus: '0', moveRate: 8 },
} as never

afterEach(() => {
  _clearRoomRegistryForTests()
})

describe('createSoloRoom 一体领域动作', () => {
  it('落角色卡 + 建 solo 房 + 绑卡 + start 一步完成', () => {
    const userId = seedUser('solo_alice')
    const result = createSoloRoom(userId, { storyId: 'story_solo_a', name: '艾丽丝', sheet: validSheet })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = getRoomRow(result.roomId)!
    expect(row.kind).toBe('solo')
    expect(row.phase).toBe('playing')
    expect(row.story_id).toBe('story_solo_a')
    expect(JSON.parse(row.state)).toEqual({ turnWindowMs: 0 })

    const owner = getDb().prepare(`SELECT user_id FROM characters WHERE id = ?`).get(result.characterId) as { user_id: number }
    expect(owner.user_id).toBe(userId)

    const member = getDb().prepare(`SELECT role, character_id FROM room_members WHERE room_id = ? AND user_id = ?`).get(result.roomId, userId) as {
      role: string
      character_id: string
    }
    expect(member.role).toBe('owner')
    expect(member.character_id).toBe(result.characterId)
  })

  it('缺 storyId / 缺 name / 缺 sheet → bad-request，不落任何行', () => {
    const userId = seedUser('solo_bob')
    expect(createSoloRoom(userId, { storyId: '', name: 'x', sheet: validSheet }).ok).toBe(false)
    expect(createSoloRoom(userId, { storyId: 's', name: '', sheet: validSheet }).ok).toBe(false)
    expect(createSoloRoom(userId, { storyId: 's', name: 'x', sheet: {} }).ok).toBe(false)
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM rooms r JOIN room_members m ON r.room_id = m.room_id WHERE m.user_id = ? AND r.kind = 'solo'`).get(userId) as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('solo 房间列表可见性', () => {
  it('listRoomsForUser 不含 solo；listSoloRoomsForUser 只列本人未结束 solo', () => {
    const userId = seedUser('solo_carol')
    const otherId = seedUser('solo_dave')
    const solo = createSoloRoom(userId, { storyId: 'story_c', name: '卡罗尔', sheet: validSheet })
    expect(solo.ok).toBe(true)
    // multi 房（同用户）与 ended solo（应被继续游戏排除）
    getDb().prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, version, updated_at, created_at)
                     VALUES (?, ?, 'MULTE1', null, 'multi', 'lobby', '{}', 0, ?, ?)`).run(`${suite}_m1`, userId, Date.now(), Date.now())
    getDb().prepare(`INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')`).run(`${suite}_m1`, userId)
    const endedSolo = createSoloRoom(userId, { storyId: 'story_c2', name: '卡罗尔二', sheet: validSheet })
    if (endedSolo.ok) {
      getDb().prepare(`UPDATE rooms SET phase = 'ended' WHERE room_id = ?`).run(endedSolo.roomId)
    }

    const multiIds = listRoomsForUser(userId).map((r) => r.roomId)
    expect(multiIds).toContain(`${suite}_m1`)
    expect(multiIds).not.toContain(solo.ok ? solo.roomId : '')

    const soloIds = listSoloRoomsForUser(userId).map((r) => r.roomId)
    expect(soloIds).toEqual(solo.ok ? [solo.roomId] : []) // ended 被排除
    expect(listSoloRoomsForUser(otherId)).toEqual([]) // 他人不可见
  })
})

describe('solo 房间 wire 面与 multi 一致', () => {
  it('getRoomDetail 成员可见、joinRoom 可进（懒激活物化）', () => {
    const userId = seedUser('solo_eve')
    const result = createSoloRoom(userId, { storyId: 'story_e', name: '伊芙', sheet: validSheet })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const detail = getRoomDetail(userId, result.roomId)
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.detail.phase).toBe('playing')
      expect(detail.detail.ownerId).toBe(userId)
    }
    const room = getOrCreateRoom(result.roomId, userId, 'solo_eve')
    expect(room).not.toBeNull()
    expect(room!.getPhase()).toBe('playing')
    expect(room!.getTurnWindowMs()).toBe(0)
  })
})

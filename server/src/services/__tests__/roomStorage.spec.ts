/**
 * RoomStorage 直测（架构评审候选 2 / ADR-0001）——持久化原语。
 * 测试环境每个 worker 有独立临时 DB（test/setup.ts），用唯一 roomId 隔离用例。
 */
import { describe, it, expect } from 'vitest'
import {
  insertRoom,
  insertMember,
  isRoomMember,
  memberRole,
  listMembers,
  memberCharacterId,
  bindMemberCharacter,
  boundMemberOf,
  findRoomIdByInviteCode,
  listRoomsForUser,
  getRoomRow,
  updateRoomStart,
  updateRoomStateSnapshot,
  updateRoomStateSettings,
  deleteRoomRows,
} from '../roomStorage.js'
import { getDb } from '../../db/index.js'

const suite = `rs_${Date.now()}`

/** version 列不在 getRoomRow 的选取内，单独查。 */
function versionOf(roomId: string): number {
  return (getDb().prepare(`SELECT version FROM rooms WHERE room_id = ?`).get(roomId) as { version: number }).version
}

function seedRoom(tag: string, ownerId: number, username: string): string {
  const roomId = `${suite}_${tag}`
  insertRoom(roomId, ownerId, `INV${tag}`.slice(0, 6).padEnd(6, 'X'), null)
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(ownerId, username, Date.now())
  insertMember(roomId, ownerId, 'owner')
  return roomId
}

describe('RoomStorage 持久化原语', () => {
  it('insertRoom + insertMember → 详情行与成员可见', () => {
    const roomId = seedRoom('a', 9001, 'rs_alice')
    const row = getRoomRow(roomId)
    expect(row?.owner_id).toBe(9001)
    expect(row?.phase).toBe('lobby')
    expect(JSON.parse(row!.state)).toEqual({})
    expect(isRoomMember(roomId, 9001)).toBe(true)
    expect(isRoomMember(roomId, 9999)).toBe(false)
    expect(memberRole(roomId, 9001)).toBe('owner')
    const members = listMembers(roomId)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ user_id: 9001, role: 'owner', character_id: null })
  })

  it('findRoomIdByInviteCode 唯一定位', () => {
    const roomId = seedRoom('b', 9002, 'rs_bob')
    expect(findRoomIdByInviteCode(`INVb`.padEnd(6, 'X'))).toBe(roomId)
    expect(findRoomIdByInviteCode('ZZZZZZ')).toBeNull()
  })

  it('listRoomsForUser 只列我参与的房间（按 updated_at 倒序）', () => {
    const mine = seedRoom('c', 9003, 'rs_carol')
    const other = seedRoom('d', 9004, 'rs_dave')
    const ids = listRoomsForUser(9003).map((r) => r.roomId)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(other)
  })

  it('updateRoomStart 置 playing + story_id 列', () => {
    const roomId = seedRoom('e', 9005, 'rs_eve')
    updateRoomStart(roomId, 'story.md')
    expect(getRoomRow(roomId)).toMatchObject({ phase: 'playing', story_id: 'story.md' })
  })

  it('快照落库 bump version；设置类小写不 bump', () => {
    const roomId = seedRoom('f', 9006, 'rs_frank')
    const v0 = versionOf(roomId)
    updateRoomStateSnapshot(roomId, JSON.stringify({ turnWindowMs: 5 }))
    const v1 = versionOf(roomId)
    expect(v1).toBe(v0 + 1)
    updateRoomStateSettings(roomId, JSON.stringify({ turnWindowMs: 7 }))
    expect(versionOf(roomId)).toBe(v1)
    expect(JSON.parse(getRoomRow(roomId)!.state)).toEqual({ turnWindowMs: 7 })
  })

  it('绑定角色卡：一人一卡校验 + 归属查询', () => {
    const roomId = seedRoom('g', 9007, 'rs_grace')
    getDb()
      .prepare(`INSERT INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('char_rs_g', 9007, '格蕾丝', '{}', Date.now())
    expect(boundMemberOf(roomId, 'char_rs_g', 9008)).toBeNull()
    bindMemberCharacter(roomId, 9007, 'char_rs_g')
    expect(memberCharacterId(roomId, 9007)).toBe('char_rs_g')
    expect(boundMemberOf(roomId, 'char_rs_g', 9008)).toBe(9007)
    expect(boundMemberOf(roomId, 'char_rs_g', 9007)).toBeNull()
  })

  it('deleteRoomRows 级联清成员', () => {
    const roomId = seedRoom('h', 9008, 'rs_hank')
    insertMember(roomId, 9009, 'member')
    deleteRoomRows(roomId)
    expect(getRoomRow(roomId)).toBeUndefined()
    expect(isRoomMember(roomId, 9008)).toBe(false)
  })
})

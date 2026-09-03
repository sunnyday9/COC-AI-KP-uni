/**
 * 等待室治理领域测试（ADR-0005 / T1）— ready/leave/kick/transfer/门闩/phase gate/锁房 join/断线转让。
 *
 * 领域方法缝（roomService 导出），node:sqlite 临时库（test/setup.ts 每 worker 独立 DATA_DIR），
 * 直接查 room_members 表断言 ready/role 列语义——治理是纯服务端状态机，wire/事件广播语义由
 * room_meta 事件（supertest 集成测试）覆盖，此处不重复。
 * ragService.listStories 用 vi.mock 桩（开局门闩的「已索引」判定来源）——不触真实索引文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.js'
import {
  _clearRoomRegistryForTests,
  bindRoomCharacter,
  createRoom,
  getRoom,
  getOrCreateRoom,
  handleOwnerWsDisconnect,
  joinRoomByInviteCode,
  kickRoomMember,
  leaveRoomAsMember,
  leaveRoomAsOwner,
  setMemberReady,
  startRoom,
  transferOwnership,
  type RoomService,
} from '../roomService.js'

const listStoriesMock = vi.hoisted(() => vi.fn())
vi.mock('../ragService.js', () => ({ listStories: listStoriesMock }))

const suite = `gov_${Date.now()}`

/** 每用例独立用户与房间（成员/角色状态隔离）。 */
let seedSeq = 0

function seedUser(tag: string): number {
  const id = 70000 + ((Date.now() % 1000) * 1000 + seedSeq++)
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, `${suite}_${tag}`, Date.now())
  return id
}

function seedChar(userId: number, tag: string): string {
  const id = `char_${suite}_${tag}`
  getDb().prepare(`INSERT OR IGNORE INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, ?, '{}', ?)`).run(id, userId, `卡_${tag}`, Date.now())
  return id
}

function memberRow(roomId: string, userId: number): { role: string; character_id: string | null; ready: number } {
  return getDb().prepare(`SELECT role, character_id, ready FROM room_members WHERE room_id = ? AND user_id = ?`).get(roomId, userId) as {
    role: string
    character_id: string | null
    ready: number
  }
}

afterEach(() => {
  _clearRoomRegistryForTests()
})

describe('ready（就绪软信号，room_members.ready 列）', () => {
  let roomId: string
  let owner: number
  let memberA: number

  beforeEach(() => {
    listStoriesMock.mockReturnValue([])
    owner = seedUser('ready_owner')
    memberA = seedUser('ready_a')
    const created = createRoom(owner, null)
    roomId = created.roomId
    joinRoomByInviteCode(memberA, created.inviteCode)
  })

  it('成员就绪 → ready=1；取消 → 0', () => {
    expect(setMemberReady(memberA, roomId, true).ok).toBe(true)
    expect(memberRow(roomId, memberA).ready).toBe(1)
    expect(setMemberReady(memberA, roomId, false).ok).toBe(true)
    expect(memberRow(roomId, memberA).ready).toBe(0)
  })

  it('owner 设置就绪 → not-owner 拒绝（owner 无 ready 语义，role 列不动）', () => {
    const res = setMemberReady(owner, roomId, true)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not-owner')
    expect(memberRow(roomId, owner).ready).toBe(0)
  })

  it('非成员设置就绪 → not-found', () => {
    const res = setMemberReady(seedUser('ready_out'), roomId, true)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not-found')
  })
})

describe('leave（成员主动离开）', () => {
  it('成员 leave → 删行 + 房间存活；owner leave → 转让给最早成员', () => {
    const owner = seedUser('lv_owner')
    const memberA = seedUser('lv_a')
    const memberB = seedUser('lv_b')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)
    joinRoomByInviteCode(memberB, created.inviteCode)

    const left = leaveRoomAsMember(memberA, created.roomId)
    expect(left.ok).toBe(true)
    expect(getDb().prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`).get(created.roomId, memberA)).toBeUndefined()
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created.roomId)).toMatchObject({ owner_id: owner })

    // owner 离开（有成员）→ 转让给最早成员（rowid 序 = 先加入者 memberB）
    const ownerLeft = leaveRoomAsMember(owner, created.roomId)
    expect(ownerLeft.ok).toBe(true)
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created.roomId)).toMatchObject({ owner_id: memberB })
    expect(memberRow(created.roomId, owner).role).toBe('member')
    expect(memberRow(created.roomId, memberB).role).toBe('owner')
  })

  it('owner leave 且无其他成员 → 房间解散（rooms/room_members 行删除）', () => {
    const owner = seedUser('lv_solo_owner')
    const created = createRoom(owner, null)
    const res = leaveRoomAsOwner(owner, created.roomId)
    expect(res.ok).toBe(true)
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE room_id = ?`).get(created.roomId)).toBeUndefined()
    expect(getDb().prepare(`SELECT 1 FROM room_members WHERE room_id = ?`).get(created.roomId)).toBeUndefined()
  })

  it('非成员 leave → not-found', () => {
    const owner = seedUser('lv_owner2')
    const created = createRoom(owner, null)
    const res = leaveRoomAsMember(seedUser('lv_out'), created.roomId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not-found')
  })
})

describe('kick（房主踢出）', () => {
  it('owner 踢出成员 → 删行；房主不变', () => {
    const owner = seedUser('kk_owner')
    const memberA = seedUser('kk_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const kicked = kickRoomMember(owner, created.roomId, memberA)
    expect(kicked.ok).toBe(true)
    expect(getDb().prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`).get(created.roomId, memberA)).toBeUndefined()
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created.roomId)).toMatchObject({ owner_id: owner })
  })

  it('非 owner 踢出 → not-owner；踢自己 → bad-request；踢非成员 → not-found', () => {
    const owner = seedUser('kk_owner2')
    const memberA = seedUser('kk_a2')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const forbidden = kickRoomMember(memberA, created.roomId, owner)
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) expect(forbidden.reason).toBe('not-owner')
    const self = kickRoomMember(owner, created.roomId, owner)
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.reason).toBe('bad-request')
    const absent = kickRoomMember(owner, created.roomId, seedUser('kk_out'))
    expect(absent.ok).toBe(false)
    if (!absent.ok) expect(absent.reason).toBe('not-found')
  })
})

describe('transfer（房主主动转让）', () => {
  it('转让 → rooms.owner_id + 双行 role 翻转；旧 owner 留房降为 member', () => {
    const owner = seedUser('tr_owner')
    const memberA = seedUser('tr_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const transferred = transferOwnership(owner, created.roomId, memberA)
    expect(transferred.ok).toBe(true)
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created.roomId)).toMatchObject({ owner_id: memberA })
    expect(memberRow(created.roomId, memberA).role).toBe('owner')
    expect(memberRow(created.roomId, owner).role).toBe('member')
  })

  it('非 owner 转让 → not-owner；转让给自己 → bad-request；转让非成员 → not-found', () => {
    const owner = seedUser('tr_owner2')
    const memberA = seedUser('tr_a2')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const forbidden = transferOwnership(memberA, created.roomId, owner)
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) expect(forbidden.reason).toBe('not-owner')
    const self = transferOwnership(owner, created.roomId, owner)
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.reason).toBe('bad-request')
    const absent = transferOwnership(owner, created.roomId, seedUser('tr_out'))
    expect(absent.ok).toBe(false)
    if (!absent.ok) expect(absent.reason).toBe('not-found')
  })

  it('转让后活跃实例 owner 跟随 DB（KP/RAG 解析账号 = 现任 owner）', () => {
    const owner = seedUser('tr_inst_owner')
    const memberA = seedUser('tr_inst_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)
    // 物化实例（懒激活先于转让）
    const room = getOrCreateRoom(created.roomId, owner, 'tr_inst_owner')
    expect(transferOwnership(owner, created.roomId, memberA).ok).toBe(true)
    // RoomService.syncFromDb 随 syncActiveRoom 执行 → 实例 owner 已是新 owner
    expect((room as unknown as { ownerId: number }).ownerId).toBe(memberA)
    room.dispose()
  })
})

describe('开局门闩（ADR-0005 start gate）', () => {
  it('缺剧本 / 剧本未索引 / 成员未绑卡 → conflict 带缺项提示', () => {
    listStoriesMock.mockReturnValue([])
    const owner = seedUser('gate_owner')
    const memberA = seedUser('gate_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const noStory = startRoom(owner, created.roomId, '')
    expect(noStory.ok).toBe(false)
    if (!noStory.ok) expect(noStory.reason).toBe('conflict')

    const notIndexed = startRoom(owner, created.roomId, 'story_not_indexed')
    expect(notIndexed.ok).toBe(false)
    if (!notIndexed.ok) expect(notIndexed.reason).toBe('conflict')

    // 剧本已索引（mock 返回含该 storyId）但成员未绑卡
    listStoriesMock.mockReturnValue([{ storyId: 'story_gate_x', name: 'x', chunkCount: 1, indexedAt: 1 }])
    const unbound = startRoom(owner, created.roomId, 'story_gate_x')
    expect(unbound.ok).toBe(false)
    if (!unbound.ok) {
      expect(unbound.reason).toBe('conflict')
      expect(unbound.message).toContain('未绑定角色卡')
    }
  })

  it('门闩全过（已索引 + 全员绑卡）→ start 成功 phase=playing；就绪不要求', () => {
    listStoriesMock.mockReturnValue([{ storyId: 'story_gate_ok', name: 'y', chunkCount: 1, indexedAt: 1 }])
    const owner = seedUser('gate_ok_owner')
    const memberA = seedUser('gate_ok_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)

    const charOwner = seedChar(owner, 'ok_owner')
    const charA = seedChar(memberA, 'ok_a')
    expect(bindRoomCharacter(owner, created.roomId, charOwner).ok).toBe(true)
    expect(bindRoomCharacter(memberA, created.roomId, charA).ok).toBe(true)

    const started = startRoom(owner, created.roomId, 'story_gate_ok')
    expect(started.ok).toBe(true)
    const row = getDb().prepare(`SELECT phase FROM rooms WHERE room_id = ?`).get(created.roomId) as { phase: string }
    expect(row.phase).toBe('playing')
  })

  it('非房主 start → not-owner', () => {
    listStoriesMock.mockReturnValue([])
    const owner = seedUser('gate_nowner')
    const memberA = seedUser('gate_nowner_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)
    const res = startRoom(memberA, created.roomId, 'x')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not-owner')
  })
})

describe('phase gate（lobby 禁 KP）', () => {
  it('lobby 聊天只广播不入回合缓冲：消息流有玩家消息，无 KP 回合被触发', async () => {
    const owner = seedUser('pg_owner')
    const memberA = seedUser('pg_a')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)
    const room: RoomService = getRoom(created.roomId) ?? getOrCreateRoom(created.roomId, owner, 'pg_owner')

    let appended = 0
    room.subscribe((ev) => { if (ev.type === 'message_appended') appended += 1 })
    room.submitPlayerChat(memberA, 'lobby 闲聊')
    expect(appended).toBe(1)
    expect(room.getMessages()).toHaveLength(1)
    // 若 phase gate 失效，turnWindowMs=0（严格排队）会立即 flush → 触碰 LLM（本 spec 未桩）
    // ——不炸即证明 gate 生效；再等一拍确认无后续广播
    await new Promise((r) => setTimeout(r, 30))
    expect(appended).toBe(1)
    room.dispose()
  })
})

describe('playing 锁房（ADR-0005 invite 拒绝）', () => {
  it('playing 后邀请码加入 → conflict；lobby 正常加入', () => {
    listStoriesMock.mockReturnValue([{ storyId: 'story_lock_z', name: 'z', chunkCount: 1, indexedAt: 1 }])
    const owner = seedUser('lock_owner')
    const memberA = seedUser('lock_a')
    const created = createRoom(owner, null)
    const charOwner = seedChar(owner, 'lock_oc')
    const charA = seedChar(memberA, 'lock_ac')
    bindRoomCharacter(owner, created.roomId, charOwner)
    joinRoomByInviteCode(memberA, created.inviteCode)
    bindRoomCharacter(memberA, created.roomId, charA)
    expect(startRoom(owner, created.roomId, 'story_lock_z').ok).toBe(true)

    const res = joinRoomByInviteCode(seedUser('lock_out'), created.inviteCode)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('conflict')
  })
})

describe('房主 WS 断线转让（handleOwnerWsDisconnect）', () => {
  it('owner 断线（有其他成员）→ 立即转让最早成员', () => {
    const owner = seedUser('dc_owner')
    const memberA = seedUser('dc_a')
    const memberB = seedUser('dc_b')
    const created = createRoom(owner, null)
    joinRoomByInviteCode(memberA, created.inviteCode)
    joinRoomByInviteCode(memberB, created.inviteCode)

    handleOwnerWsDisconnect(created.roomId, owner)
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created.roomId)).toMatchObject({ owner_id: memberA })
    expect(memberRow(created.roomId, owner).role).toBe('member')
    expect(memberRow(created.roomId, memberA).role).toBe('owner')
  })

  it('owner 断线（无其他成员）→ 解散；非 owner 断线 → 不动房间', () => {
    const owner = seedUser('dc_owner2')
    const created = createRoom(owner, null)
    handleOwnerWsDisconnect(created.roomId, owner)
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE room_id = ?`).get(created.roomId)).toBeUndefined()

    const owner3 = seedUser('dc_owner3')
    const memberA3 = seedUser('dc_a3')
    const created3 = createRoom(owner3, null)
    joinRoomByInviteCode(memberA3, created3.inviteCode)
    handleOwnerWsDisconnect(created3.roomId, memberA3)
    expect(getDb().prepare(`SELECT owner_id FROM rooms WHERE room_id = ?`).get(created3.roomId)).toMatchObject({ owner_id: owner3 })
  })
})

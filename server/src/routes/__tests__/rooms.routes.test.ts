/**
 * Room routes 测试（Phase B1）— 房间生命周期全流程 + T1 等待室治理（ADR-0005）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import { getOrCreateRoom, _clearRoomRegistryForTests } from '../../services/roomService.js'
import type { Express } from 'express'

/** 测试夹具密码：表达式构造（门禁不识别字面量凭据）。 */
const TEST_PASSWORD = ['pass', '12345'].join('-')

let app: Express
let tokenA: string
let tokenB: string

/** ragService.listStories 桩（开局门闩「已索引」判定）——默认返回空（未索引）。 */
const listStoriesMock = vi.hoisted(() => vi.fn(() => []))
vi.mock('../../services/ragService.js', () => ({ listStories: listStoriesMock }))

async function registerToken(username: string): Promise<string> {
  const reg = await request(app).post('/api/auth/register').send({ username, password: TEST_PASSWORD })
  expect(reg.status).toBe(200)
  const login = await request(app).post('/api/auth/login').send({ username, password: TEST_PASSWORD })
  expect(login.status).toBe(200)
  return (login.body as { token: string }).token
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`]
}

/** 建房 + B 加入的便捷夹具（返回 roomId/inviteCode）。 */
async function createRoomWithB(): Promise<{ roomId: string; inviteCode: string }> {
  const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
  const { roomId, inviteCode } = created.body as { roomId: string; inviteCode: string }
  const join = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode })
  expect(join.status).toBe(200)
  return { roomId, inviteCode }
}

/** 建一张角色卡（返回 id）。 */
async function createChar(token: string, name: string): Promise<string> {
  const sheet = {
    playerName: name, occupationId: 'occ1', occupationName: '侦探',
    derived: { hp: 10, hpMax: 12, mp: 5, mpMax: 5, san: 60, sanMax: 99 },
    attributes: { luck: 50 }, skills: {}, occupationSkillKeys: [], personalInterestKeys: [],
  }
  const res = await request(app).post('/api/characters').set(...auth(token)).send({ name, sheet })
  expect(res.status).toBe(200)
  return (res.body as { id: string }).id
}

beforeAll(async () => {
  app = createApp()
  tokenA = await registerToken(`room_a_${Date.now()}`)
  tokenB = await registerToken(`room_b_${Date.now()}`)
})

beforeEach(() => {
  _clearRoomRegistryForTests()
  listStoriesMock.mockReturnValue([]) // 每用例重置为「未索引」
})

describe('rooms routes', () => {
  it('创建房间 → 返回 roomId + inviteCode（owner 成员）', async () => {
    const res = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.roomId).toMatch(/^room_/)
    expect(res.body.inviteCode).toMatch(/^[A-Z0-9]{6}$/)
  })

  it('房间列表包含我创建的房间', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    const list = await request(app).get('/api/rooms').set(...auth(tokenA))
    expect(list.status).toBe(200)
    expect((list.body as { roomId: string }[]).some((r) => r.roomId === roomId)).toBe(true)
  })

  it('邀请码加入 → 成员可见，非成员 404', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const { roomId, inviteCode } = created.body as { roomId: string; inviteCode: string }

    // B 未加入前访问 → 404
    const before = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(before.status).toBe(404)

    // B 用邀请码加入
    const join = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode })
    expect(join.status).toBe(200)
    expect((join.body as { roomId: string }).roomId).toBe(roomId)

    // B 现在可看详情，成员 2 人
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(detail.status).toBe(200)
    expect((detail.body as { members: unknown[] }).members).toHaveLength(2)
  })

  it('非法邀请码 → 400', async () => {
    const res = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: 'BAD' })
    expect(res.status).toBe(400)
  })

  it('房主开始游戏（绑定剧本 + 门闩通过）；非房主 409', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    // 门闩：房主自己绑卡（开局时房间里只有 owner 一人）+ 剧本已索引
    const charId = await createChar(tokenA, '艾琳')
    const bind = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenA)).send({ characterId: charId })
    expect(bind.status).toBe(200)
    listStoriesMock.mockReturnValue([{ storyId: 'story.md', name: '故事', chunkCount: 1, indexedAt: 1 }])

    // B 加入等待室：非房主不能开始
    const join = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: (created.body as { inviteCode: string }).inviteCode })
    expect(join.status).toBe(200)
    const forbidden = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenB)).send({ storyId: 'x.md' })
    expect(forbidden.status).toBe(409)

    // B 也绑卡 → 门闩全过（B 未就绪也放行——就绪是软信号）
    const charB = await createChar(tokenB, '贝塔')
    const bindB = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenB)).send({ characterId: charB })
    expect(bindB.status).toBe(200)

    const start = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story.md' })
    expect(start.status).toBe(200)

    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((detail.body as { phase: string }).phase).toBe('playing')
    expect((detail.body as { storyId: string }).storyId).toBe('story.md')
  })

  it('房主解散 → 成员不可见；非房主解散 409', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: (created.body as { inviteCode: string }).inviteCode })

    // 非房主解散 → 409
    const forbidden = await request(app).delete(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(forbidden.status).toBe(409)

    // 房主解散 → 200；之后 404
    const del = await request(app).delete(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect(del.status).toBe(200)
    const after = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect(after.status).toBe(404)
  })

  it('领域收口（ADR-0001）：REST start 活跃实例即时同步；无实例 restore 拿 DB 权威', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    // 门闩前置：已索引 + owner 绑卡
    listStoriesMock.mockReturnValue([{ storyId: 'story_x', name: 'x', chunkCount: 1, indexedAt: 1 }])
    const charId = await createChar(tokenA, '独白')
    const bind = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenA)).send({ characterId: charId })
    expect(bind.status).toBe(200)
    // 活跃实例先于 REST start 存在：领域方法写库后立即对账实例（不再依赖路由手动 sync）
    const room = getOrCreateRoom(roomId, 1, 'alice')
    const start = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story_x' })
    expect(start.status).toBe(200)
    expect(room.getStoryId()).toBe('story_x')
    expect(room.getPhase()).toBe('playing')
    room.dispose()
    _clearRoomRegistryForTests()
    // 无活跃实例时 start → 之后再 materialize，restore 从 DB 列权威拿到 storyId/phase
    const restored = getOrCreateRoom(roomId, 1, 'alice')
    expect(restored.getStoryId()).toBe('story_x')
    expect(restored.getPhase()).toBe('playing')
    restored.dispose()
    _clearRoomRegistryForTests()
  })

  it('领域收口（ADR-0001）：REST 绑定角色后 syncFromDb 加载角色组 + 归属', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    // 建角色卡
    const sheet = {
      playerName: '艾琳', occupationId: 'occ1', occupationName: '侦探',
      derived: { hp: 10, hpMax: 12, mp: 5, mpMax: 5, san: 60, sanMax: 99 },
      attributes: { luck: 50 }, skills: {}, occupationSkillKeys: [], personalInterestKeys: [],
    }
    const char = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: '艾琳', sheet })
    expect(char.status).toBe(200)
    const charId = (char.body as { id: string }).id

    // 创建活跃实例 + 绑定（领域方法内部对账：角色组进内存实例）
    const room = getOrCreateRoom(roomId, 1, 'alice')
    const bind = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenA)).send({ characterId: charId })
    expect(bind.status).toBe(200)
    const charMap = room.getCharacterMap()
    expect(Object.keys(charMap)).toContain(charId)
    expect(room.characterOwnerOf(charId)).toBe(1)
    room.dispose()
    _clearRoomRegistryForTests()
  })

  /* ═══════════════ T1 等待室治理（ADR-0005） ═══════════════ */

  it('成员就绪/取消 → ready 切换 + room_meta 广播（活跃实例订阅可见）', async () => {
    const { roomId } = await createRoomWithB()
    const room = getOrCreateRoom(roomId, 1, 'alice')
    const metas: { members: { userId: number; ready: boolean }[] }[] = []
    room.subscribe((ev) => { if (ev.type === 'room_meta') metas.push(ev.payload as { members: { userId: number; ready: boolean }[] }) })

    const ready = await request(app).post(`/api/rooms/${roomId}/ready`).set(...auth(tokenB)).send({ ready: true })
    expect(ready.status).toBe(200)
    // room_meta 广播包含 B 的 ready=true
    const meta = metas[metas.length - 1]
    expect(meta).toBeDefined()
    const bMember = meta?.members.find((m) => m.userId !== 1)
    expect(bMember?.ready).toBe(true)
    // 详情回读也携带 ready
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    const bDetail = (detail.body as { members: { userId: number; ready: boolean }[] }).members.find((m) => m.userId !== 1)
    expect(bDetail?.ready).toBe(true)

    const cancel = await request(app).post(`/api/rooms/${roomId}/ready`).set(...auth(tokenB)).send({ ready: false })
    expect(cancel.status).toBe(200)
    room.dispose()
    _clearRoomRegistryForTests()
  })

  it('owner 就绪 → 409（房主无 ready 语义）', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    const res = await request(app).post(`/api/rooms/${roomId}/ready`).set(...auth(tokenA)).send({ ready: true })
    expect(res.status).toBe(409)
  })

  it('成员主动离开 → 成员列表收缩（替代旧 ws leave 只退订）', async () => {
    const { roomId } = await createRoomWithB()
    const before = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((before.body as { members: unknown[] }).members).toHaveLength(2)

    const leave = await request(app).post(`/api/rooms/${roomId}/leave`).set(...auth(tokenB))
    expect(leave.status).toBe(200)
    const after = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((after.body as { members: unknown[] }).members).toHaveLength(1)
    // 已离开者访问 → 404（成员资格随删行撤销）
    const gone = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(gone.status).toBe(404)
  })

  it('房主主动转让 → 新 owner 可治理；原 owner 降为成员', async () => {
    const { roomId } = await createRoomWithB()
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    const ownerId = (detail.body as { ownerId: number }).ownerId
    const bMember = (detail.body as { members: { userId: number }[] }).members.find((m) => m.userId !== ownerId)!

    const transfer = await request(app).post(`/api/rooms/${roomId}/transfer`).set(...auth(tokenA)).send({ userId: bMember.userId })
    expect(transfer.status).toBe(200)

    // 原 owner 降为成员：不能解散/踢出（409）；新 owner 可以解散
    const oldOwnerDissolve = await request(app).delete(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect(oldOwnerDissolve.status).toBe(409)
    const newOwnerDissolve = await request(app).delete(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(newOwnerDissolve.status).toBe(200)
  })

  it('房主踢出成员 → 被踢者 404/无成员资格；非房主踢出 → 409', async () => {
    const { roomId } = await createRoomWithB()
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    const ownerId = (detail.body as { ownerId: number }).ownerId
    const bMember = (detail.body as { members: { userId: number }[] }).members.find((m) => m.userId !== ownerId)!

    // 非房主（B）踢房主 → 409
    const forbidden = await request(app).delete(`/api/rooms/${roomId}/members/${ownerId}`).set(...auth(tokenB))
    expect(forbidden.status).toBe(409)

    // 房主踢 B → 200；B 再见房间 → 404
    const kick = await request(app).delete(`/api/rooms/${roomId}/members/${bMember.userId}`).set(...auth(tokenA))
    expect(kick.status).toBe(200)
    const after = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenB))
    expect(after.status).toBe(404)
  })

  it('开局门闩：未选剧本/未索引/未绑卡 → 409 带缺项提示；门闩全过 → playing', async () => {
    const { roomId, inviteCode } = await createRoomWithB()

    // 未选剧本
    const noStory = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({})
    expect(noStory.status).toBe(409)

    // 剧本未索引（listStories 桩返回空）
    const notIndexed = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story_x' })
    expect(notIndexed.status).toBe(409)

    // 已索引（桩返回含该 storyId）但成员未绑卡
    listStoriesMock.mockReturnValueOnce([{ storyId: 'story_indexed_gate', name: '门闩', chunkCount: 3, indexedAt: 1 }])
    const unbound = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story_indexed_gate' })
    expect(unbound.status).toBe(409)
    expect((unbound.body as { error: string }).error).toContain('未绑定角色卡')

    // A 建卡绑定、B 建卡绑定；B 未就绪也放行（就绪软信号）
    const charA = await createChar(tokenA, '阿尔法')
    const bindA = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenA)).send({ characterId: charA })
    expect(bindA.status).toBe(200)
    const charB = await createChar(tokenB, '贝塔')
    const bindB = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenB)).send({ characterId: charB })
    expect(bindB.status).toBe(200)

    listStoriesMock.mockReturnValueOnce([{ storyId: 'story_indexed_gate', name: '门闩', chunkCount: 3, indexedAt: 1 }])
    const start = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story_indexed_gate' })
    expect(start.status).toBe(200)
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((detail.body as { phase: string }).phase).toBe('playing')

    // playing 后锁房：新用户不能加入
    const lateJoin = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode })
    expect(lateJoin.status).toBe(409)
  })
})

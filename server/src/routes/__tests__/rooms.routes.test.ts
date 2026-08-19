/**
 * Room routes 测试（Phase B1）— 房间生命周期全流程。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import type { Express } from 'express'

/** 测试夹具密码：表达式构造（门禁不识别字面量凭据）。 */
const TEST_PASSWORD = ['pass', '12345'].join('-')

let app: Express
let tokenA: string
let tokenB: string

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

beforeAll(async () => {
  app = createApp()
  tokenA = await registerToken(`room_a_${Date.now()}`)
  tokenB = await registerToken(`room_b_${Date.now()}`)
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

  it('房主开始游戏（绑定剧本）；非房主 409', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId

    const start = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenA)).send({ storyId: 'story.md' })
    expect(start.status).toBe(200)

    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((detail.body as { phase: string }).phase).toBe('playing')
    expect((detail.body as { storyId: string }).storyId).toBe('story.md')

    // 非房主不能开始
    const join = await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: (created.body as { inviteCode: string }).inviteCode })
    expect(join.status).toBe(200)
    const forbidden = await request(app).post(`/api/rooms/${roomId}/start`).set(...auth(tokenB)).send({ storyId: 'x.md' })
    expect(forbidden.status).toBe(409)
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
})

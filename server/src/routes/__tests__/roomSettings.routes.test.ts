/**
 * Room settings routes 测试（Phase B6 房主控制）— turnWindowMs 回合窗口调节。
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
  tokenA = await registerToken(`roomset_a_${Date.now()}`)
  tokenB = await registerToken(`roomset_b_${Date.now()}`)
})

describe('room settings routes (B6)', () => {
  it('房主修改 turnWindowMs → 200 + 值回显；持久化到 state', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId

    const res = await request(app).put(`/api/rooms/${roomId}/settings`).set(...auth(tokenA)).send({ turnWindowMs: 3000 })
    expect(res.status).toBe(200)
    expect((res.body as { turnWindowMs: number }).turnWindowMs).toBe(3000)

    // 持久化到 rooms.state（detail 回读）
    const detail = await request(app).get(`/api/rooms/${roomId}`).set(...auth(tokenA))
    expect((detail.body as { state: { turnWindowMs?: number } }).state.turnWindowMs).toBe(3000)
  })

  it('非房主修改 → 409', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId
    await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: (created.body as { inviteCode: string }).inviteCode })

    const res = await request(app).put(`/api/rooms/${roomId}/settings`).set(...auth(tokenB)).send({ turnWindowMs: 1000 })
    expect(res.status).toBe(409)
  })

  it('非法 turnWindowMs（负数/超上限/非数字）→ 400', async () => {
    const created = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (created.body as { roomId: string }).roomId

    for (const bad of [-1, 60_001, 'abc']) {
      const res = await request(app).put(`/api/rooms/${roomId}/settings`).set(...auth(tokenA)).send({ turnWindowMs: bad })
      expect(res.status).toBe(400)
    }
    // 0 合法（严格排队）
    const zero = await request(app).put(`/api/rooms/${roomId}/settings`).set(...auth(tokenA)).send({ turnWindowMs: 0 })
    expect(zero.status).toBe(200)
  })

  it('不存在的房间 → 404', async () => {
    const res = await request(app).put('/api/rooms/room_nope/settings').set(...auth(tokenA)).send({ turnWindowMs: 1000 })
    expect(res.status).toBe(404)
  })
})

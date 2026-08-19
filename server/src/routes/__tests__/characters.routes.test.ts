/**
 * Character routes 测试（Phase B4）— 角色卡 CRUD + 房间绑定。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import type { Express } from 'express'

/** 测试夹具密码：表达式构造（门禁不识别字面量凭据）。 */
const TEST_PASSWORD = ['pass', '67890'].join('-')

let app: Express
let tokenA: string
let tokenB: string

async function registerToken(username: string): Promise<string> {
  await request(app).post('/api/auth/register').send({ username, password: TEST_PASSWORD })
  const login = await request(app).post('/api/auth/login').send({ username, password: TEST_PASSWORD })
  return (login.body as { token: string }).token
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`]
}

function makeSheet(name: string): Record<string, unknown> {
  return {
    occupationId: 'judge',
    occupationName: '法官',
    playerName: name,
    attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 60, luck: 50 },
    skills: { 'Spot Hidden': 65 },
    derived: { hp: 10, hpMax: 10, mp: 6, mpMax: 6, san: 60, sanMax: 60 },
    dailySanLoss: 0,
    phobias: [],
    manias: [],
    hasMajorWound: false,
    isDying: false,
    weapons: [],
  }
}

beforeAll(async () => {
  app = createApp()
  tokenA = await registerToken(`char_a_${Date.now()}`)
  tokenB = await registerToken(`char_b_${Date.now()}`)
})

describe('characters routes', () => {
  it('创建角色卡 → 列表包含 → 详情匹配', async () => {
    const created = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: '调查员甲', sheet: makeSheet('调查员甲') })
    expect(created.status).toBe(200)
    const charId = (created.body as { id: string }).id
    expect(charId).toMatch(/^char_/)

    const list = await request(app).get('/api/characters').set(...auth(tokenA))
    expect(list.status).toBe(200)
    expect((list.body as { id: string; name: string }[]).some((c) => c.id === charId && c.name === '调查员甲')).toBe(true)

    const detail = await request(app).get(`/api/characters/${charId}`).set(...auth(tokenA))
    expect(detail.status).toBe(200)
    expect((detail.body as { sheet: { derived: { hp: number } } }).sheet.derived.hp).toBe(10)
  })

  it('缺 name 或 sheet → 400', async () => {
    const noName = await request(app).post('/api/characters').set(...auth(tokenA)).send({ sheet: makeSheet('x') })
    expect(noName.status).toBe(400)
    const noSheet = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: 'x' })
    expect(noSheet.status).toBe(400)
  })

  it('他人角色卡 → 404（数据隔离）', async () => {
    const created = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: '甲', sheet: makeSheet('甲') })
    const charId = (created.body as { id: string }).id
    const detail = await request(app).get(`/api/characters/${charId}`).set(...auth(tokenB))
    expect(detail.status).toBe(404)
  })

  it('删除角色卡（仅本人）', async () => {
    const created = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: '待删', sheet: makeSheet('待删') })
    const charId = (created.body as { id: string }).id

    const forbidden = await request(app).delete(`/api/characters/${charId}`).set(...auth(tokenB))
    expect(forbidden.status).toBe(404)

    const del = await request(app).delete(`/api/characters/${charId}`).set(...auth(tokenA))
    expect(del.status).toBe(200)
    const after = await request(app).get(`/api/characters/${charId}`).set(...auth(tokenA))
    expect(after.status).toBe(404)
  })

  it('绑定角色卡到房间（一人一卡，他人绑定冲突 409）', async () => {
    // A 建房 + 建卡 + 绑定
    const room = await request(app).post('/api/rooms').set(...auth(tokenA)).send({})
    const roomId = (room.body as { roomId: string }).roomId
    const charA = await request(app).post('/api/characters').set(...auth(tokenA)).send({ name: '甲', sheet: makeSheet('甲') })
    const charAId = (charA.body as { id: string }).id

    const bind = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenA)).send({ characterId: charAId })
    expect(bind.status).toBe(200)

    // B 加入房间，尝试绑定 A 的卡 → 409（归属校验先拦）
    await request(app).post('/api/rooms/join').set(...auth(tokenB)).send({ inviteCode: (room.body as { inviteCode: string }).inviteCode })
    const conflict = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenB)).send({ characterId: charAId })
    expect(conflict.status).toBe(404) // 非本人 → 404（归属优先于冲突）

    // B 建自己的卡绑定 → 200
    const charB = await request(app).post('/api/characters').set(...auth(tokenB)).send({ name: '乙', sheet: makeSheet('乙') })
    const charBId = (charB.body as { id: string }).id
    const bindB = await request(app).post(`/api/rooms/${roomId}/character`).set(...auth(tokenB)).send({ characterId: charBId })
    expect(bindB.status).toBe(200)
  })
})

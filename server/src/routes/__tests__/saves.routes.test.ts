// @vitest-environment node
/**
 * Save route tests (api-contract §7): DB-backed saves (Task 1 `saves`
 * table), per-user isolation, snapshot validation (object + numeric version).
 */
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

async function registerToken(username: string): Promise<string> {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: 'secret123' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

const SNAPSHOT = {
  version: 1,
  name: '我的存档',
  storyId: 'wudu.md',
  storyName: '雾都疑云',
  storyOverview: '迷雾笼罩的伦敦。',
  currentScene: '图书馆',
  cluesObtained: ['密信'],
  messages: [{ id: 'm1', timestamp: 1, role: 'kp', content: '你走进图书馆。' }],
  kpMemory: ['玩家调查过密信'],
  longTermSummary: '',
  longTermFacts: [],
  playerTurnCount: 3,
  gamePhase: 'play',
  characterSheet: null,
  playerName: '调查员',
  selectedOccupationId: null,
  selectedOccupationName: '',
  sessionId: 'sess-1',
}

describe('saves routes', () => {
  it('requires a token on every endpoint (401 without)', async () => {
    const app = createApp()
    const cases: [string, string][] = [
      ['get', '/api/saves'],
      ['get', '/api/saves/save-1'],
      ['put', '/api/saves/save-1'],
      ['delete', '/api/saves/save-1'],
    ]
    for (const [method, url] of cases) {
      const res = await request(app)[method as 'get'](url)
      expect(res.status).toBe(401)
      expect(res.body.error).toBeDefined()
    }
  })

  it('PUT → GET → list → DELETE closed loop, byte-identical round trip', async () => {
    const token = await registerToken('saves_loop')
    const app = createApp()
    const put = await request(app).put('/api/saves/save-1').set(auth(token)).send(SNAPSHOT)
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })

    const get = await request(app).get('/api/saves/save-1').set(auth(token))
    expect(get.status).toBe(200)
    expect(get.body).toEqual(SNAPSHOT)

    const list = await request(app).get('/api/saves').set(auth(token))
    expect(list.status).toBe(200)
    expect(list.body).toEqual(['save-1'])

    const del = await request(app).delete('/api/saves/save-1').set(auth(token))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    const get2 = await request(app).get('/api/saves/save-1').set(auth(token))
    expect(get2.status).toBe(404)
    expect(get2.body.error).toBeDefined()
  })

  it('overwrite keeps a single row (upsert)', async () => {
    const token = await registerToken('saves_upsert')
    const app = createApp()
    await request(app).put('/api/saves/s-1').set(auth(token)).send(SNAPSHOT).expect(200)
    await request(app).put('/api/saves/s-1').set(auth(token)).send({ ...SNAPSHOT, playerTurnCount: 9 }).expect(200)
    const list = await request(app).get('/api/saves').set(auth(token))
    expect(list.body).toEqual(['s-1'])
    const get = await request(app).get('/api/saves/s-1').set(auth(token))
    expect(get.body.playerTurnCount).toBe(9)
  })

  it('rejects non-object or version-less payloads with 400', async () => {
    const token = await registerToken('saves_bad')
    const app = createApp()
    const bads: unknown[] = ['hello', [1, 2], { name: 'no version' }, { version: 'one' }, null]
    for (const bad of bads) {
      const res = await request(app).put('/api/saves/save-x').set(auth(token)).send(bad as object)
      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
    }
  })

  it('rejects traversal saveIds with 400', async () => {
    const token = await registerToken('saves_ids')
    const app = createApp()
    const trav = await request(app).get('/api/saves/..%2Fescape').set(auth(token))
    expect(trav.status).toBe(400)
    expect(trav.body.error).toBeDefined()
  })

  it('isolates saves between users', async () => {
    const tokenA = await registerToken('saves_iso_a')
    const tokenB = await registerToken('saves_iso_b')
    const app = createApp()
    await request(app).put('/api/saves/shared-save').set(auth(tokenA)).send(SNAPSHOT).expect(200)

    const listB = await request(app).get('/api/saves').set(auth(tokenB))
    expect(listB.body).toHaveLength(0)

    const getB = await request(app).get('/api/saves/shared-save').set(auth(tokenB))
    expect(getB.status).toBe(404)

    const delB = await request(app).delete('/api/saves/shared-save').set(auth(tokenB))
    expect(delB.status).toBe(404)

    const getA = await request(app).get('/api/saves/shared-save').set(auth(tokenA))
    expect(getA.status).toBe(200)
    expect(getA.body.storyName).toBe('雾都疑云')
  })
})

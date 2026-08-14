// @vitest-environment node
/**
 * Script library route tests (api-contract §6): supertest against the real
 * app. PUT is an upsert (saveScript / saveScriptToLibrary); upload validates
 * .json payloads (meta + scenes) and accepts .md.
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

const VALID_SCRIPT = JSON.stringify({ meta: { name: '雾都疑云' }, scenes: [{ id: 's1', title: '开场' }] })

describe('scripts routes', () => {
  it('requires a token on every endpoint (401 without)', async () => {
    const app = createApp()
    const cases: [string, string][] = [
      ['get', '/api/scripts'],
      ['get', '/api/scripts/x.json'],
      ['put', '/api/scripts/x.json'],
      ['post', '/api/scripts/upload'],
      ['delete', '/api/scripts/x.json'],
    ]
    for (const [method, url] of cases) {
      const res = await request(app)[method as 'get'](url)
      expect(res.status).toBe(401)
      expect(res.body.error).toBeDefined()
    }
  })

  it('PUT (save) → list → read → delete closed loop', async () => {
    const token = await registerToken('scripts_loop')
    const app = createApp()
    const put = await request(app).put('/api/scripts/myscript.json').set(auth(token)).send({ content: VALID_SCRIPT })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })

    const list = await request(app).get('/api/scripts').set(auth(token))
    expect(list.status).toBe(200)
    expect(list.body).toContainEqual({ name: 'myscript.json', id: 'myscript.json' })

    const read = await request(app).get('/api/scripts/myscript.json').set(auth(token))
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ name: 'myscript.json', content: VALID_SCRIPT })

    // PUT over existing id updates in place
    const updated = VALID_SCRIPT.replace('开场', '第一章')
    const put2 = await request(app).put('/api/scripts/myscript.json').set(auth(token)).send({ content: updated })
    expect(put2.body).toEqual({ ok: true })
    const read2 = await request(app).get('/api/scripts/myscript.json').set(auth(token))
    expect(read2.body.content).toBe(updated)

    const del = await request(app).delete('/api/scripts/myscript.json').set(auth(token))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    const read3 = await request(app).get('/api/scripts/myscript.json').set(auth(token))
    expect(read3.status).toBe(404)
    expect(read3.body.error).toBeDefined()
  })

  it('PUT requires a string content (400 otherwise)', async () => {
    const token = await registerToken('scripts_badput')
    const app = createApp()
    const res = await request(app).put('/api/scripts/x.json').set(auth(token)).send({ content: 42 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()

    const missing = await request(app).put('/api/scripts/x.json').set(auth(token)).send({})
    expect(missing.status).toBe(400)
  })

  it('upload validates JSON scripts (meta+scenes), accepts .md, rejects others', async () => {
    const token = await registerToken('scripts_upload')
    const app = createApp()
    const ok = await request(app)
      .post('/api/scripts/upload')
      .set(auth(token))
      .attach('file', Buffer.from(VALID_SCRIPT, 'utf-8'), 'lib1.json')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ ok: true, name: 'lib1.json', id: 'lib1.json' })

    const invalid = await request(app)
      .post('/api/scripts/upload')
      .set(auth(token))
      .attach('file', Buffer.from('{"meta":{}}', 'utf-8'), 'lib2.json')
    expect(invalid.status).toBe(200)
    expect(invalid.body).toMatchObject({ ok: false, error: 'Invalid script format' })

    const notJson = await request(app)
      .post('/api/scripts/upload')
      .set(auth(token))
      .attach('file', Buffer.from('not json', 'utf-8'), 'lib3.json')
    // original file:importScript surfaces the raw JSON.parse error message
    expect(notJson.body.ok).toBe(false)
    expect(typeof notJson.body.error).toBe('string')

    const md = await request(app)
      .post('/api/scripts/upload')
      .set(auth(token))
      .attach('file', Buffer.from('# 跑团笔记', 'utf-8'), 'notes.md')
    expect(md.body).toMatchObject({ ok: true, id: 'notes.md' })

    const exe = await request(app)
      .post('/api/scripts/upload')
      .set(auth(token))
      .attach('file', Buffer.from('MZ', 'utf-8'), 'evil.exe')
    expect(exe.body).toMatchObject({ ok: false })
    expect(exe.body.error).toBeDefined()
  })

  it('sanitizes Windows reserved names and rejects traversal ids', async () => {
    const token = await registerToken('scripts_san')
    const app = createApp()
    const con = await request(app).put('/api/scripts/CON.json').set(auth(token)).send({ content: '{}' })
    expect(con.status).toBe(200)
    expect(con.body).toEqual({ ok: true })

    const list = await request(app).get('/api/scripts').set(auth(token))
    expect(list.body).toContainEqual({ name: '_CON.json', id: '_CON.json' })

    const trav = await request(app).get('/api/scripts/..%2Fevil.json').set(auth(token))
    expect(trav.status).toBe(400)
    expect(trav.body.error).toBeDefined()
  })

  it('isolates scripts between users', async () => {
    const tokenA = await registerToken('scripts_iso_a')
    const tokenB = await registerToken('scripts_iso_b')
    const app = createApp()
    await request(app).put('/api/scripts/mine.md').set(auth(tokenA)).send({ content: '# A 的笔记' })

    const listB = await request(app).get('/api/scripts').set(auth(tokenB))
    expect(listB.body).toHaveLength(0)

    const readB = await request(app).get('/api/scripts/mine.md').set(auth(tokenB))
    expect(readB.status).toBe(404)

    const delB = await request(app).delete('/api/scripts/mine.md').set(auth(tokenB))
    expect(delB.status).toBe(404)

    const readA = await request(app).get('/api/scripts/mine.md').set(auth(tokenA))
    expect(readA.status).toBe(200)
    expect(readA.body.content).toBe('# A 的笔记')
  })
})

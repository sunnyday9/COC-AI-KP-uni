// @vitest-environment node
/**
 * Story route tests (api-contract §5): supertest against the real app.
 * Uploads go to the per-worker temp UPLOADS_DIR (test/setup.ts). The PDF
 * case uses an in-memory pdf-lib fixture (no OCR — text layer only).
 */
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import { makePdfWithText } from '../../../test/helpers/pdfFixture.js'
import { TEST_PASSWORD } from '../../testHelpers.js'

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

async function registerToken(username: string): Promise<string> {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: TEST_PASSWORD })
  expect(res.status).toBe(200)
  return res.body.token as string
}

describe('stories routes', () => {
  it('requires a token on every endpoint (401 without)', async () => {
    const app = createApp()
    const cases: [string, string][] = [
      ['get', '/api/stories'],
      ['get', '/api/stories/x.pdf'],
      ['get', '/api/stories/x.pdf/rag'],
      ['post', '/api/stories/upload'],
      ['delete', '/api/stories/x.pdf'],
    ]
    for (const [method, url] of cases) {
      const res = await request(app)[method as 'get'](url)
      expect(res.status).toBe(401)
      expect(res.body.error).toBeDefined()
    }
  })

  it('upload TXT → list contains it → read matches → delete → list empty', async () => {
    const token = await registerToken('stories_txt')
    const app = createApp()
    const content = '雾都疑云\n\n第一章 迷雾\n\n雨夜，伦敦的街头弥漫着雾气。'
    const up = await request(app)
      .post('/api/stories/upload')
      .set(auth(token))
      .attach('file', Buffer.from(content, 'utf-8'), 'wudu.md')
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ ok: true, name: 'wudu.md', id: 'wudu.md' })
    const id = up.body.id as string

    const list = await request(app).get('/api/stories').set(auth(token))
    expect(list.status).toBe(200)
    expect(list.body).toContainEqual({ name: 'wudu.md', id: 'wudu.md' })

    const read = await request(app).get(`/api/stories/${encodeURIComponent(id)}`).set(auth(token))
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ name: id, content })

    const rag = await request(app).get(`/api/stories/${encodeURIComponent(id)}/rag`).set(auth(token))
    expect(rag.status).toBe(200)
    expect(rag.body).toEqual({ name: id, content })

    const del = await request(app).delete(`/api/stories/${encodeURIComponent(id)}`).set(auth(token))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    const list2 = await request(app).get('/api/stories').set(auth(token))
    expect(list2.body).toHaveLength(0)
  })

  it('upload PDF → readStoryForRag extracts the text layer (pdf-lib fixture, no OCR)', async () => {
    const token = await registerToken('stories_pdf')
    const app = createApp()
    const pdf = await makePdfWithText('Hello COC PDF world 123')
    const up = await request(app).post('/api/stories/upload').set(auth(token)).attach('file', pdf, 'scenario.pdf')
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ ok: true, id: 'scenario.pdf' })

    const read = await request(app).get('/api/stories/scenario.pdf').set(auth(token))
    expect(read.status).toBe(200)
    expect(read.body.content).toContain('Hello COC PDF world')

    const rag = await request(app).get('/api/stories/scenario.pdf/rag').set(auth(token))
    expect(rag.status).toBe(200)
    expect(rag.body.content).toContain('Hello COC PDF world')
  })

  it('rejects unsupported extensions and empty uploads with ok:false (200)', async () => {
    const token = await registerToken('stories_bad')
    const app = createApp()
    const exe = await request(app).post('/api/stories/upload').set(auth(token)).attach('file', Buffer.from('MZ'), 'evil.exe')
    expect(exe.status).toBe(200)
    expect(exe.body).toMatchObject({ ok: false })
    expect(exe.body.error).toBeDefined()

    const nofile = await request(app).post('/api/stories/upload').set(auth(token))
    expect(nofile.status).toBe(200)
    expect(nofile.body).toEqual({ ok: false, error: 'no file received' })
  })

  it('sanitizes hostile filenames and suffixes name conflicts', async () => {
    const token = await registerToken('stories_san')
    const app = createApp()
    const hostile = await request(app)
      .post('/api/stories/upload')
      .set(auth(token))
      .attach('file', Buffer.from('x', 'utf-8'), '../../evil:name?.txt')
    expect(hostile.status).toBe(200)
    expect(hostile.body).toMatchObject({ ok: true, id: 'evil_name_.txt' })

    const dup1 = await request(app).post('/api/stories/upload').set(auth(token)).attach('file', Buffer.from('one'), 'dup.txt')
    const dup2 = await request(app).post('/api/stories/upload').set(auth(token)).attach('file', Buffer.from('two'), 'dup.txt')
    expect(dup1.body.id).toBe('dup.txt')
    expect(dup2.body.ok).toBe(true)
    expect(dup2.body.id).not.toBe('dup.txt')
    expect(dup2.body.id).toMatch(/^dup-[a-z0-9]+\.txt$/)

    const r1 = await request(app).get('/api/stories/dup.txt').set(auth(token))
    const r2 = await request(app).get(`/api/stories/${encodeURIComponent(dup2.body.id as string)}`).set(auth(token))
    expect(r1.body.content).toBe('one')
    expect(r2.body.content).toBe('two')
  })

  it('rejects traversal/invalid ids with 400 and missing files with 404', async () => {
    const token = await registerToken('stories_ids')
    const app = createApp()
    const trav = await request(app).get('/api/stories/..%2F..%2Fetc%2Fpasswd').set(auth(token))
    expect(trav.status).toBe(400)
    expect(trav.body.error).toBeDefined()

    const missing = await request(app).get('/api/stories/nope.md').set(auth(token))
    expect(missing.status).toBe(404)

    const delMissing = await request(app).delete('/api/stories/nope.md').set(auth(token))
    expect(delMissing.status).toBe(404)
  })

  it('isolates stories between users: B cannot list, read or delete A files', async () => {
    const tokenA = await registerToken('stories_iso_a')
    const tokenB = await registerToken('stories_iso_b')
    const app = createApp()
    await request(app).post('/api/stories/upload').set(auth(tokenA)).attach('file', Buffer.from('A 的秘密'), 'secret.txt')

    const listB = await request(app).get('/api/stories').set(auth(tokenB))
    expect(listB.body).toHaveLength(0)

    const readB = await request(app).get('/api/stories/secret.txt').set(auth(tokenB))
    expect(readB.status).toBe(404)

    const delB = await request(app).delete('/api/stories/secret.txt').set(auth(tokenB))
    expect(delB.status).toBe(404)

    const readA = await request(app).get('/api/stories/secret.txt').set(auth(tokenA))
    expect(readA.status).toBe(200)
    expect(readA.body.content).toBe('A 的秘密')
  })

  it('keeps CJK filenames intact on upload (defParamCharset utf-8) and list/read round-trip', async () => {
    const token = await registerToken('stories_cjk')
    const app = createApp()
    const content = '雾中灯塔：第一章 守夜人。'
    const up = await request(app)
      .post('/api/stories/upload')
      .set(auth(token))
      .attach('file', Buffer.from(content, 'utf-8'), '雾中的灯塔.txt')
    // supersonic/busboy request charset: filename must survive as CJK, NOT as
    // `é¾ä¸­çç¯å¡` (latin1 mojibake) — regression for feedback #1.
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ ok: true, name: '雾中的灯塔.txt' })
    const id = up.body.id as string
    expect(id).toBe('雾中的灯塔.txt')

    const list = await request(app).get('/api/stories').set(auth(token))
    expect(list.body).toContainEqual({ name: '雾中的灯塔.txt', id: '雾中的灯塔.txt' })

    const read = await request(app).get(`/api/stories/${encodeURIComponent(id)}`).set(auth(token))
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ name: '雾中的灯塔.txt', content })
  })
})

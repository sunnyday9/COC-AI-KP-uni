// @vitest-environment node
/**
 * RAG route tests (api-contract §8): supertest against the real app.
 *
 * Hermeticity: @huggingface/transformers is mocked (the builtin embedder
 * returns deterministic vectors — NO real model download); the graph
 * extraction LLM path is exercised only via the user's settings (default:
 * no model configured → chatForRag raises before any network). No real
 * outbound requests happen in this file.
 */
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import { TEST_PASSWORD } from '../../testHelpers.js'

// Deterministic builtin embedder: 2-dim one-hot-ish vectors by content.
// `env` must be present on the mock (embedding.ts points env.cacheDir at MODELS_DIR).
vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '' },
  pipeline: async () => async (text: string) => {
    const vec = text.includes('图书馆') ? [1, 0] : text.includes('医院') ? [0, 1] : [0.5, 0.5]
    return { data: new Float32Array(vec) }
  },
}))

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

async function registerToken(username: string): Promise<string> {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: TEST_PASSWORD })
  expect(res.status).toBe(200)
  return res.body.token as string
}

/** M1-T3：索引改为服务端自读自切——测试需先上传一篇故事，再只报 scriptId 索引。
 *  文本刻意超过目标块长（800 字符），使标题层级真正参与切分（两节 → 两块）。 */
const FILLER_A = `图书馆的木质地板在脚下吱呀作响。${'书架投下长长的影子。'.repeat(50)}`
const FILLER_B = `走廊尽头的灯光忽明忽暗。${'低语声从某扇门后传来。'.repeat(50)}`
const STORY_TEXT = [
  '# 图书馆',
  '你来到图书馆，闻到霉味。书架深处藏着一封密信。',
  FILLER_A,
  '# 医院',
  '医院里灯光惨白，走廊尽头传来低语。',
  FILLER_B,
].join('\n\n')

async function uploadStory(token: string, name = 'wudu.md'): Promise<string> {
  const res = await request(createApp())
    .post('/api/stories/upload')
    .set(auth(token))
    .attach('file', Buffer.from(STORY_TEXT, 'utf-8'), name)
  expect(res.status).toBe(200)
  return res.body.id as string
}

describe('rag routes', () => {
  it('requires a token on every endpoint (401 without)', async () => {
    const res = await request(createApp()).get('/api/rag/health')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('GET /api/rag/health reports status ok + embedding settings', async () => {
    const token = await registerToken('rag_health')
    const res = await request(createApp()).get('/api/rag/health').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.service).toBe('rag-embedded')
    expect(res.body.embeddingEnabled).toBe(true)
    expect(res.body.embeddingProvider).toBe('builtin')
    expect(res.body.embeddingModel).toBe('text-embedding-3-small')
  })

  it('POST /api/rag/test-embedding returns ok with vectorLength (builtin, mocked)', async () => {
    const token = await registerToken('rag_embed')
    const res = await request(createApp()).post('/api/rag/test-embedding').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.vectorLength).toBe('number')
    expect(res.body.vectorLength).toBeGreaterThan(0)
  })

  it('index + query closed loop hits the matching chunk（服务端自读自切）', async () => {
    const token = await registerToken('rag_loop')
    const scriptId = await uploadStory(token)

    const indexRes = await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId, storyMeta: { name: '雾都疑云' } })
    expect(indexRes.status).toBe(200)
    // 两个 Markdown 标题各成一块（服务端递归切块）
    expect(indexRes.body.ok).toBe(true)
    expect(indexRes.body.indexed).toBe(2)

    const q = await request(createApp())
      .post('/api/rag/query')
      .set(auth(token))
      .send({ query: '图书馆的密信', scriptId, topK: 1 })
    expect(q.status).toBe(200)
    expect(q.body.chunks).toHaveLength(1)
    expect(q.body.chunks[0]!.content).toContain('图书馆')
    expect(typeof q.body.chunks[0]!.distance).toBe('number')

    // 旧契约（带 chunks）被明确拒绝，而不是静默降级
    const legacy = await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId, chunks: [{ id: 'c1', content: 'x' }] })
    expect(legacy.status).toBe(200)
    expect(legacy.body.ok).toBe(false)
    expect(String(legacy.body.error)).toContain('chunks are no longer accepted')
  })

  it('index requires scriptId and a readable story', async () => {
    const token = await registerToken('rag_badindex')
    const missing = await request(createApp()).post('/api/rag/index').set(auth(token)).send({})
    expect(missing.body.ok).toBe(false)
    expect(String(missing.body.error)).toContain('scriptId')

    const ghost = await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'ghost.md' })
    expect(ghost.body.ok).toBe(false)
    expect(String(ghost.body.error).length).toBeGreaterThan(0)
  })

  it('context builds text context with chunkCount', async () => {
    const token = await registerToken('rag_ctx')
    const scriptId = await uploadStory(token, 'ctx.md')
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId, storyMeta: { name: '测试' } })
      .expect(200)

    const res = await request(createApp())
      .post('/api/rag/context')
      .set(auth(token))
      .send({ query: '图书馆', scriptId, topK: 1 })
    expect(res.status).toBe(200)
    expect(res.body.context).toContain('图书馆')
    expect(res.body.chunkCount).toBeGreaterThanOrEqual(1)
  })

  it('stories / story-overview / getIndex report the indexed story', async () => {
    const token = await registerToken('rag_list')
    const scriptId = await uploadStory(token, 'list.md')
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId, storyMeta: { name: '雾都疑云' } })
      .expect(200)

    const stories = await request(createApp()).get('/api/rag/stories').set(auth(token))
    expect(stories.status).toBe(200)
    expect(stories.body).toHaveLength(1)
    expect(stories.body[0]).toMatchObject({ storyId: scriptId, name: '雾都疑云', chunkCount: 2 })
    expect(typeof stories.body[0].indexedAt).toBe('number')

    const ov = await request(createApp()).post('/api/rag/story-overview').set(auth(token)).send({ storyId: scriptId })
    expect(ov.status).toBe(200)
    expect(ov.body.storyName).toBe('雾都疑云')
    expect(ov.body.overview).toContain('图书馆')

    const idx = await request(createApp()).get(`/api/rag/index/${encodeURIComponent(scriptId)}`).set(auth(token))
    expect(idx.status).toBe(200)
    expect(idx.body.chunkCount).toBe(2)
    // 块带字符偏移（M1-T3 契约：场景归属在查询期用偏移现算）
    expect(typeof idx.body.chunks[0].metadata?.start).toBe('number')
    expect(idx.body.chunks[0].hasVector).toBe(true)
  })

  it('delete removes the index', async () => {
    const token = await registerToken('rag_del')
    const scriptId = await uploadStory(token, 'del.md')
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId, storyMeta: { name: '测试' } })
      .expect(200)

    const del = await request(createApp()).delete(`/api/rag/index/${encodeURIComponent(scriptId)}`).set(auth(token))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true, deleted: 2 })

    const stories = await request(createApp()).get('/api/rag/stories').set(auth(token))
    expect(stories.body).toHaveLength(0)
  })

  it('isolates data between users: user B cannot see or query user A index', async () => {
    const tokenA = await registerToken('rag_iso_a')
    const tokenB = await registerToken('rag_iso_b')
    const scriptId = await uploadStory(tokenA, 'shared.md')
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(tokenA))
      .send({ scriptId, storyMeta: { name: 'A 的故事' } })
      .expect(200)

    const storiesB = await request(createApp()).get('/api/rag/stories').set(auth(tokenB))
    expect(storiesB.body).toHaveLength(0)

    const qB = await request(createApp())
      .post('/api/rag/query')
      .set(auth(tokenB))
      .send({ query: '图书馆', scriptId, topK: 2 })
    expect(qB.status).toBe(200)
    expect(qB.body.chunks).toHaveLength(0)

    const idxB = await request(createApp()).get(`/api/rag/index/${encodeURIComponent(scriptId)}`).set(auth(tokenB))
    expect(idxB.body.chunkCount).toBe(0)
  })

  it('user-graph add → sync → summary closed loop', async () => {
    const token = await registerToken('rag_ugraph')
    const add = await request(createApp())
      .post('/api/rag/user-graph/event')
      .set(auth(token))
      .send({ storyId: 'ug-1', sessionId: 'sess-1', event: { type: 'clue', name: '密信' } })
    expect(add.status).toBe(200)
    expect(add.body).toEqual({ ok: true })

    const add2 = await request(createApp())
      .post('/api/rag/user-graph/event')
      .set(auth(token))
      .send({ storyId: 'ug-1', sessionId: 'sess-1', event: { type: 'scene', name: '图书馆' } })
    expect(add2.body).toEqual({ ok: true })

    const sync = await request(createApp())
      .post('/api/rag/user-graph/sync')
      .set(auth(token))
      .send({ storyId: 'ug-1', sessionId: 'sess-1', state: { cluesObtained: ['密信', '钥匙'], currentScene: '医院' } })
    expect(sync.status).toBe(200)
    expect(sync.body).toEqual({ ok: true })

    const summary = await request(createApp())
      .post('/api/rag/user-graph/summary')
      .set(auth(token))
      .send({ storyId: 'ug-1', sessionId: 'sess-1' })
    expect(summary.status).toBe(200)
    expect(summary.body.summary).toContain('已获线索：密信、钥匙')
    expect(summary.body.summary).toContain('到访场景：图书馆、医院')

    // another user sees nothing
    const tokenB = await registerToken('rag_ugraph_b')
    const other = await request(createApp())
      .post('/api/rag/user-graph/summary')
      .set(auth(tokenB))
      .send({ storyId: 'ug-1', sessionId: 'sess-1' })
    expect(other.body.summary).toBe('')
  })
})

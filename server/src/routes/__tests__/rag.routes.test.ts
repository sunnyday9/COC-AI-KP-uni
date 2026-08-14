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
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: 'secret123' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

const CHUNKS = [
  { id: 'c1', content: '你来到图书馆，闻到霉味。书架深处藏着一封密信。', type: 'scene', metadata: { sceneId: '图书馆' } },
  { id: 'c2', content: '医院里灯光惨白，走廊尽头传来低语。', type: 'scene', metadata: { sceneId: '医院' } },
]

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

  it('index + query closed loop hits the matching chunk', async () => {
    const token = await registerToken('rag_loop')
    // Disable GraphRAG build for this user so no LLM path runs during indexing.
    await request(createApp())
      .put('/api/settings')
      .set(auth(token))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)

    const indexRes = await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'story-1', chunks: CHUNKS, storyMeta: { name: '雾都疑云' } })
    expect(indexRes.status).toBe(200)
    expect(indexRes.body).toEqual({ ok: true, indexed: 2 })

    const q = await request(createApp())
      .post('/api/rag/query')
      .set(auth(token))
      .send({ query: '图书馆的密信', scriptId: 'story-1', topK: 1 })
    expect(q.status).toBe(200)
    expect(q.body.chunks).toHaveLength(1)
    expect(q.body.chunks[0]!.content).toContain('图书馆')
    expect(typeof q.body.chunks[0]!.distance).toBe('number')

    // sceneId anti-spoiler: nonexistent scene → no fallback
    const q2 = await request(createApp())
      .post('/api/rag/query')
      .set(auth(token))
      .send({ query: '密信', scriptId: 'story-1', sceneId: '不存在', topK: 2 })
    expect(q2.body.chunks).toHaveLength(0)
  })

  it('context builds text context with chunkCount (no graph when useGraphRAG=false)', async () => {
    const token = await registerToken('rag_ctx')
    await request(createApp())
      .put('/api/settings')
      .set(auth(token))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'story-2', chunks: CHUNKS, storyMeta: { name: '测试' } })
      .expect(200)

    const res = await request(createApp())
      .post('/api/rag/context')
      .set(auth(token))
      .send({ query: '图书馆', scriptId: 'story-2', topK: 1 })
    expect(res.status).toBe(200)
    expect(res.body.context).toContain('## 剧本相关情报')
    expect(res.body.context).toContain('图书馆')
    expect(res.body.chunkCount).toBe(1)
    expect(res.body.graphSummary).toBeUndefined()
  })

  it('stories / story-overview / getIndex report the indexed story', async () => {
    const token = await registerToken('rag_list')
    await request(createApp())
      .put('/api/settings')
      .set(auth(token))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'story-3', chunks: CHUNKS, storyMeta: { name: '雾都疑云' } })
      .expect(200)

    const stories = await request(createApp()).get('/api/rag/stories').set(auth(token))
    expect(stories.status).toBe(200)
    expect(stories.body).toHaveLength(1)
    expect(stories.body[0]).toMatchObject({ storyId: 'story-3', name: '雾都疑云', chunkCount: 2 })
    expect(typeof stories.body[0].indexedAt).toBe('number')

    const ov = await request(createApp()).post('/api/rag/story-overview').set(auth(token)).send({ storyId: 'story-3' })
    expect(ov.status).toBe(200)
    expect(ov.body.storyName).toBe('雾都疑云')
    expect(ov.body.overview).toContain('图书馆')

    const idx = await request(createApp()).get('/api/rag/index/story-3').set(auth(token))
    expect(idx.status).toBe(200)
    expect(idx.body.chunkCount).toBe(2)
    expect(idx.body.chunks[0]).toMatchObject({ id: 'c1', type: 'scene' })
    expect(idx.body.chunks[0].hasVector).toBe(true)
  })

  it('getGraph returns null when no graph was built, and delete removes the index', async () => {
    const token = await registerToken('rag_del')
    await request(createApp())
      .put('/api/settings')
      .set(auth(token))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'story-4', chunks: CHUNKS, storyMeta: { name: '测试' } })
      .expect(200)

    const g = await request(createApp()).get('/api/rag/graph/story-4').set(auth(token))
    expect(g.status).toBe(200)
    expect(g.body).toBeNull()

    const del = await request(createApp()).delete('/api/rag/index/story-4').set(auth(token))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true, deleted: 2 })

    const stories = await request(createApp()).get('/api/rag/stories').set(auth(token))
    expect(stories.body).toHaveLength(0)
  })

  it('isolates data between users: user B cannot see or query user A index', async () => {
    const tokenA = await registerToken('rag_iso_a')
    const tokenB = await registerToken('rag_iso_b')
    await request(createApp())
      .put('/api/settings')
      .set(auth(tokenA))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(tokenA))
      .send({ scriptId: 'shared-story', chunks: CHUNKS, storyMeta: { name: 'A 的故事' } })
      .expect(200)

    const storiesB = await request(createApp()).get('/api/rag/stories').set(auth(tokenB))
    expect(storiesB.body).toHaveLength(0)

    const qB = await request(createApp())
      .post('/api/rag/query')
      .set(auth(tokenB))
      .send({ query: '图书馆', scriptId: 'shared-story', topK: 2 })
    expect(qB.status).toBe(200)
    expect(qB.body.chunks).toHaveLength(0)

    const idxB = await request(createApp()).get('/api/rag/index/shared-story').set(auth(tokenB))
    expect(idxB.body.chunkCount).toBe(0)
  })

  it('test-graphrag-extract reports missing index, then per-batch error without LLM config', async () => {
    const token = await registerToken('rag_testextract')
    // No index yet
    const missing = await request(createApp())
      .post('/api/rag/test-graphrag-extract')
      .set(auth(token))
      .send({ scriptId: 'story-x' })
    expect(missing.status).toBe(200)
    expect(missing.body).toMatchObject({ ok: false, error: 'rag_index not found for this scriptId' })

    await request(createApp())
      .put('/api/settings')
      .set(auth(token))
      .send({ rag: { useGraphRAG: false } })
      .expect(200)
    await request(createApp())
      .post('/api/rag/index')
      .set(auth(token))
      .send({ scriptId: 'story-x', chunks: CHUNKS, storyMeta: { name: '测试' } })
      .expect(200)

    // No AI model configured → every batch fails fast (no network) with an error entry.
    const res = await request(createApp())
      .post('/api/rag/test-graphrag-extract')
      .set(auth(token))
      .send({ scriptId: 'story-x', maxChunks: 6, maxBatches: 2 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.scriptId).toBe('story-x')
    expect(res.body.totalBatches).toBeGreaterThanOrEqual(1)
    expect(res.body.results.length).toBeGreaterThanOrEqual(1)
    for (const r of res.body.results) {
      expect(typeof r.error).toBe('string')
    }
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

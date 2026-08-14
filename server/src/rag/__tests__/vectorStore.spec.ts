// @vitest-environment node
/**
 * Migrated from original/ai-trpg-web/electron/rag/__tests__/vectorStore.spec.ts.
 * The original mocked the electron `app.getPath('userData')`; the server store
 * reads `RAG_DATA_DIR` from config at module load, so each test points it at a
 * fresh temp dir and re-imports the module (vi.resetModules).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function makeTmpDir(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-index-test-'))
  return p
}

describe('rag/vectorStore', () => {
  let tmpUserData: string

  beforeEach(async () => {
    tmpUserData = makeTmpDir()
    process.env.RAG_DATA_DIR = tmpUserData
    vi.resetModules()
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true })
    } catch {
      // ignore
    }
    delete process.env.RAG_DATA_DIR
    vi.resetModules()
  })

  it('indexes, queries, and persists chunks with embeddings', async () => {
    const rag = await import('../vectorStore.js')
    const userId = 1
    const storyId = '故事A'
    const embed = async (t: string) => {
      const text = String(t)
      if (text.includes('图书馆') || text.includes('霉味')) return [1, 0]
      if (text.includes('医院') || text.includes('走廊')) return [0, 1]
      return [1, 1]
    }
    await rag.indexChunks(
      userId,
      storyId,
      [
        { id: 'c1', content: '你来到图书馆，闻到霉味。', type: 'scene', metadata: { sceneId: '图书馆', type: 'scene' } },
        { id: 'c2', content: '医院里灯光惨白，走廊尽头传来低语。', type: 'scene', metadata: { sceneId: '医院', type: 'scene' } },
      ],
      { name: '测试故事' },
      { getEmbedding: embed }
    )

    const r1 = await rag.queryChunks({ userId, query: '图书馆', scriptId: storyId, topK: 1, getEmbedding: embed })
    expect(r1.chunks.length).toBe(1)
    expect(r1.chunks[0]!.content).toContain('图书馆')

    // scene filter should narrow candidates when scene_id exists
    const r2 = await rag.queryChunks({ userId, query: '走廊', scriptId: storyId, sceneId: '医院', topK: 1, getEmbedding: embed })
    expect(r2.chunks.length).toBe(1)
    expect(r2.chunks[0]!.content).toContain('医院')

    // anti-spoiler: if scene has no matches, do NOT fall back to other scenes
    const r3 = await rag.queryChunks({ userId, query: '霉味', scriptId: storyId, sceneId: '不存在的场景', topK: 2, getEmbedding: embed })
    expect(r3.chunks.length).toBe(0)

    // persisted index file exists under RAG_DATA_DIR/<userId>/rag_index
    const idxDir = path.join(tmpUserData, '1', 'rag_index')
    expect(fs.existsSync(idxDir)).toBe(true)
    expect(fs.readdirSync(idxDir).some((f) => f.includes('故事A'))).toBe(true)
  })

  it('isolates index files between users', async () => {
    const rag = await import('../vectorStore.js')
    const embed = async () => [1, 0]
    await rag.indexChunks(
      1,
      'S',
      [{ id: 'a', content: '图书馆 线索A', type: 'rule', metadata: {} }],
      {},
      { getEmbedding: embed }
    )
    // user 2 sees nothing
    const r = await rag.queryChunks({ userId: 2, query: '图书馆', scriptId: 'S', topK: 5, getEmbedding: embed })
    expect(r.chunks.length).toBe(0)
    expect(rag.listIndexedStories(2)).toHaveLength(0)
    expect(rag.listIndexedStories(1)).toHaveLength(1)
  })

  it('uses dense vectors when provided (hybrid supported)', async () => {
    const rag = await import('../vectorStore.js')
    const userId = 1
    const storyId = 'S'
    const embed = async (t: string) => (t.includes('图书馆') ? [1, 0] : [0, 1])
    await rag.indexChunks(
      userId,
      storyId,
      [
        { id: 'a', content: '图书馆 线索A', type: 'rule', metadata: {} },
        { id: 'b', content: '医院 线索B', type: 'rule', metadata: {} },
      ],
      {},
      { getEmbedding: embed }
    )
    const r = await rag.queryChunks({ userId, query: '图书馆', scriptId: storyId, topK: 1, getEmbedding: embed })
    expect(r.chunks[0]!.content).toContain('图书馆')
  })

  it('buildContext formats output with headings', async () => {
    const rag = await import('../vectorStore.js')
    const userId = 1
    const storyId = 'X'
    const embed = async () => [1, 0, 0]
    await rag.indexChunks(
      userId,
      storyId,
      [{ id: 'c', content: '线索：钥匙在花瓶里。', type: 'clue', metadata: { type: 'clue' } }],
      {},
      { getEmbedding: embed }
    )
    const ctx = await rag.buildContext({ userId, query: '钥匙', scriptId: storyId, topK: 1, getEmbedding: embed })
    expect(ctx.context).toContain('## 剧本相关情报')
    expect(ctx.context).toContain('### [1]')
  })

  it('checkHealth reports indexedStoryCount', async () => {
    const rag = await import('../vectorStore.js')
    const userId = 1
    const storyId = 'Y'
    await rag.indexChunks(userId, storyId, [{ id: 'c', content: '测试内容', type: 'rule', metadata: {} }], {}, {})
    const health = rag.checkHealth(userId)
    expect(health.status).toBe('ok')
    expect(typeof health.indexedStoryCount).toBe('number')
    expect(health.indexedStoryCount).toBeGreaterThanOrEqual(1)
  })
})

// @vitest-environment node
/**
 * graphStore / graphRag unit tests (no original counterpart — the original
 * suite only covered embedding/vectorStore/graphExtractLLM/storyParsers; the
 * graph indexing + expansion + context-with-graph flow is not reachable in
 * route tests without an LLM, so it is covered here with a mocked invokeChat).
 * No real LLM calls / no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rag-graph-test-'))
}

describe('rag/graphStore + graphRag', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    process.env.RAG_DATA_DIR = tmpDir
    vi.resetModules()
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    delete process.env.RAG_DATA_DIR
    vi.resetModules()
  })

  it('indexGraph extracts nodes/edges + community summaries (mocked LLM) and persists per user', async () => {
    const graphStore = await import('../graphStore.js')
    const invokeChat = vi.fn(async (params: { messages: { content: string }[] }) => {
      const prompt = params.messages[params.messages.length - 1]!.content
      if (prompt.includes('knowledge graph extractor')) {
        return {
          content: `图书馆 | scene | 调查员可搜索的场所\n密信 | clue | 关键线索\n图书馆 | contains | 密信\n---END---`,
        }
      }
      if (prompt.includes('summarizing a subgraph')) {
        return { content: '这是一个包含图书馆与密信的社区摘要。' }
      }
      return { content: '' }
    })

    const chunks = [
      { id: 'c1', content: '你来到图书馆，闻到霉味。书架深处藏着一封密信。', type: 'scene', metadata: { sceneId: '图书馆' } },
      { id: 'c2', content: '医院里灯光惨白，走廊尽头传来低语。', type: 'scene', metadata: { sceneId: '医院' } },
    ]
    const result = await graphStore.indexGraph(1, 'g-story', chunks, { name: '图谱故事' }, { invokeChat })
    expect(result).toEqual({ ok: true, nodeCount: 2, edgeCount: 1 })

    const graph = graphStore.getGraph(1, 'g-story')
    expect(graph).not.toBeNull()
    expect(graph!.storyName).toBe('图谱故事')
    expect(graph!.nodes.map((n) => n.name).sort()).toEqual(['图书馆', '密信'])
    expect(graph!.nodes.every((n) => typeof n.communityId === 'string')).toBe(true)
    expect(graph!.edges).toHaveLength(1)
    expect(graph!.edges[0]).toMatchObject({ source: 'scene:图书馆', target: 'clue:密信', type: 'contains' })
    expect(Object.values(graph!.communitySummaries).join()).toContain('社区摘要')

    // persisted to RAG_DATA_DIR/<userId>/graph_index
    const dir = path.join(tmpDir, '1', 'graph_index')
    expect(fs.existsSync(path.join(dir, 'g-story.json'))).toBe(true)

    // isolation: another user sees no graph
    expect(graphStore.getGraph(2, 'g-story')).toBeNull()
  })

  it('expandFromChunks walks 2 hops and returns expanded chunkIds', async () => {
    const graphStore = await import('../graphStore.js')
    const invokeChat = vi.fn(async () => ({
      content: `图书馆 | scene | 场所\n密信 | clue | 线索\n走廊 | location | 位置\n图书馆 | contains | 密信\n密信 | triggers | 走廊\n---END---`,
    }))
    await graphStore.indexGraph(
      1,
      'g2',
      [
        { id: 'c1', content: '图书馆内容', type: 'scene' },
        { id: 'c2', content: '密信内容', type: 'clue' },
        { id: 'c3', content: '走廊内容', type: 'rule' },
      ],
      {},
      { invokeChat },
    )
    const expanded = graphStore.expandFromChunks(1, 'g2', ['c1'], 2)
    expect(expanded.chunkIds).toContain('c1')
    expect(expanded.chunkIds).toContain('c2')
    expect(expanded.chunkIds).toContain('c3') // 2 hops: 图书馆→密信→走廊
    expect(expanded.nodeIds.length).toBe(3)
  })

  it('buildContextWithGraph includes graphSummary when a graph exists', async () => {
    const graphStore = await import('../graphStore.js')
    const graphRag = await import('../graphRag.js')
    const invokeChat = vi.fn(async (params: { messages: { content: string }[] }) => {
      const prompt = params.messages[params.messages.length - 1]!.content
      if (prompt.includes('knowledge graph extractor')) {
        return { content: `图书馆 | scene | 场所\n密信 | clue | 线索\n图书馆 | contains | 密信\n---END---` }
      }
      return { content: '社区摘要内容' }
    })
    const embed = async (t: string) => (t.includes('图书馆') ? [1, 0] : [0, 1])
    await graphStore.indexGraph(
      1,
      'g3',
      [
        { id: 'c1', content: '图书馆里藏着密信。', type: 'scene', metadata: { sceneId: '图书馆' } },
        { id: 'c2', content: '医院里灯光惨白。', type: 'scene', metadata: { sceneId: '医院' } },
      ],
      { name: '图谱三' },
      { invokeChat },
    )
    const vectorStore = await import('../vectorStore.js')
    await vectorStore.indexChunks(
      1,
      'g3',
      [
        { id: 'c1', content: '图书馆里藏着密信。', type: 'scene', metadata: { sceneId: '图书馆' } },
        { id: 'c2', content: '医院里灯光惨白。', type: 'scene', metadata: { sceneId: '医院' } },
      ],
      { name: '图谱三' },
      { getEmbedding: embed },
    )
    const ctx = await graphRag.buildContextWithGraph({
      userId: 1,
      query: '图书馆',
      scriptId: 'g3',
      topK: 1,
      getEmbedding: embed,
      useGraphRAG: true,
    })
    expect(ctx.chunkCount).toBeGreaterThanOrEqual(1)
    expect(ctx.graphSummary).toBeDefined()
    expect(ctx.context).toContain('## 故事情报（含关系）')
    expect(ctx.context).toContain('社区摘要')

    // useGraphRAG=false → plain context, no graphSummary
    const plain = await graphRag.buildContextWithGraph({
      userId: 1,
      query: '图书馆',
      scriptId: 'g3',
      topK: 1,
      getEmbedding: embed,
      useGraphRAG: false,
    })
    expect(plain.graphSummary).toBeUndefined()
    expect(plain.context).toContain('## 剧本相关情报')
  })

  it('indexGraph with empty chunks clears the graph, deleteGraph removes the file', async () => {
    const graphStore = await import('../graphStore.js')
    const invokeChat = vi.fn(async () => ({ content: '图书馆 | scene | 场所\n---END---' }))
    await graphStore.indexGraph(1, 'g4', [{ id: 'c1', content: 'x', type: 'rule' }], {}, { invokeChat })
    expect(graphStore.getGraph(1, 'g4')).not.toBeNull()

    await graphStore.indexGraph(1, 'g4', [], {}, { invokeChat })
    expect(graphStore.getGraph(1, 'g4')).toBeNull()

    await graphStore.indexGraph(1, 'g5', [{ id: 'c1', content: 'y', type: 'rule' }], {}, { invokeChat })
    graphStore.deleteGraph(1, 'g5')
    expect(graphStore.getGraph(1, 'g5')).toBeNull()
    expect(fs.existsSync(path.join(tmpDir, '1', 'graph_index', 'g5.json'))).toBe(false)
  })
})

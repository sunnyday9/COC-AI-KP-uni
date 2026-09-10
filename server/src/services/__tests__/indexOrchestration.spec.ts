/**
 * 索引编排与 API 断代 spec（M1-T3 / issue #48，TDD）。
 *
 * 契约（spec #44 决策 4 / ADR-0007 决策 4）：
 *  - `POST /api/rag/index` 只收 `{scriptId, storyMeta?}`：服务端**自读故事原文 → 自切块 → 自嵌入
 *    → 落盘**；响应 `{ok, indexed}`，`indexed` = 服务端切出的块数；
 *  - 索引期**预取重排模型**（失败只告警，不影响索引成功）；
 *  - 落盘块带**字符偏移**（供场景归属）；
 *  - 缺 scriptId / 故事不存在 → 明确错误；
 *  - 不再建图（图链路随 T7 删除，本票起索引不再调用图路径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-index-spec-'))
vi.stubEnv('DATA_DIR', path.join(tmpRoot, 'data'))
vi.stubEnv('UPLOADS_DIR', path.join(tmpRoot, 'uploads'))
vi.stubEnv('RAG_DATA_DIR', path.join(tmpRoot, 'rag'))
vi.resetModules()

const STORY_TEXT = [
  '# 第一章 引子',
  '图书馆的密信藏在第三排书架后面。',
  '书架的角落里放着一只青瓷花瓶，底部有夹层。',
  '# 第二章 夜访',
  '钟楼地下室的门被木板钉死，墙上有六道抓痕。',
].join('\n\n')

// 故事读取与嵌入都注入（不触网、不加载模型）
const readStoryForRag = vi.fn(async () => ({ name: '雾都疑云', content: STORY_TEXT }))
const fakeEmbed = vi.fn(async (text: string) => [text.length, 1, 0])
let prefetchCalls = 0
let prefetchShouldFail = false
vi.mock('../storyService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storyService.js')>()
  return { ...actual, readStoryForRag }
})
vi.mock('../../rag/reranker.js', () => ({
  loadRerankModel: vi.fn(async () => {
    prefetchCalls++
    if (prefetchShouldFail) throw new Error('model download failed')
    return { tokenizer: vi.fn(), model: vi.fn() }
  }),
  isMockAiMode: vi.fn(() => false),
}))

describe('rag/index 编排（服务端自读自切）', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    prefetchCalls = 0
    prefetchShouldFail = false
    await fs.mkdir(path.join(tmpRoot, 'uploads', '1', 'stories'), { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('只给 scriptId → 服务端自读自切自嵌，indexed 等于切块数', async () => {
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const res = await indexStoryForRag(1, 'story-1', undefined, { getEmbedding: fakeEmbed })
    expect(res.ok).toBe(true)
    expect(res.indexed).toBeGreaterThan(0)
    expect(readStoryForRag).toHaveBeenCalledWith(1, 'story-1')
    // 切块由服务端完成：嵌入被逐块调用（块数 = 嵌入调用次数）
    expect(fakeEmbed).toHaveBeenCalledTimes(res.indexed as number)
  })

  it('落盘块带字符偏移（可还原原文子串）', async () => {
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const { queryChunks } = await import('../../rag/vectorStore.js')
    await indexStoryForRag(1, 'story-2', undefined, { getEmbedding: fakeEmbed })
    const { chunks } = await queryChunks({ userId: 1, query: '青瓷花瓶', scriptId: 'story-2', topK: 5, getEmbedding: fakeEmbed })
    expect(chunks.length).toBeGreaterThan(0)
    const hit = chunks.find((c) => c.content.includes('青瓷花瓶'))
    expect(hit).toBeTruthy()
    const off = hit?.metadata?.start ?? hit?.metadata?.charStart
    expect(typeof off).toBe('number')
    expect(STORY_TEXT.slice(off as number, (off as number) + String(hit?.content).length)).toBe(String(hit?.content))
  })

  it('索引期预取重排模型；预取失败只告警、索引仍成功', async () => {
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const ok = await indexStoryForRag(1, 'story-3', undefined, { getEmbedding: fakeEmbed })
    expect(prefetchCalls).toBe(1)
    expect(ok.ok).toBe(true)

    prefetchCalls = 0
    prefetchShouldFail = true
    const res = await indexStoryForRag(1, 'story-4', undefined, { getEmbedding: fakeEmbed })
    expect(prefetchCalls).toBe(1)
    expect(res.ok).toBe(true)
    expect(res.indexed).toBeGreaterThan(0)
    expect(String(res.warning ?? '')).toContain('rerank')
  })

  it('缺 scriptId → 明确失败；故事读取失败 → 明确失败（都不抛出）', async () => {
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const missing = await indexStoryForRag(1, '', undefined, { getEmbedding: fakeEmbed })
    expect(missing.ok).toBe(false)
    expect(String(missing.error)).toContain('scriptId')

    readStoryForRag.mockRejectedValueOnce(new Error('story not found'))
    const notFound = await indexStoryForRag(1, 'ghost', undefined, { getEmbedding: fakeEmbed })
    expect(notFound.ok).toBe(false)
    expect(String(notFound.error).length).toBeGreaterThan(0)
  })

  it('空原文 → 判失败（不产空索引）', async () => {
    readStoryForRag.mockResolvedValueOnce({ name: '空', content: '   \n\n  ' })
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const res = await indexStoryForRag(1, 'blank', undefined, { getEmbedding: fakeEmbed })
    expect(res.ok).toBe(false)
  })

  it('无嵌入提供方 → 仍完成索引（词面兜底），调用方不需要 embedding', async () => {
    const { indexStoryForRag } = await import('../indexOrchestration.js')
    const res = await indexStoryForRag(1, 'story-5')
    expect(res.ok).toBe(true)
    expect(res.indexed).toBeGreaterThan(0)
  })
})

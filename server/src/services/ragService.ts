/**
 * RAG orchestration service (api-contract §8) — migrated from
 * original/ai-trpg-web/electron/ipc/ragHandlers.cjs. Every handler becomes a
 * service method taking `userId` first (data isolation, decision 1).
 *
 * Adaptations vs the original (no Electron main process):
 *  - AI config (apiKey/model/baseUrl) comes from the user's server-side
 *    settings; outbound embedding & extraction requests pass
 *    `assertSafeOutboundUrl` first (decision 2/3) — an unsafe baseUrl raises
 *    BadRequestError (400) instead of silently falling back to the builtin
 *    model (the original fell back on "API 配置不完整或失败"; a security-gate
 *    rejection must stay loud — consistent with the AI chat path).
 *  - Errors are classified (BadRequestError / UpstreamError) instead of bare
 *    IPC rejections.
 *
 * M1-T7（ADR-0007 决策 3）：图链路（graphStore / graphRag / graphExtractLLM / 图抽取与
 * 社区摘要提示词）**整体删除**——索引期 LLM 建图与查询期无上限的 2 跳扩展都已是负资产
 * （档案取代了"关系情报块"的角色，A/B 无收益）。REST 的图端点与
 * `useGraphRAG`/`extractionModel` 设置项同批移除，不留死开关。
 * userGraphStore（A3 延后特性，与 GraphRAG 不是一回事）2026-09-12 经用户拍板**退役**：
 * 零回合路径消费方，需要时从 git 历史取回。
 */
import { getSettings, getAiConfig } from './settingsService.js'
import { isMockAiMode } from '../config.js'
import type { AppSettings } from '../../../shared/types/settings.js'
import { assertSafeOutboundUrl } from '../utils/outboundUrl.js'
import { BadRequestError } from '../utils/errors.js'
import * as vectorStore from '../rag/vectorStore.js'
import { createEmbedder, createBuiltinEmbedder, type Embedder } from '../rag/embedding.js'

/* ═══════════════════ Embedding provider resolution ═══════════════════ */

/**
 * Build getEmbedding from settings. Always returns an embedding function
 * when possible; prefers the user API, otherwise falls back to the builtin
 * model (mirrors original buildGetEmbedding). An unsafe API baseUrl raises
 * BadRequestError (see module header).
 *
 * 导出（M1-T6）：检索补充层需要同一个嵌入器（同一份 provider 解析与内置模型单例，
 * 两处各写一份会各建一个模型实例）。
 */
export async function buildGetEmbeddingForUser(userId: number): Promise<Embedder | null> {
  return buildGetEmbedding(userId)
}

async function buildGetEmbedding(userId: number): Promise<Embedder | null> {
  if (isMockAiMode()) {
    // MOCK_AI (Task 11): skip the local model download entirely — TF-IDF
    // vectorStore still indexes/queries chunks without dense embeddings.
    return null
  }
  const settings = getSettings(userId)
  const rag = (settings.rag || {}) as NonNullable<AppSettings["rag"]>
  const provider = rag.provider === 'api' ? 'api' : 'builtin'

  if (provider === 'api') {
    const ai = getAiConfig(userId)
    const baseUrl = (ai.baseUrl || '').trim()
    const apiKey = ai.apiKey && ai.apiKey !== '***' ? ai.apiKey : null
    if (baseUrl && apiKey) {
      // Security gate: every outbound embedding request must pass this first.
      try {
        assertSafeOutboundUrl(baseUrl)
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : String(err))
      }
      const apiEmbedder = createEmbedder({
        baseUrl,
        apiKey,
        model: rag.model || 'text-embedding-3-small',
      })
      if (apiEmbedder) return apiEmbedder
    }
    // 如果 API 配置不完整，则回退到内置模型（与原实现一致）
  }

  return await createBuiltinEmbedder()
}

/* ═══════════════════ Per-endpoint operations ═══════════════════ */

/** GET /api/rag/health — rag:health. */
export function health(userId: number): {
  status: string
  service: string
  indexedStoryCount: number
  embeddingEnabled: boolean
  embeddingProvider: string
  embeddingModel: string
} {
  const base = vectorStore.checkHealth(userId)
  const settings = getSettings(userId)
  const ragSettings = (settings?.rag || {}) as NonNullable<AppSettings["rag"]>
  return {
    ...base,
    embeddingEnabled: !!ragSettings.useEmbeddings,
    embeddingProvider: ragSettings.provider || 'builtin',
    embeddingModel: ragSettings.model || 'text-embedding-3-small',
  }
}

/** POST /api/rag/test-embedding — rag:testEmbedding. */
export async function testEmbedding(
  userId: number,
): Promise<{ ok: boolean; vectorLength?: number; error?: string }> {
  try {
    const embed = await buildGetEmbedding(userId)
    if (!embed) return { ok: false, error: 'No embedding provider available' }
    const vec = await embed('test embedding connection')
    const vectorLength = Array.isArray(vec) ? vec.length : 0
    return { ok: true, vectorLength }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * POST /api/rag/index — rag:index（M1-T3 / issue #48：只报 scriptId，服务端自读自切自嵌）。
 *
 * 断代（ADR-0007 决策 4）：请求体不再收 chunks；服务端切块（递归语义切块 + 字符偏移）+
 * 嵌入 + 落盘，索引期顺带预取重排模型（非致命）。图链路已在 M1-T7 删除——全程不建图。
 * 旧调用方（带 chunks）会得到明确错误，而不是静默降级。
 */
export async function index(
  userId: number,
  params: { scriptId?: string; chunks?: unknown; storyMeta?: { name?: string } } | undefined,
): Promise<{ ok: boolean; indexed: number; error?: string; warning?: string }> {
  const { scriptId, chunks, storyMeta } = params || {}
  if (!scriptId) {
    return { ok: false, indexed: 0, error: 'scriptId required' }
  }
  if (chunks !== undefined) {
    // 只认新契约：任何 chunks 形态（含空数组/非数组）都明确拒绝，不静默忽略
    return {
      ok: false,
      indexed: 0,
      error: 'chunks are no longer accepted: the server chunks the story itself (M1-T3). Send {scriptId} only.',
    }
  }
  const getEmbedding = await buildGetEmbedding(userId)
  // 动态导入：索引编排链（切块/故事读取/重排器）只在真正索引时才载入，
  // 不给服务启动与房间回合的模块图增加负担（冷启动 +1.1s 实测）。
  const { indexStoryForRag } = await import('./indexOrchestration.js')
  const result = await indexStoryForRag(userId, String(scriptId), storyMeta, getEmbedding ? { getEmbedding } : {})
  return { ok: result.ok, indexed: result.indexed ?? 0, error: result.error, warning: result.warning }
}

/** GET /api/rag/stories — rag:listStories. */
export function listStories(userId: number): {
  storyId: string
  name: string
  chunkCount: number
  indexedAt: number
}[] {
  return vectorStore.listIndexedStories(userId)
}

/** POST /api/rag/story-overview — rag:storyOverview. */
export function storyOverview(
  userId: number,
  params: { storyId?: string; topK?: number } | undefined,
): { overview: string; storyName: string } {
  const { storyId, topK } = params || {}
  if (!storyId) return { overview: '', storyName: '' }
  return vectorStore.getStoryOverview(userId, storyId, topK ?? 15)
}

/** DELETE /api/rag/index/:scriptId — rag:delete (vectors only；M1-T7 起无图)。 */
export function deleteIndex(userId: number, scriptId: string): { ok: boolean; deleted: number } {
  return vectorStore.deleteChunks(userId, scriptId)
}

/** POST /api/rag/query — rag:query. */
export async function query(
  userId: number,
  params: { query?: string; scriptId?: string; sceneId?: string; type?: string; topK?: number } | undefined,
): Promise<{ chunks: { id: string; content: string; metadata: Record<string, unknown>; type: string; distance: number }[] }> {
  const { query: q, scriptId, sceneId, type, topK } = params || {}
  const getEmbedding = await buildGetEmbedding(userId)
  return vectorStore.queryChunks({
    userId,
    query: q ?? '',
    scriptId,
    sceneId,
    type,
    topK: topK ?? 5,
    getEmbedding: getEmbedding || undefined,
  })
}

/**
 * POST /api/rag/context — rag:context（**标准管线，无图扩展**，M1-T7 / ADR-0007 决策 3）。
 * 图 2 跳扩展已删除：无数量上限的扩展会把无关块灌进上下文，且档案已取代它的角色。
 * 本端点保留给客户端 RAG 调试页，形态 = 标准检索 + 装配渲染（与回合路径同一套零件）。
 */
export async function context(
  userId: number,
  params: { query?: string; scriptId?: string; sceneId?: string; topK?: number } | undefined,
): Promise<{ context: string; chunkCount?: number }> {
  const { query: q, scriptId, sceneId, topK } = params || {}
  const { buildSupplement } = await import('../rag/supplementService.js')
  const { renderBlock } = await import('../rag/supplementAssembly.js')
  const getEmbedding = await buildGetEmbedding(userId)
  const res = await buildSupplement(
    {
      userId,
      scriptId: scriptId ?? '',
      rawQuery: q ?? '',
      sceneName: sceneId,
      mode: 'plain',
      enabled: true,
      ...(topK && topK > 0 ? { rerankTopN: topK } : {}),
    },
    { getEmbedding: getEmbedding || undefined },
  )
  // 单块渲染走 renderBlock（跨场景前缀只在渲染层加，裸取 block.text 会丢标注）
  return { context: res.blocks.map(renderBlock).join('\n\n'), chunkCount: res.blocks.length }
}

/** GET /api/rag/index/:scriptId — rag:getIndex. */
export function getIndex(
  userId: number,
  scriptId: string,
): { scriptId: string; storyName: string; chunkCount: number; chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[] } {
  const storyInfo = vectorStore.listIndexedStories(userId).find((s) => s.storyId === scriptId)
  let chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[] = []
  try {
    const file = vectorStore.loadIndexFile(userId, scriptId)
    if (file) {
      chunks = (file.docs || []).map((d) => ({
        id: d.id,
        content: d.content,
        type: d.type,
        metadata: d.metadata || {},
        hasVector: Array.isArray(d.vector) && d.vector.length > 0,
      }))
    }
  } catch {
    // fall through with empty chunks (mirrors the original try/catch)
  }
  return {
    scriptId,
    storyName: storyInfo?.name || scriptId,
    chunkCount: chunks.length,
    chunks,
  }
}


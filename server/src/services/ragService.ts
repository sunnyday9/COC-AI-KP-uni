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
 *  - `rag:testGraphRagExtract` pushes per-batch `rag:progress` frames to the
 *    requesting user's live WS connections (decision 4/8; the original had no
 *    progress events, so only long tasks push — readStoryForRag arrives with
 *    Task 5).
 *  - Errors are classified (BadRequestError / UpstreamError) instead of bare
 *    IPC rejections; `rag:userGraph*` handlers return `{ ok }` per contract.
 */
import { chatForRag } from './aiService.js'
import { getSettings, getAiConfig } from './settingsService.js'
import { isMockAiMode } from '../config.js'
import type { AppSettings } from '../../../shared/types/settings.js'
import { assertSafeOutboundUrl } from '../utils/outboundUrl.js'
import { BadRequestError } from '../utils/errors.js'
import * as vectorStore from '../rag/vectorStore.js'
import * as graphStore from '../rag/graphStore.js'
import * as graphRag from '../rag/graphRag.js'
import * as userGraphStore from '../rag/userGraphStore.js'
import { createEmbedder, createBuiltinEmbedder, type Embedder } from '../rag/embedding.js'
import { buildExtractGraphPrompt, parseExtractOutput, COC_ENTITY_TYPES } from '../rag/prompts/cocExtractGraph.js'
import { pushRagProgress } from '../ws/progress.js'

const MAX_CHARS_PER_CALL = 2500
const BATCH_SIZE = 3

/* ═══════════════════ Embedding provider resolution ═══════════════════ */

/**
 * Build getEmbedding from settings. Always returns an embedding function
 * when possible; prefers the user API, otherwise falls back to the builtin
 * model (mirrors original buildGetEmbedding). An unsafe API baseUrl raises
 * BadRequestError (see module header).
 */
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

/** The graph extraction LLM closure for a user (model override from settings). */
function buildInvokeChat(userId: number): (params: {
  messages: { role: string; content: string }[]
  stream?: boolean
  temperature?: number
  maxTokens?: number
  model?: string
}) => Promise<{ content?: string }> {
  return (params) => chatForRag(userId, params)
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

/** POST /api/rag/test-graphrag-extract — rag:testGraphRagExtract (+ progress). */
export async function testGraphRagExtract(
  userId: number,
  params: { scriptId?: string; maxChunks?: number; maxBatches?: number } | undefined,
): Promise<Record<string, unknown>> {
  const { scriptId, maxChunks = 6, maxBatches = 3 } = params || {}
  if (!scriptId) return { ok: false, error: 'Missing scriptId' }

  const settings = getSettings(userId)
  const ragSettings = (settings?.rag || {}) as NonNullable<AppSettings["rag"]>
  const extractionModel = ragSettings.extractionModel || settings?.ai?.model || undefined

  const idxFile = vectorStore.loadIndexFile(userId, scriptId)
  if (!idxFile) {
    return { ok: false, error: 'rag_index not found for this scriptId' }
  }

  const docs = idxFile?.docs || []

  const sliceN = Math.max(0, Number.isFinite(Number(maxChunks)) ? Number(maxChunks) : 6)
  const limited = docs.slice(0, sliceN)

  if (!limited.length) {
    return { ok: true, scriptId, extractionModelUsed: extractionModel || settings?.ai?.model, totalBatches: 0, results: [] }
  }

  const invokeChat = buildInvokeChat(userId)

  const batches: { id: string; content: string; type?: string; metadata?: Record<string, unknown> }[][] = []
  let acc: { id: string; content: string; type?: string; metadata?: Record<string, unknown> }[] = []
  let accLen = 0
  for (const c of limited) {
    const text = (c?.content || '').trim()
    if (!text) continue
    if (accLen + text.length > MAX_CHARS_PER_CALL && acc.length > 0) {
      batches.push(acc)
      acc = []
      accLen = 0
    }
    acc.push({ id: c.id, content: c.content, type: c.type, metadata: c.metadata })
    accLen += text.length
    if (acc.length >= BATCH_SIZE) {
      batches.push(acc)
      acc = []
      accLen = 0
    }
  }
  if (acc.length) batches.push(acc)

  const tested = Math.min(batches.length, Math.max(0, Number(maxBatches) || 0))
  const results: Record<string, unknown>[] = []

  for (let bi = 0; bi < tested; bi++) {
    const batch = batches[bi] as { id: string; content: string }[]
    const chunkIds = batch.map((c) => c.id)
    const combined = batch.map((c) => c.content).join('\n\n---\n\n')

    // rag:progress — per-batch extraction progress (decision 4/8)
    pushRagProgress(userId, {
      stage: 'graph_extract',
      scriptId,
      percent: Math.round(((bi + 1) / tested) * 100),
      message: `测试抽取 batch ${bi + 1}/${tested}`,
    })

    const prompt = buildExtractGraphPrompt({ inputText: combined, entityTypes: COC_ENTITY_TYPES })
    try {
      const res = await invokeChat({
        messages: [
          { role: 'system', content: 'Output only the extracted entities and relationships. No other text.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        temperature: 0,
        maxTokens: 2048,
        model: extractionModel || undefined,
      })

      const rawOutput = (res?.content || '').trim()
      const parsed = parseExtractOutput(rawOutput)
      results.push({
        batchIndex: bi,
        chunkIds,
        extractionModelUsed: extractionModel || settings?.ai?.model || null,
        rawOutputPreview: rawOutput.slice(0, 900),
        hasTupleDelimiter: rawOutput.includes(' | '),
        entitiesCount: parsed.entities?.length ?? 0,
        relationsCount: parsed.relations?.length ?? 0,
        entitiesSample: (parsed.entities || []).slice(0, 10).map((e) => ({ name: e.name, type: e.type })),
        relationsSample: (parsed.relations || []).slice(0, 10).map((r) => ({ source: r.source, target: r.target, type: r.type })),
      })
    } catch (e) {
      results.push({
        batchIndex: bi,
        chunkIds,
        extractionModelUsed: extractionModel || settings?.ai?.model || null,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return {
    ok: true,
    scriptId,
    extractionModelUsed: extractionModel || settings?.ai?.model || null,
    totalBatches: batches.length,
    testedBatches: tested,
    results,
  }
}

/** POST /api/rag/index — rag:index (vectors + optional GraphRAG build). */
export async function index(
  userId: number,
  params: { scriptId?: string; chunks?: unknown; storyMeta?: { name?: string } } | undefined,
): Promise<{ ok: boolean; indexed: number }> {
  const { scriptId, chunks, storyMeta } = params || {}
  if (!scriptId || !Array.isArray(chunks)) {
    return { ok: false, indexed: 0 }
  }
  const getEmbedding = await buildGetEmbedding(userId)
  const options = getEmbedding ? { getEmbedding } : {}
  const vectorResult = await vectorStore.indexChunks(
    userId,
    scriptId,
    chunks as vectorStore.RAGChunkInput[],
    storyMeta,
    options,
  )
  const settings = getSettings(userId)
  const ragSettings = (settings?.rag || {}) as NonNullable<AppSettings["rag"]>
  const invokeChat = buildInvokeChat(userId)
  if (ragSettings.useGraphRAG !== false && typeof invokeChat === 'function') {
    await graphStore.indexGraph(userId, scriptId, chunks as graphStore.IndexGraphChunk[], storyMeta, {
      invokeChat,
      extractionModel: ragSettings.extractionModel || settings?.ai?.model || undefined,
    })
  }
  return vectorResult
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

/** DELETE /api/rag/index/:scriptId — rag:delete (vectors + graph). */
export function deleteIndex(userId: number, scriptId: string): { ok: boolean; deleted: number } {
  const vectorResult = vectorStore.deleteChunks(userId, scriptId)
  try {
    graphStore.deleteGraph(userId, scriptId)
  } catch {
    // graph deletion is best-effort (mirrors the original try/catch)
  }
  return vectorResult
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

/** POST /api/rag/context — rag:context (vector + graph expansion). */
export async function context(
  userId: number,
  params: { query?: string; scriptId?: string; sceneId?: string; topK?: number } | undefined,
): Promise<{ context: string; graphSummary?: string; chunkCount?: number }> {
  const { query: q, scriptId, sceneId, topK } = params || {}
  const settings = getSettings(userId)
  const useGraphRAG = settings?.rag?.useGraphRAG !== false
  const getEmbedding = await buildGetEmbedding(userId)
  return graphRag.buildContextWithGraph({
    userId,
    query: q ?? '',
    scriptId,
    sceneId,
    topK: topK ?? 5,
    getEmbedding: getEmbedding || undefined,
    useGraphRAG,
  })
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

/** GET /api/rag/graph/:scriptId — rag:getGraph. */
export function getGraph(
  userId: number,
  scriptId: string,
): {
  scriptId: string
  storyName: string
  indexedAt: number
  nodeCount: number
  edgeCount: number
  nodes: { id: string; type: string; name: string; content: string; communityId: string | null; chunkIds: string[] }[]
  edges: { source: string; target: string; type: string; label: string }[]
  communitySummaries: Record<string, string>
} | null {
  try {
    const graph = graphStore.getGraph(userId, scriptId)
    if (!graph) return null
    return {
      scriptId: graph.scriptId,
      storyName: graph.storyName,
      indexedAt: graph.indexedAt,
      nodeCount: graph.nodeCount || (graph.nodes || []).length,
      edgeCount: graph.edgeCount || (graph.edges || []).length,
      nodes: (graph.nodes || []).map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        content: n.content || '',
        communityId: n.communityId || null,
        chunkIds: n.chunkIds || [],
      })),
      edges: (graph.edges || []).map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        label: e.label || '',
      })),
      communitySummaries: graph.communitySummaries || {},
    }
  } catch {
    return null
  }
}

/** POST /api/rag/user-graph/event — rag:userGraphAdd. */
export function userGraphAdd(
  userId: number,
  params: { storyId?: string; sessionId?: string; event?: userGraphStore.UserGraphEvent } | undefined,
): void {
  const { storyId, sessionId, event } = params || {}
  if (!storyId || !sessionId || !event) return
  userGraphStore.addEvent(userId, storyId, sessionId, event)
}

/** POST /api/rag/user-graph/sync — rag:userGraphSync. */
export function userGraphSync(
  userId: number,
  params: { storyId?: string; sessionId?: string; state?: { cluesObtained?: unknown[]; currentScene?: string } } | undefined,
): void {
  const { storyId, sessionId, state } = params || {}
  if (!storyId || !sessionId) return
  userGraphStore.syncFromState(userId, storyId, sessionId, state)
}

/** POST /api/rag/user-graph/summary — rag:userGraphSummary. */
export function userGraphSummary(userId: number, params: { storyId?: string; sessionId?: string } | undefined): string {
  const { storyId, sessionId } = params || {}
  if (!storyId || !sessionId) return ''
  return userGraphStore.getSummary(userId, storyId, sessionId)
}

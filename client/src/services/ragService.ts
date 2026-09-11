/**
 * RAG Service — communicates with the backend vector store via the Platform
 * Bridge (replaces the Electron IPC `window.electronAPI.rag*` calls, Task 7).
 */
import { traceBus } from './tracing'
import { getBridge } from '../platform'

export interface RAGChunkResult {
  content: string
  metadata: Record<string, string>
  distance: number
}

export interface IndexedStory {
  storyId: string
  name: string
  chunkCount: number
  indexedAt: number
}

/** Check if RAG service is available */
export async function checkRagHealth(): Promise<boolean> {
  try {
    const r = await getBridge().ragHealth()
    return r?.status === 'ok'
  } catch {
    return false
  }
}

/** Index a story for RAG.
 *  M1-T3（issue #48）：切块搬到服务端——客户端只报 storyId，服务端自读原文、自切块、自嵌入。 */
export async function indexStory(
  storyId: string,
  storyMeta?: { name?: string },
): Promise<{ ok: boolean; indexed: number; error?: string; warning?: string }> {
  return getBridge().ragIndex({ scriptId: storyId, storyMeta })
}

/** Delete story index */
export async function deleteStoryIndex(storyId: string): Promise<{ ok: boolean; deleted: number }> {
  return getBridge().ragDelete(storyId)
}

/** List all indexed stories */
export async function listIndexedStories(): Promise<IndexedStory[]> {
  return getBridge().ragListStories()
}

/** Get story overview (initial context for game start) */
export async function getStoryOverview(storyId: string, topK = 15): Promise<{ overview: string; storyName: string }> {
  return getBridge().ragStoryOverview({ storyId, topK })
}

/** Query relevant chunks */
export async function queryChunks(params: {
  query: string
  scriptId?: string
  sceneId?: string
  type?: string
  topK?: number
}): Promise<{ chunks: RAGChunkResult[] }> {
  return getBridge().ragQuery({
    query: params.query,
    scriptId: params.scriptId,
    sceneId: params.sceneId,
    type: params.type,
    topK: params.topK ?? 5,
  })
}

/** Get formatted context for LLM prompt（M1-T7 起标准管线，无图扩展）。 */
export async function getContext(params: {
  query: string
  scriptId?: string
  sceneId?: string
  topK?: number
}): Promise<{ context: string; chunkCount?: number }> {
  traceBus.emit('rag_retrieval', 'rag_query_sent', {
    query: params.query,
    scriptId: params.scriptId,
    topK: params.topK ?? 5,
  })
  const result = await getBridge().ragContext({
    query: params.query,
    scriptId: params.scriptId,
    sceneId: params.sceneId,
    topK: params.topK ?? 5,
  })
  // hasUserGraph 字段在原 TraceEventMap 中为必填但原代码未传（原类型缺口，运行时不变）；
  // M1-T7 起无图，hasGraphSummary 恒 false（字段保留以免动 trace 契约）
  traceBus.emit('rag_retrieval', 'rag_context_received', {
    chunkCount: result?.chunkCount ?? 0,
    contextLength: result?.context?.length ?? 0,
    hasGraphSummary: false,
  } as unknown as Parameters<typeof traceBus.emit<'rag_context_received'>>[2])
  return result
}

/** Add user graph event (clue obtained, scene visited, etc.). */
export async function addUserGraphEvent(params: {
  storyId: string
  sessionId: string
  event: { type: 'clue' | 'scene' | 'action' | 'item' | 'npc'; name: string; description?: string }
}): Promise<void> {
  await getBridge().ragUserGraphAdd(params)
}

/** Sync user graph from game state (on load). */
export async function syncUserGraphFromState(params: {
  storyId: string
  sessionId: string
  state: { cluesObtained: { id: string; description: string }[]; currentScene: string }
}): Promise<void> {
  await getBridge().ragUserGraphSync(params)
}

/** Get full chunk index for a story (dev/inspector use). */
export async function getStoryIndex(scriptId: string) {
  return getBridge().ragGetIndex({ scriptId })
}

/**
 * Get user graph summary for memory/context.
 * Adjustment (api-contract §8): the endpoint returns `{ summary }`; unwrap
 * the string (the original IPC returned the string directly).
 */
export async function getUserGraphSummary(storyId: string, sessionId: string): Promise<string> {
  const r = await getBridge().ragUserGraphSummary({ storyId, sessionId })
  return r?.summary ?? ''
}

/**
 * Local GraphRAG — Microsoft GraphRAG-style pipeline.
 * Extract (LLM) → Community detection → Community summaries (LLM).
 * COC (Call of Cthulhu) domain specialization.
 * Persistence: RAG_DATA_DIR/<userId>/graph_index/{scriptId}.json
 *
 * Migrated from original/ai-trpg-web/electron/rag/graphStore.mjs.
 * Adjustments (task-4-brief decision 1): per-user isolation — every function
 * takes `userId` first, files live under RAG_DATA_DIR/<userId>/graph_index/,
 * and the in-memory cache is keyed `userId:scriptId`. Community detection
 * (union-find), community input building and summary generation are migrated
 * line-for-line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { RAG_DATA_DIR } from '../config.js'
import { extractGraphFromChunksLLM, type InvokeChatFn } from './graphExtractLLM.js'
import { buildCommunityReportPrompt } from './prompts/cocCommunityReport.js'

function getGraphIndexDir(userId: number): string {
  return path.join(RAG_DATA_DIR, String(userId), 'graph_index')
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function graphIndexPath(userId: number, scriptId: string): string {
  const safe = scriptId.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
  return path.join(getGraphIndexDir(userId), safe + '.json')
}

function loadGraph(userId: number, scriptId: string): StoredGraph | null {
  const p = graphIndexPath(userId, scriptId)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as StoredGraph
  } catch {
    return null
  }
}

function saveGraph(userId: number, scriptId: string, data: unknown): void {
  ensureDir(getGraphIndexDir(userId))
  fs.writeFileSync(graphIndexPath(userId, scriptId), JSON.stringify(data), 'utf-8')
}

function deleteGraphFile(userId: number, scriptId: string): boolean {
  const p = graphIndexPath(userId, scriptId)
  if (fs.existsSync(p)) {
    fs.unlinkSync(p)
    return true
  }
  return false
}

const memoryCache = new Map<string, StoredGraph>()

function cacheKey(userId: number, scriptId: string): string {
  return `${userId}:${scriptId}`
}

/* ------------------------------------------------------------------ */
/*  Graph data shapes (identical to the original on-disk JSON)         */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  id: string
  type: string
  name: string
  content: string
  chunkIds: string[]
  communityId?: string | null
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  label?: string
}

export interface StoredGraph {
  scriptId: string
  storyName: string
  indexedAt: number
  nodeCount: number
  edgeCount: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  communitySummaries: Record<string, string>
}

export interface StoryMetaForGraph {
  name?: string
}

/** A chunk as consumed by graph extraction (subset of RAGChunkInput). */
export interface IndexGraphChunk {
  id: string
  content: string
  type?: string
  metadata?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Community detection (union-find) — migrated line-for-line          */
/* ------------------------------------------------------------------ */

function computeCommunities(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string> {
  const idToIdx = new Map<string, number>()
  nodes.forEach((n, i) => idToIdx.set(n.id, i))
  const parent = nodes.map((_, i) => i)
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x] as number) as number
    return parent[x] as number
  }
  function union(a: string, b: string): void {
    const ra = find(idToIdx.get(a) as number)
    const rb = find(idToIdx.get(b) as number)
    if (ra != null && rb != null && ra !== rb) parent[ra] = rb
  }
  for (const e of edges || []) {
    if (e.source && e.target) union(e.source, e.target)
  }
  const result = new Map<string, string>()
  nodes.forEach((n, i) => result.set(n.id, `community_${find(i)}`))
  return result
}

function buildCommunityInput(nodes: GraphNode[], edges: GraphEdge[], communityId: string): string {
  const commNodes = nodes.filter((n) => n.communityId === communityId)
  const nodeIds = new Set(commNodes.map((n) => n.id))
  const commEdges = (edges || []).filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const lines = ['Entities:', ...commNodes.map((n) => `  ${n.name} (${n.type}): ${(n.content || '').slice(0, 80)}`)]
  lines.push('', 'Relationships:', ...commEdges.map((e) => {
    const src = nodeById.get(e.source)?.name || e.source
    const tgt = nodeById.get(e.target)?.name || e.target
    return `  ${src} --[${e.type}]--> ${tgt}`
  }))
  return lines.join('\n')
}

async function generateCommunitySummaries(
  nodes: GraphNode[],
  edges: GraphEdge[],
  invokeChat: InvokeChatFn,
  extractionModel?: string,
): Promise<Record<string, string>> {
  const summaries: Record<string, string> = {}
  const communityIds = [...new Set(nodes.map((n) => n.communityId).filter(Boolean))] as string[]
  const limit = Math.min(communityIds.length, 5)
  for (let i = 0; i < limit; i++) {
    const cid = communityIds[i] as string
    const input = buildCommunityInput(nodes, edges, cid)
    try {
      const prompt = buildCommunityReportPrompt({ inputText: input })
      const res = await invokeChat({
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0.3,
        maxTokens: 512,
        model: extractionModel || undefined,
      })
      summaries[cid] = (res?.content || '').trim().slice(0, 500)
    } catch {
      summaries[cid] = ''
    }
  }
  return summaries
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface IndexGraphOptions {
  invokeChat?: InvokeChatFn
  extractionModel?: string
}

/**
 * Index graph from chunks using LLM extraction. Used when Microsoft GraphRAG is not available.
 */
export async function indexGraph(
  userId: number,
  scriptId: string,
  chunks: IndexGraphChunk[] | undefined,
  storyMeta: StoryMetaForGraph | undefined,
  options: IndexGraphOptions = {},
): Promise<{ ok: boolean; nodeCount: number; edgeCount: number }> {
  if (!chunks?.length) {
    memoryCache.delete(cacheKey(userId, scriptId))
    deleteGraphFile(userId, scriptId)
    return { ok: true, nodeCount: 0, edgeCount: 0 }
  }

  const { invokeChat, extractionModel } = options || {}
  if (typeof invokeChat !== 'function') {
    return { ok: true, nodeCount: 0, edgeCount: 0 }
  }

  const result = await extractGraphFromChunksLLM({
    scriptId,
    storyMeta,
    chunks,
    invokeChat,
    extractionModel: extractionModel || undefined,
  })
  const nodes = result.nodes
  const edges = result.edges

  const communityIds = computeCommunities(nodes, edges)
  for (const n of nodes) {
    n.communityId = communityIds.get(n.id) ?? null
  }

  const communitySummaries = await generateCommunitySummaries(nodes, edges, invokeChat, extractionModel)
  const data: StoredGraph = {
    scriptId,
    storyName: (storyMeta?.name) || scriptId,
    indexedAt: Date.now(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    communitySummaries,
  }

  memoryCache.set(cacheKey(userId, scriptId), data)
  saveGraph(userId, scriptId, data)
  return { ok: true, nodeCount: nodes.length, edgeCount: edges.length }
}

export function getGraph(userId: number, scriptId: string): StoredGraph | null {
  const key = cacheKey(userId, scriptId)
  if (memoryCache.has(key)) return memoryCache.get(key) ?? null
  const loaded = loadGraph(userId, scriptId)
  if (loaded) {
    memoryCache.set(key, loaded)
    return loaded
  }
  return null
}

export function deleteGraph(userId: number, scriptId: string): { ok: boolean } {
  memoryCache.delete(cacheKey(userId, scriptId))
  deleteGraphFile(userId, scriptId)
  return { ok: true }
}

export function expandFromChunks(
  userId: number,
  scriptId: string,
  chunkIds: string[] | undefined,
  maxHops = 2,
): { nodeIds: string[]; chunkIds: string[] } {
  const graph = getGraph(userId, scriptId)
  if (!graph?.nodes?.length) return { nodeIds: [], chunkIds: chunkIds || [] }

  const chunkToNode = new Map<string, GraphNode>()
  for (const n of graph.nodes) {
    for (const cid of n.chunkIds || []) chunkToNode.set(cid, n)
  }

  let frontier = new Set<string>()
  for (const cid of chunkIds || []) {
    const node = chunkToNode.get(cid)
    if (node) frontier.add(node.id)
  }

  const seen = new Set(frontier)
  const edgesBySource = new Map<string, GraphEdge[]>()
  for (const e of graph.edges || []) {
    if (!edgesBySource.has(e.source)) edgesBySource.set(e.source, [])
    edgesBySource.get(e.source)!.push(e)
  }

  for (let h = 0; h < maxHops; h++) {
    const next = new Set<string>()
    for (const nid of frontier) {
      const out = edgesBySource.get(nid) || []
      for (const e of out) {
        if (!seen.has(e.target)) {
          seen.add(e.target)
          next.add(e.target)
        }
      }
      const inEdges = (graph.edges || []).filter((ee) => ee.target === nid)
      for (const e of inEdges) {
        if (!seen.has(e.source)) {
          seen.add(e.source)
          next.add(e.source)
        }
      }
    }
    frontier = next
    if (frontier.size === 0) break
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const expandedChunkIds = new Set(chunkIds || [])
  for (const nid of seen) {
    const n = nodeById.get(nid)
    if (n?.chunkIds) for (const cid of n.chunkIds) expandedChunkIds.add(cid)
  }

  return { nodeIds: Array.from(seen), chunkIds: Array.from(expandedChunkIds) }
}

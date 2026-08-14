/**
 * GraphRAG — Microsoft GraphRAG-style local system.
 * Uses COC-specialized prompts for extraction and query.
 * Pipeline: vector retrieval → graph expansion → local/global search synthesis.
 *
 * Migrated line-for-line from original/ai-trpg-web/electron/rag/graphRag.mjs.
 * Adjustments (task-4-brief decision 1): per-user isolation — `userId` is
 * threaded through the params and passed to vectorStore/graphStore.
 */
import * as vectorStore from './vectorStore.js'
import * as graphStore from './graphStore.js'

const CONTAIN_EDGE_TYPES = new Set(['contains', 'features', 'located_in', 'participates', 'mentions', '属于', '包含', '参与', '提及'])
const UNLOCK_EDGE_TYPES = new Set(['unlocks', 'triggers', 'depends_on', 'depends', '解锁', '触发', '依赖'])
const TRANSITION_EDGE_TYPES = new Set(['transitions_to', 'leads_to', '前往', '进入'])

function buildStructuredSummary(graph: graphStore.StoredGraph, chunks: { id: string; content: string }[], sceneId?: string): string {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const chunkIdToContent = new Map(chunks.map((c) => [c.id, c.content]))
  const edges = graph.edges || []
  const communitySummaries = graph.communitySummaries || {}
  const lines: string[] = []

  if (Object.keys(communitySummaries).length > 0) {
    lines.push('### 社区摘要')
    for (const [cid, summary] of Object.entries(communitySummaries)) {
      if (summary) lines.push(`- ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}`)
    }
    lines.push('')
  }

  const sceneNodes = graph.nodes.filter((n) => n.type === 'scene')
  const current = sceneId
    ? graph.nodes.find((n) => n.name === sceneId || n.id === `scene:${sceneId}`) ||
      sceneNodes.find((n) => n.name === sceneId || n.id === `scene:${sceneId}`)
    : sceneNodes[0] || graph.nodes[0]

  if (current) {
    const content = (current.chunkIds || [])
      .map((cid) => chunkIdToContent.get(cid))
      .filter(Boolean)[0]
    const typeLabel = current.type === 'scene' ? '场景' : current.type === 'clue' ? '线索' : '实体'
    lines.push(`### 当前${typeLabel}：${current.name || current.id}`)
    if (content) lines.push('- 描述：' + content.split('\n')[0]!.slice(0, 200) + (content.length > 200 ? '…' : ''))
    const containEdges = edges.filter((e) => e.source === current.id && CONTAIN_EDGE_TYPES.has(e.type))
    const targetNames = containEdges
      .map((e) => nodeById.get(e.target)?.name)
      .filter(Boolean)
      .slice(0, 10)
    if (targetNames.length) lines.push('- 关联：' + targetNames.join('、'))
    lines.push('')
  }

  const relatedItems: { name: string; requiresClue: string | null }[] = []
  if (current) {
    const transEdges = edges.filter((e) => e.source === current.id && TRANSITION_EDGE_TYPES.has(e.type))
    for (const e of transEdges.slice(0, 10)) {
      const target = nodeById.get(e.target)
      if (target) relatedItems.push({ name: target.name, requiresClue: null })
    }
    const unlockEdges = edges.filter((e) => e.type === 'unlocks' || UNLOCK_EDGE_TYPES.has(e.type))
    for (const e of unlockEdges.slice(0, 10)) {
      const src = nodeById.get(e.source)
      const tgt = nodeById.get(e.target)
      if (tgt && src) relatedItems.push({ name: tgt.name, requiresClue: src.name })
    }
  }
  if (relatedItems.length) {
    lines.push('### 关联节点')
    for (const r of relatedItems) {
      lines.push(r.requiresClue ? `- ${r.name}（需「${r.requiresClue}」后解锁）` : `- ${r.name}`)
    }
    lines.push('')
  }

  const clueTypeEdges = edges.filter((e) => (e.type === 'contains' || CONTAIN_EDGE_TYPES.has(e.type)) && nodeById.get(e.target)?.type === 'clue')
  const inScope = clueTypeEdges.filter((e) => !current || nodeById.get(e.source)?.id === current?.id)
  if (inScope.length) {
    lines.push('### 相关线索')
    for (const e of inScope.slice(0, 10)) {
      const clue = nodeById.get(e.target)
      if (clue) {
        const c = (clue.chunkIds || []).map((cid) => chunkIdToContent.get(cid)).filter(Boolean)[0]
        lines.push(`- ${clue.name}：${(c || '').slice(0, 80)}${(c || '').length > 80 ? '…' : ''}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

export interface BuildContextWithGraphParams {
  userId: number
  query: string
  scriptId?: string
  sceneId?: string
  topK?: number
  getEmbedding?: (text: string) => Promise<number[]>
  useGraphRAG?: boolean
}

/**
 * Build context. Uses graph expansion + structured summary (no LLM query call for context).
 * For LLM-synthesized context, would use buildLocalSearchPrompt/buildGlobalSearchPrompt.
 */
export async function buildContextWithGraph(
  params: BuildContextWithGraphParams,
): Promise<{ context: string; graphSummary?: string; chunkCount?: number }> {
  const { userId, query, scriptId, sceneId, topK = 5, getEmbedding, useGraphRAG = true } = params || {}

  const vecResult = await vectorStore.queryChunks({
    userId,
    query,
    scriptId,
    sceneId,
    topK,
    getEmbedding,
  })
  const vecChunks = vecResult.chunks || []
  if (!vecChunks.length) return { context: '', chunkCount: 0 }

  const graph = scriptId ? graphStore.getGraph(userId, scriptId) : null
  const useGraph = useGraphRAG && !!graph?.nodes?.length

  let chunkIds = vecChunks.map((c) => c.id).filter(Boolean)
  if (useGraph && chunkIds.length && scriptId) {
    const expanded = graphStore.expandFromChunks(userId, scriptId, chunkIds, 2)
    chunkIds = expanded.chunkIds
  }

  const allChunks = scriptId ? vectorStore.getChunksByIds(userId, scriptId, chunkIds) : []
  if (!allChunks.length) return { context: '', chunkCount: 0 }

  let context: string
  let graphSummary: string | undefined
  if (useGraph && graph && scriptId) {
    graphSummary = buildStructuredSummary(graph, allChunks, sceneId)
    const flatParts = allChunks.map((c, i) => `### [${i + 1}] ${c.type || 'info'}\n${c.content}`)
    context = '## 故事情报（含关系）\n\n' + graphSummary + '\n## 详细片段\n\n' + flatParts.join('\n\n')
  } else {
    const lines = ['## 剧本相关情报']
    for (let i = 0; i < allChunks.length; i++) {
      const c = allChunks[i] as { metadata?: Record<string, unknown>; type: string; content: string }
      const t = c.metadata?.type || c.type || 'info'
      lines.push('### [' + (i + 1) + '] ' + String(t))
      lines.push(c.content)
      lines.push('')
    }
    context = lines.join('\n')
  }

  return { context, graphSummary: graphSummary || undefined, chunkCount: allChunks.length }
}

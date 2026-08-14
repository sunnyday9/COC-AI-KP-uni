/**
 * LLM-based graph extraction using Microsoft GraphRAG-style prompts.
 * COC (Call of Cthulhu) domain specialization.
 *
 * Migrated line-for-line from
 * original/ai-trpg-web/electron/rag/graphExtractLLM.mjs. `invokeChat` is
 * injected by the caller (ragService) and routes through the AI service with
 * `assertSafeOutboundUrl` applied upstream (task-4-brief decision 3).
 */
import { buildExtractGraphPrompt, parseExtractOutput, COC_ENTITY_TYPES } from './prompts/cocExtractGraph.js'
import type { StoryMetaForGraph, GraphNode, GraphEdge } from './graphStore.js'

const MAX_CHARS_PER_CALL = 2500
const BATCH_SIZE = 3

export interface InvokeChatParams {
  messages: { role: string; content: string }[]
  stream?: boolean
  temperature?: number
  maxTokens?: number
  model?: string
}

export interface InvokeChatResult {
  content?: string
}

/** The LLM calling contract used by graph extraction (injected by ragService). */
export type InvokeChatFn = (params: InvokeChatParams) => Promise<InvokeChatResult>

function toNodeId(type: string, name: string): string {
  const safe = String(name || '').trim().replace(/[:\s|]+/g, '_') || 'unknown'
  return `${String(type || 'entity').toLowerCase()}:${safe}`
}

export async function extractGraphFromChunksLLM({
  scriptId,
  storyMeta,
  chunks,
  invokeChat,
  extractionModel,
}: {
  scriptId: string
  storyMeta?: StoryMetaForGraph
  chunks: { id: string; content: string; type?: string; metadata?: Record<string, unknown> }[] | undefined
  invokeChat: InvokeChatFn
  extractionModel?: string
}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; chunkToNode: Map<string, GraphNode> }> {
  const nodes: GraphNode[] = []
  const nodeById = new Map<string, GraphNode>()
  const chunkToNode = new Map<string, GraphNode>()
  const nameToNodeId = new Map<string, string>()

  function ensureNode(type: string, name: string, description: string, chunkIds: string[]): GraphNode {
    const id = toNodeId(type, name)
    if (nodeById.has(id)) {
      const n = nodeById.get(id) as GraphNode
      if (chunkIds?.length) {
        n.chunkIds = [...new Set([...(n.chunkIds || []), ...chunkIds])]
      }
      return n
    }
    const n: GraphNode = {
      id,
      type: String(type || 'entity').toLowerCase(),
      name: String(name || '').trim() || id,
      content: description || '',
      chunkIds: chunkIds || [],
    }
    nodes.push(n)
    nodeById.set(id, n)
    nameToNodeId.set(name, id)
    return n
  }

  if (!chunks?.length || typeof invokeChat !== 'function') {
    return { nodes, edges: [], chunkToNode }
  }

  const batches: { id: string; content: string; type?: string; metadata?: Record<string, unknown> }[][] = []
  let acc: { id: string; content: string; type?: string; metadata?: Record<string, unknown> }[] = []
  let accLen = 0
  for (const c of chunks) {
    const text = (c.content || '').trim()
    if (!text) continue
    if (accLen + text.length > MAX_CHARS_PER_CALL && acc.length > 0) {
      batches.push(acc)
      acc = []
      accLen = 0
    }
    acc.push(c)
    accLen += text.length
    if (acc.length >= BATCH_SIZE) {
      batches.push(acc)
      acc = []
      accLen = 0
    }
  }
  if (acc.length) batches.push(acc)

  const edges: GraphEdge[] = []
  for (const batch of batches) {
    const combined = batch.map((c) => c.content).join('\n\n---\n\n')
    const chunkIds = batch.map((c) => c.id)
    try {
      const prompt = buildExtractGraphPrompt({ inputText: combined, entityTypes: COC_ENTITY_TYPES })
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
      const content = (res?.content || '').trim()
      const { entities = [], relations = [] } = parseExtractOutput(content)

      for (const e of entities) {
        const name = (e.name || '').trim()
        if (!name) continue
        const type = (e.type || 'entity').trim().toLowerCase() || 'entity'
        ensureNode(type, name, e.description || '', chunkIds)
      }

      const firstNode = entities.length
        ? nodeById.get(toNodeId(entities[0]!.type, entities[0]!.name))
        : null
      for (const cid of chunkIds) {
        if (firstNode) chunkToNode.set(cid, firstNode)
      }

      for (const r of relations) {
        const srcName = (r.source || '').trim()
        const tgtName = (r.target || '').trim()
        if (!srcName || !tgtName) continue
        const srcId = nameToNodeId.get(srcName) || toNodeId('entity', srcName)
        const tgtId = nameToNodeId.get(tgtName) || toNodeId('entity', tgtName)
        if (!nodeById.has(srcId)) {
          const n = ensureNode('entity', srcName, '', chunkIds)
          nameToNodeId.set(srcName, n.id)
        }
        if (!nodeById.has(tgtId)) {
          const n = ensureNode('entity', tgtName, '', chunkIds)
          nameToNodeId.set(tgtName, n.id)
        }
        const finalSrcId = nameToNodeId.get(srcName) || srcId
        const finalTgtId = nameToNodeId.get(tgtName) || tgtId
        edges.push({
          source: finalSrcId,
          target: finalTgtId,
          type: (r.type || 'related').trim().toLowerCase() || 'related',
          label: r.description,
        })
      }
    } catch {
      // Skip batch on error
    }
  }

  return { nodes, edges, chunkToNode }
}

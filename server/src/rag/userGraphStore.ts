/**
 * User-centric session graph: records investigator actions, clues, scenes visited.
 * COC domain: obtained, visited, performed, met.
 *
 * Migrated from original/ai-trpg-web/electron/rag/userGraphStore.mjs.
 * Storage: the original persisted one JSON file per (storyId, sessionId)
 * under userData/session_graph; the server persists the identical JSON
 * document in the `user_graphs` table keyed (user_id, story_id, session_id)
 * (MIGRATION-PLAN Phase 3: "DB-backed, 替代 electron-store"; table created in
 * Task 1). All add/sync/summary semantics are migrated line-for-line; every
 * function additionally takes `userId` for isolation (decision 1).
 */
import { getDb } from '../db/index.js'

const ROOT_NODE_ID = 'investigator'

interface UserGraphNode {
  id: string
  type: string
  name: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: number
}

interface UserGraphEdge {
  source: string
  target: string
  type: string
  label: string
  createdAt: number
}

interface UserGraphData {
  storyId: string
  sessionId: string
  nodes: UserGraphNode[]
  edges: UserGraphEdge[]
  createdAt: number
  updatedAt?: number
}

export interface UserGraphEvent {
  type?: string
  name?: string
  description?: string
  metadata?: Record<string, unknown>
}

function loadGraph(userId: number, storyId: string, sessionId: string): UserGraphData | null {
  const row = getDb()
    .prepare('SELECT data FROM user_graphs WHERE user_id = ? AND story_id = ? AND session_id = ?')
    .get(userId, storyId, sessionId) as { data: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.data) as UserGraphData
  } catch {
    return null
  }
}

function saveGraph(userId: number, storyId: string, sessionId: string, data: UserGraphData): void {
  getDb()
    .prepare(
      `INSERT INTO user_graphs (user_id, story_id, session_id, data)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, story_id, session_id) DO UPDATE SET data = excluded.data`,
    )
    .run(userId, storyId, sessionId, JSON.stringify(data))
}

function toNodeId(type: string, name: string): string {
  const safe = String(name || '').trim().replace(/[:\s|]+/g, '_') || 'unknown'
  return `${String(type || 'entity').toLowerCase()}:${safe}`
}

/**
 * Add a user event to the session graph.
 * @param event - { type: 'clue'|'scene'|'action'|'item'|'npc', name, description?, metadata? }
 */
export function addEvent(userId: number, storyId: string, sessionId: string, event: UserGraphEvent): void {
  if (!storyId || !sessionId) return
  const { type, name, description = '', metadata = {} } = event || {}
  const nameStr = String(name || '').trim()
  if (!nameStr) return

  let data = loadGraph(userId, storyId, sessionId)
  if (!data) {
    data = {
      storyId,
      sessionId,
      nodes: [{ id: ROOT_NODE_ID, type: 'investigator', name: '调查员', content: '', createdAt: Date.now() }],
      edges: [],
      createdAt: Date.now(),
    }
  }

  const nodes = data.nodes || []
  const edges = data.edges || []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const nodeId = toNodeId(type || 'entity', nameStr)
  const now = Date.now()

  if (!nodeById.has(nodeId)) {
    nodes.push({
      id: nodeId,
      type: String(type || 'entity').toLowerCase(),
      name: nameStr,
      content: description,
      metadata,
      createdAt: now,
    })
  }

  const edgeType = type === 'clue' ? 'obtained' : type === 'scene' ? 'visited' : type === 'action' ? 'performed' : type === 'npc' ? 'met' : 'related'
  const existingEdge = edges.some(
    (e) => e.source === ROOT_NODE_ID && e.target === nodeId && e.type === edgeType
  )
  if (!existingEdge) {
    edges.push({
      source: ROOT_NODE_ID,
      target: nodeId,
      type: edgeType,
      label: description || '',
      createdAt: now,
    })
  }

  data.updatedAt = now
  data.nodes = nodes
  data.edges = edges
  saveGraph(userId, storyId, sessionId, data)
}

/**
 * Sync user graph from game state (e.g. on load). Ensures graph reflects cluesObtained and currentScene.
 */
export function syncFromState(
  userId: number,
  storyId: string,
  sessionId: string,
  state: { cluesObtained?: unknown[]; currentScene?: string } | undefined,
): void {
  if (!storyId || !sessionId) return
  const { cluesObtained = [], currentScene = '' } = state || {}

  let data = loadGraph(userId, storyId, sessionId)
  if (!data) {
    data = {
      storyId,
      sessionId,
      nodes: [{ id: ROOT_NODE_ID, type: 'investigator', name: '调查员', content: '', createdAt: Date.now() }],
      edges: [],
      createdAt: Date.now(),
    }
  }

  const nodes = data.nodes || []
  const edges = data.edges || []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const existingTargets = new Set(edges.filter((e) => e.source === ROOT_NODE_ID).map((e) => e.target))
  const now = Date.now()

  for (const clue of cluesObtained) {
    const nameStr = String(clue || '').trim()
    if (!nameStr) continue
    const nodeId = toNodeId('clue', nameStr)
    if (!nodeById.has(nodeId)) {
      nodes.push({ id: nodeId, type: 'clue', name: nameStr, content: '', createdAt: now })
    }
    if (!existingTargets.has(nodeId)) {
      edges.push({ source: ROOT_NODE_ID, target: nodeId, type: 'obtained', label: '', createdAt: now })
      existingTargets.add(nodeId)
    }
  }

  if (currentScene) {
    const nodeId = toNodeId('scene', currentScene)
    if (!nodeById.has(nodeId)) {
      nodes.push({ id: nodeId, type: 'scene', name: currentScene, content: '', createdAt: now })
    }
    if (!existingTargets.has(nodeId)) {
      edges.push({ source: ROOT_NODE_ID, target: nodeId, type: 'visited', label: '', createdAt: now })
      existingTargets.add(nodeId)
    }
  }

  data.nodes = nodes
  data.edges = edges
  data.updatedAt = now
  saveGraph(userId, storyId, sessionId, data)
}

/**
 * Get a text summary of the user graph for memory/context.
 */
export function getSummary(userId: number, storyId: string, sessionId: string): string {
  const data = loadGraph(userId, storyId, sessionId)
  if (!data?.nodes?.length) return ''

  const lines: string[] = []
  const edges = data.edges || []
  const nodeById = new Map((data.nodes || []).map((n) => [n.id, n]))

  const obtained = edges.filter((e) => e.type === 'obtained').map((e) => nodeById.get(e.target)?.name).filter(Boolean)
  const visited = edges.filter((e) => e.type === 'visited').map((e) => nodeById.get(e.target)?.name).filter(Boolean)
  const performed = edges.filter((e) => e.type === 'performed').map((e) => nodeById.get(e.target)?.name).filter(Boolean)
  const met = edges.filter((e) => e.type === 'met').map((e) => nodeById.get(e.target)?.name).filter(Boolean)

  if (obtained.length) lines.push('已获线索：' + obtained.join('、'))
  if (visited.length) lines.push('到访场景：' + visited.join('、'))
  if (performed.length) lines.push('关键行为：' + performed.join('、'))
  if (met.length) lines.push('接触NPC：' + met.join('、'))

  return lines.join('\n')
}

export function getGraph(userId: number, storyId: string, sessionId: string): UserGraphData | null {
  return loadGraph(userId, storyId, sessionId)
}

export function deleteUserGraph(userId: number, storyId: string, sessionId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM user_graphs WHERE user_id = ? AND story_id = ? AND session_id = ?')
    .run(userId, storyId, sessionId)
  return Number(result.changes) > 0
}

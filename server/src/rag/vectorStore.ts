/**
 * Pure JS Vector Store — TF-IDF + Cosine Similarity
 *
 * Replaces Python rag-service entirely. No external dependencies.
 * Designed for TRPG script chunks (Chinese + English text).
 *
 * Persistence: one JSON file per (userId, scriptId) under
 * RAG_DATA_DIR/<userId>/rag_index/
 *
 * Migrated from original/ai-trpg-web/electron/rag/vectorStore.mjs.
 * Adjustments (task-4-brief decision 1): data is isolated per user — every
 * function takes `userId` first; files live under RAG_DATA_DIR/<userId>/;
 * the in-memory cache is keyed `userId:scriptId`. All algorithms (TF-IDF
 * weights, cosine similarity, candidate-selection anti-spoiler policy) are
 * migrated line-for-line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { RAG_DATA_DIR } from '../config.js'

/* ------------------------------------------------------------------ */
/*  Persistence helpers                                                */
/* ------------------------------------------------------------------ */

function getIndexDir(userId: number): string {
  return path.join(RAG_DATA_DIR, String(userId), 'rag_index')
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function indexPath(userId: number, scriptId: string): string {
  const safe = scriptId.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
  return path.join(getIndexDir(userId), safe + '.json')
}

function loadIndex(userId: number, scriptId: string): StoredIndex | null {
  const p = indexPath(userId, scriptId)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as StoredIndex
  } catch {
    return null
  }
}

function saveIndex(userId: number, scriptId: string, data: unknown): void {
  ensureDir(getIndexDir(userId))
  fs.writeFileSync(indexPath(userId, scriptId), JSON.stringify(data), 'utf-8')
}

function deleteIndexFile(userId: number, scriptId: string): boolean {
  const p = indexPath(userId, scriptId)
  if (fs.existsSync(p)) {
    fs.unlinkSync(p)
    return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/*  Tokenization: character n-grams for Chinese + word tokens          */
/* ------------------------------------------------------------------ */

const STOP_CHARS = new Set('，。！？、；：\u201C\u201D\u2018\u2019【】（）《》「」\n\r\t .,!?;:()[]{}\"\'/\\|-_=+*&#@%^~`')

function tokenize(text: string): Map<string, number> {
  const tokens = new Map<string, number>()
  function inc(t: string): void {
    tokens.set(t, (tokens.get(t) || 0) + 1)
  }

  const chars: string[] = []
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci] as string
    if (!STOP_CHARS.has(ch)) chars.push(ch.toLowerCase())
  }

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string
    inc(c)
    if (i + 1 < chars.length) inc(c + (chars[i + 1] as string))
    if (i + 2 < chars.length) inc(c + (chars[i + 1] as string) + (chars[i + 2] as string))
  }

  const words = text.toLowerCase().match(/[a-z]{2,}/g)
  if (words) {
    for (let wi = 0; wi < words.length; wi++) inc(words[wi] as string)
  }

  return tokens
}

/* ------------------------------------------------------------------ */
/*  TF-IDF computation                                                 */
/* ------------------------------------------------------------------ */

function buildIdfFromDocs(docs: IndexDoc[]): Map<string, number> {
  const N = docs.length
  const df = new Map<string, number>()
  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di] as IndexDoc
    const seen = new Set<string>()
    const tfEntries = Array.from(doc.tf.entries())
    for (let ti = 0; ti < tfEntries.length; ti++) {
      const term = tfEntries[ti]![0]
      if (!seen.has(term)) {
        df.set(term, (df.get(term) || 0) + 1)
        seen.add(term)
      }
    }
  }
  const idf = new Map<string, number>()
  const dfEntries = Array.from(df.entries())
  for (let ii = 0; ii < dfEntries.length; ii++) {
    const t = dfEntries[ii]![0]
    const count = dfEntries[ii]![1]
    idf.set(t, Math.log((N + 1) / (count + 1)) + 1)
  }
  return idf
}

function tfidfVector(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vec = new Map<string, number>()
  let norm = 0
  const entries = Array.from(tf.entries())
  for (let i = 0; i < entries.length; i++) {
    const term = entries[i]![0]
    const freq = entries[i]![1]
    const w = freq * (idf.get(term) || 1)
    vec.set(term, w)
    norm += w * w
  }
  norm = Math.sqrt(norm) || 1
  const vecEntries = Array.from(vec.entries())
  for (let j = 0; j < vecEntries.length; j++) {
    vec.set(vecEntries[j]![0], (vecEntries[j]![1] as number) / norm)
  }
  return vec
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  const entries = Array.from(a.entries())
  for (let i = 0; i < entries.length; i++) {
    const wB = b.get(entries[i]![0])
    if (wB !== undefined) dot += entries[i]![1] * wB
  }
  return dot
}

/** Cosine similarity for dense vectors (number[]). Returns 0 if lengths differ or empty. */
function cosineSimilarityArray(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number)
    normA += (a[i] as number) * (a[i] as number)
    normB += (b[i] as number) * (b[i] as number)
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB)
  return norm > 0 ? dot / norm : 0
}

/* ------------------------------------------------------------------ */
/*  Types (on-disk + in-memory index)                                  */
/* ------------------------------------------------------------------ */

export interface RAGChunkInput {
  id: string
  content: string
  type?: string
  metadata?: Record<string, unknown>
}

export interface StoryMeta {
  name?: string
}

interface IndexDoc {
  id: string
  content: string
  type: string
  metadata: Record<string, unknown>
  tf: Map<string, number>
  tfidf: Map<string, number>
  vector?: number[]
}

interface StoredIndexDoc {
  id: string
  content: string
  type: string
  metadata: Record<string, unknown>
  tf: [string, number][]
  tfidf: [string, number][]
  vector?: number[]
}

interface StoredIndex {
  scriptId: string
  storyName: string
  indexedAt: number
  chunkCount: number
  docs: StoredIndexDoc[]
  idf: [string, number][]
}

interface LoadedIndex {
  scriptId: string
  storyName: string
  indexedAt: number
  chunkCount: number
  docs: IndexDoc[]
  idf: Map<string, number>
}

/* ------------------------------------------------------------------ */
/*  In-memory index (per-user, per-script)                             */
/* ------------------------------------------------------------------ */

const memoryCache = new Map<string, LoadedIndex>()

function cacheKey(userId: number, scriptId: string): string {
  return `${userId}:${scriptId}`
}

function getOrLoadIndex(userId: number, scriptId: string): LoadedIndex | null {
  const key = cacheKey(userId, scriptId)
  if (memoryCache.has(key)) return memoryCache.get(key) ?? null
  const saved = loadIndex(userId, scriptId)
  if (saved) {
    // Rehydrate Map shapes (same as the original: tf/tfidf/idf are stored as
    // entry arrays on disk and restored to Maps on load; vector stays number[]).
    for (let i = 0; i < saved.docs.length; i++) {
      const doc = saved.docs[i] as StoredIndexDoc
      ;(doc as unknown as { tf: Map<string, number> }).tf = new Map(doc.tf)
      ;(doc as unknown as { tfidf: Map<string, number> }).tfidf = new Map(doc.tfidf)
    }
    const loaded: LoadedIndex = {
      scriptId: saved.scriptId,
      storyName: saved.storyName,
      indexedAt: saved.indexedAt,
      chunkCount: saved.chunkCount,
      docs: saved.docs as unknown as IndexDoc[],
      idf: new Map(saved.idf),
    }
    memoryCache.set(key, loaded)
    return loaded
  }
  return null
}

function serializeIndex(idx: LoadedIndex): StoredIndex {
  return {
    scriptId: idx.scriptId,
    storyName: idx.storyName,
    indexedAt: idx.indexedAt,
    chunkCount: idx.chunkCount,
    docs: idx.docs.map(function (d) {
      const out: StoredIndexDoc = {
        id: d.id,
        content: d.content,
        type: d.type,
        metadata: d.metadata,
        tf: Array.from(d.tf.entries()),
        tfidf: Array.from(d.tfidf.entries()),
      }
      if (Array.isArray(d.vector)) out.vector = d.vector
      return out
    }),
    idf: Array.from(idx.idf.entries()),
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Index a batch of chunks for a story/script.
 * If options.getEmbedding (async (text) => number[]) is provided, computes and stores dense vectors per chunk (TF-IDF kept as fallback).
 */
export async function indexChunks(
  userId: number,
  storyId: string,
  chunks: RAGChunkInput[],
  storyMeta: StoryMeta | undefined,
  options: { getEmbedding?: (text: string) => Promise<number[]> } | undefined,
): Promise<{ ok: boolean; indexed: number }> {
  if (!chunks || !chunks.length) return { ok: true, indexed: 0 }

  const docs: IndexDoc[] = chunks.map(function (c) {
    const tf = tokenize(c.content || '')
    return {
      id: c.id,
      content: c.content,
      type: c.type || 'unknown',
      metadata: normalizeMetadata(c.metadata || {}, storyId),
      tf: tf,
      tfidf: new Map(),
      vector: undefined,
    }
  })

  const idf = buildIdfFromDocs(docs)
  for (let i = 0; i < docs.length; i++) {
    ;(docs[i] as IndexDoc).tfidf = tfidfVector((docs[i] as IndexDoc).tf, idf)
  }

  const getEmbedding = options && typeof options.getEmbedding === 'function' ? options.getEmbedding : null
  if (getEmbedding) {
    for (let j = 0; j < docs.length; j++) {
      try {
        ;(docs[j] as IndexDoc).vector = await getEmbedding((docs[j] as IndexDoc).content || '')
      } catch {
        // leave vector undefined; query will use TF-IDF for this doc
      }
    }
  }

  const storyName = (storyMeta && storyMeta.name) ? storyMeta.name : storyId
  const idx: LoadedIndex = {
    scriptId: storyId,
    storyName: storyName,
    indexedAt: Date.now(),
    chunkCount: docs.length,
    docs: docs,
    idf: idf,
  }
  memoryCache.set(cacheKey(userId, storyId), idx)
  saveIndex(userId, storyId, serializeIndex(idx))

  return { ok: true, indexed: docs.length }
}

/**
 * List all indexed stories for a user (reads metadata only).
 */
export function listIndexedStories(userId: number): { storyId: string; name: string; chunkCount: number; indexedAt: number }[] {
  const dir = getIndexDir(userId)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json') })
  const results: { storyId: string; name: string; chunkCount: number; indexedAt: number }[] = []
  for (let i = 0; i < files.length; i++) {
    try {
      const raw = fs.readFileSync(path.join(dir, files[i] as string), 'utf-8')
      const data = JSON.parse(raw) as StoredIndex
      const docsLen = (data.docs && data.docs.length) ? data.docs.length : 0
      results.push({
        storyId: data.scriptId || (files[i] as string).replace(/\.json$/, ''),
        name: data.storyName || data.scriptId || (files[i] as string).replace(/\.json$/, ''),
        chunkCount: docsLen,
        indexedAt: data.indexedAt || 0,
      })
    } catch {
      /* skip corrupt files */
    }
  }
  return results
}

/**
 * Get a story overview: retrieves the top chunks for general story context.
 */
export function getStoryOverview(userId: number, storyId: string, topK?: number): { overview: string; storyName: string } {
  if (topK === undefined) topK = 15
  const idx = getOrLoadIndex(userId, storyId)
  if (!idx || !idx.docs.length) return { overview: '', storyName: storyId }

  const limit = Math.min(topK, idx.docs.length)
  const chunks = idx.docs.slice(0, limit)
  const lines: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const label = (chunks[i] as IndexDoc).type || 'info'
    lines.push('[' + label + '] ' + (chunks[i] as IndexDoc).content)
  }
  return { overview: lines.join('\n\n'), storyName: idx.storyName || storyId }
}

/**
 * Delete all chunks for a script.
 */
export function deleteChunks(userId: number, scriptId: string): { ok: boolean; deleted: number } {
  const idx = getOrLoadIndex(userId, scriptId)
  const count = (idx && idx.docs && idx.docs.length) ? idx.docs.length : 0
  memoryCache.delete(cacheKey(userId, scriptId))
  deleteIndexFile(userId, scriptId)
  return { ok: true, deleted: count }
}

/**
 * Query for the top-K most relevant chunks.
 * If params.getEmbedding (async (text) => number[]) is provided, uses dense similarity when doc.vector exists; else TF-IDF. Hybrid index supported.
 */
export async function queryChunks(params: {
  userId: number
  query: string
  scriptId?: string
  sceneId?: string
  type?: string
  topK?: number
  getEmbedding?: (text: string) => Promise<number[]>
}): Promise<{ chunks: { id: string; content: string; metadata: Record<string, unknown>; type: string; distance: number }[] }> {
  const query = params.query
  const userId = params.userId
  const scriptId = params.scriptId
  const sceneId = params.sceneId
  const type = params.type
  const topK = params.topK || 5
  const getEmbedding = params.getEmbedding

  // 始终使用嵌入向量检索；若未提供 embedding，则不返回结果（不再回退到 TF-IDF）
  if (!getEmbedding || typeof getEmbedding !== 'function') {
    return { chunks: [] }
  }

  if (!scriptId) return { chunks: [] }
  const idx = getOrLoadIndex(userId, scriptId)
  if (!idx || !idx.docs.length) return { chunks: [] }

  let queryVector: number[] | null = null
  try {
    queryVector = await getEmbedding(query || '')
  } catch {
    queryVector = null
  }

  if (!queryVector || !Array.isArray(queryVector) || queryVector.length === 0) {
    return { chunks: [] }
  }

  // Candidate selection policy (anti-spoiler):
  // - If sceneId is provided, NEVER fall back to chunks from other scenes.
  // - Prefer in-scene chunks; if none exist, use "global" chunks that have no scene_id.
  // - type is a soft filter: if it would make results empty, ignore it (within the same base candidates).
  let baseCandidates = idx.docs
  if (sceneId) {
    const inScene = idx.docs.filter(function (d) {
      const meta = d.metadata || {}
      return meta.scene_id === sceneId || meta.sceneId === sceneId
    })
    const global = idx.docs.filter(function (d) {
      const meta = d.metadata || {}
      return !meta.scene_id && !meta.sceneId
    })
    baseCandidates = inScene.length > 0 ? inScene : global
  }

  let candidates = baseCandidates
  if (type) {
    const typed = baseCandidates.filter(function (d) { return d.type === type })
    if (typed.length > 0) candidates = typed
  }

  if (!candidates || candidates.length === 0) return { chunks: [] }

  const scored = candidates.map(function (doc) {
    let score = 0
    if (Array.isArray(doc.vector) && doc.vector.length === queryVector!.length) {
      score = cosineSimilarityArray(queryVector!, doc.vector)
    }
    return {
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      type: doc.type,
      distance: 1 - score,
    }
  })

  scored.sort(function (a, b) { return a.distance - b.distance })
  return { chunks: scored.slice(0, topK) }
}

/**
 * Build a formatted context string for the LLM prompt.
 */
export async function buildContext(params: {
  userId: number
  query: string
  scriptId?: string
  sceneId?: string
  topK?: number
  getEmbedding?: (text: string) => Promise<number[]>
}): Promise<{ context: string }> {
  const query = params.query
  const userId = params.userId
  const scriptId = params.scriptId
  const sceneId = params.sceneId
  const topK = params.topK || 5
  const getEmbedding = params.getEmbedding

  const result = await queryChunks({
    userId,
    query: query,
    scriptId: scriptId,
    sceneId: sceneId,
    topK: topK,
    getEmbedding: getEmbedding,
  })
  const chunks = result.chunks
  if (!chunks.length) return { context: '' }

  const lines = ['## 剧本相关情报']
  for (let i = 0; i < chunks.length; i++) {
    const meta = chunks[i]!.metadata || {}
    const t = meta.type || 'info'
    lines.push('### [' + (i + 1) + '] ' + String(t))
    lines.push(chunks[i]!.content)
    lines.push('')
  }
  return { context: lines.join('\n') }
}

/**
 * Get chunk content by ids (for graph expansion).
 */
export function getChunksByIds(
  userId: number,
  scriptId: string,
  chunkIds: string[],
): { id: string; content: string; type: string; metadata: Record<string, unknown> }[] {
  const idx = getOrLoadIndex(userId, scriptId)
  if (!idx || !chunkIds?.length) return []
  const idSet = new Set(chunkIds)
  return idx.docs
    .filter(function (d) { return idSet.has(d.id) })
    .map(function (d) {
      return {
        id: d.id,
        content: d.content,
        type: d.type,
        metadata: d.metadata || {},
      }
    })
}

/**
 * Health check - always available since this is in-process.
 */
export function checkHealth(userId: number): { status: string; service: string; indexedStoryCount: number } {
  const dir = getIndexDir(userId)
  let indexedStories: string[] = []
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json') })
      indexedStories = files
    }
  } catch {
    indexedStories = []
  }
  return {
    status: 'ok',
    service: 'rag-embedded',
    indexedStoryCount: indexedStories.length,
  }
}

/**
 * Read the raw persisted index file for a user+script (or null).
 * Mirrors the direct fs reads in the original ragHandlers.cjs
 * (rag:testGraphRagExtract / rag:getIndex); used by ragService.
 */
export function loadIndexFile(userId: number, scriptId: string): StoredIndex | null {
  return loadIndex(userId, scriptId)
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeMetadata(meta: Record<string, unknown>, scriptId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(meta)
  for (let i = 0; i < keys.length; i++) {
    out[keys[i] as string] = meta[keys[i] as string]
  }
  if (meta.scriptId) { out.script_id = meta.scriptId; delete out.scriptId }
  if (meta.sceneId) { out.scene_id = meta.sceneId; delete out.sceneId }
  if (meta.npcId) { out.npc_id = meta.npcId; delete out.npcId }
  if (!out.script_id) out.script_id = scriptId
  return out
}

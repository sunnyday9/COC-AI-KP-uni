/**
 * 检索补充层的服务端编排（M1-T5 / issue #49，spec #44 / ADR-0007）。
 *
 * 把零件串成"每回合一次标准检索 → 注入小节"：
 *   query 构造（T4）→ 嵌入 → 向量 top10 → 本地 cross-encoder 重排 top3（T2）
 *   → 注入装配（剧透硬闸 / 重叠剔除 / 场景内优先 / 跨场景 ≤1 / 1.6k 预算）
 *
 * 全部 IO 走注入缝（embeddings / 检索 / 重排 / gaps / 档案 / 改写），单测不触网、
 * 不加载模型、不落盘。**永不抛出**：任何一步失败都降级（空 candidates → 空小节），
 * 回合不因检索中断——与 `originalLookup`/`reranker` 的降级约定一致。
 *
 * 去重与排序都在装配层（纯函数）完成；本模块只负责"取到什么"。
 */
import { buildSceneQuery, retrieveWithRewrite, rewriteQuery, type RewriteFn } from './queryBuild.js'
import {
  assembleSupplement,
  retrieveSupplement,
  revealRegions,
  DEFAULT_RECALL_TOP_K,
  DEFAULT_RERANK_TOP_N,
  type AssembleResult,
  type RerankFn,
  type RetrieveFn,
  type SupplementCandidate,
} from './supplementAssembly.js'
import { loadGaps, type CoverageGaps } from './dossier/coverageGaps.js'
import { findScene } from './dossier/sceneLookup.js'
import { selectTop } from './reranker.js'
import type { StoryDossier } from './dossier/schema.js'
import type { Embedder } from './embedding.js'

/** 向量检索落地口（缺省 = vectorStore.queryChunks，distance → score 取反）。 */
export type VectorQuery = (params: {
  userId: number
  scriptId: string
  query: string
  topK: number
  getEmbedding?: Embedder
}) => Promise<{ chunks: { id: string; content: string; metadata: Record<string, unknown>; distance: number }[] }>

export interface SupplementDeps {
  /** 嵌入函数（缺省由调用方从 settings 构建；不传则检索无向量 → 空结果）。 */
  getEmbedding?: Embedder
  /** 向量检索（缺省 vectorStore.queryChunks）。 */
  queryVectors?: VectorQuery
  /** 重排（缺省 reranker.selectTop）。 */
  rerank?: RerankFn
  /** 档案 gaps（缺省 loadGaps；返回 null = 无档案锚点，归属全 none）。 */
  loadGaps?: () => Promise<CoverageGaps | null>
  /** 档案（缺省 loadDossier；用于真相锚点闸门与场景归一）。 */
  loadDossier?: () => Promise<StoryDossier | null>
  /** query 改写（缺省 = 不改写——仅当调用方显式提供时才走低分改写）。 */
  rewrite?: RewriteFn
  /** 低分改写阈值覆盖。 */
  rewriteThreshold?: number
  /** 诊断回调（KP_LLM_DEBUG 用）。 */
  onEvent?: (e: Record<string, unknown>) => void
}

export interface BuildSupplementInput {
  userId: number
  scriptId: string
  /** 本回合玩家合并发言原文（含 `【玩家名】` 前缀）。 */
  playerText?: string
  /** 当前场景名（房间 scene 字段或档案归一后的名字）。 */
  sceneName?: string
  /** 总开关（缺省开）。关闭 → 不检索、返回空。 */
  enabled?: boolean
  recallTopK?: number
  rerankTopN?: number
}

export interface SupplementResult extends AssembleResult {
  /** 实际使用的检索 query（诊断/报告用；**不得渲染进提示词**）。 */
  query: string
  /** 重排不可用 → 走了纯余弦降级。 */
  degraded: boolean
  /** 取消档 / 检索失败等降级原因。 */
  error?: string
  /** 命中的真相锚点区域数（剧透闸门的诊断值）。 */
  revealRegions: number
  durationMs: number
}

const EMPTY = (query = '', regionCount = 0): SupplementResult => ({
  section: '',
  blocks: [],
  chars: 0,
  droppedSpoiler: 0,
  droppedOverlap: 0,
  query,
  degraded: false,
  revealRegions: regionCount,
  durationMs: 0,
})

/** 默认向量检索：vectorStore.queryChunks + distance→score 取反。 */
async function defaultVectorQuery(params: {
  userId: number
  scriptId: string
  query: string
  topK: number
  getEmbedding?: Embedder
}): Promise<{ chunks: { id: string; content: string; metadata: Record<string, unknown>; distance: number }[] }> {
  const vectorStore = await import('./vectorStore.js')
  return vectorStore.queryChunks({
    userId: params.userId,
    query: params.query,
    scriptId: params.scriptId,
    topK: params.topK,
    getEmbedding: params.getEmbedding,
  })
}

/** 默认档案读取：动态导入（storyDossierService → storyService/annex → jsdom/pdf-lib，
 *  不该静态进回合模块图——同 indexOrchestration 的处理）。 */
async function defaultLoadDossier(userId: number, scriptId: string): Promise<StoryDossier | null> {
  const mod = await import('./dossier/storyDossierService.js')
  return mod.loadDossier(userId, scriptId)
}

/** 从索引元数据取块偏移：**只认真正的有限非负数**（`null`/缺失/字符串一律 NaN —— 
 *  `Number(null) === 0` 会把"无偏移"伪装成"原文开头"，从而骗过剧透闸门）。 */
function offsetOf(metadata: Record<string, unknown> | undefined): number {
  const v = (metadata ?? {}).start
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Number.NaN
}

/** 默认重排：reranker.selectTop（失败返回 null → 装配侧降级）。 */
const defaultRerank: RerankFn = (query, passages) => selectTop(query, passages, { topN: passages.length })

/**
 * 构建本回合的检索补充小节。永不抛出。
 *
 * 关闭开关时**不检索**（省掉嵌入 + 重排 + 档案读取的全部成本）。
 */
export async function buildSupplement(
  input: BuildSupplementInput,
  deps: SupplementDeps = {},
): Promise<SupplementResult> {
  const started = Date.now()
  const scriptId = String(input?.scriptId ?? '').trim()
  const userId = Number(input?.userId)
  if (input?.enabled === false || !scriptId || !Number.isFinite(userId)) return EMPTY()

  // 档案与 gaps 先读（剧透闸门与场景归一都需要；失败降级为 null = 无锚点，不阻断）
  let gaps: CoverageGaps | null = null
  let dossier: StoryDossier | null = null
  try {
    const [g, d] = await Promise.all([
      (deps.loadGaps ?? (() => loadGaps(userId, scriptId)))().catch(() => null),
      (deps.loadDossier ?? (() => defaultLoadDossier(userId, scriptId)))().catch(() => null),
    ])
    gaps = g
    dossier = d
  } catch {
    gaps = null
    dossier = null
  }
  const scene = dossier && input?.sceneName ? findScene(dossier, input.sceneName) : null
  const sceneName = scene?.name ?? String(input?.sceneName ?? '').trim()

  // query 构造（T4）：场景名 + 清洗后的玩家发言
  const { text: query, usedPlayerText } = buildSceneQuery({ sceneName, playerText: input?.playerText })
  if (!query) return EMPTY('', 0)

  const vectorQuery = deps.queryVectors ?? defaultVectorQuery
  const retrieve: RetrieveFn = async (q) => {
    const res = await vectorQuery({
      userId,
      scriptId,
      query: q,
      topK: Number.isFinite(input?.recallTopK) && input.recallTopK ? input.recallTopK : DEFAULT_RECALL_TOP_K,
      getEmbedding: deps.getEmbedding,
    })
    return (res?.chunks ?? []).map((c) => ({
      id: String(c.id),
      content: String(c.content ?? ''),
      start: offsetOf(c.metadata),
      // 相似度 = 1 - 距离（vectorStore 返回的是距离）
      score: 1 - (Number.isFinite(c.distance) ? c.distance : 1),
    }))
  }

  // 低分改写与重排共用同一份候选（`retrieval.chunks` 已带偏移，正是装配需要的形态）
  const retrieval = await retrieveWithRewrite({
    query,
    retrieve,
    rewrite: deps.rewrite,
    sceneName,
    threshold: deps.rewriteThreshold,
  })

  const topN = Number.isFinite(input?.rerankTopN) && input.rerankTopN ? input.rerankTopN : DEFAULT_RERANK_TOP_N
  const reranked = await retrieveSupplement({
    query: retrieval.query,
    retrieve: async () => retrieval.chunks,
    rerank: deps.rerank ?? defaultRerank,
    topN,
  })

  const assembled = assembleSupplement({
    candidates: reranked.candidates,
    gaps,
    dossier,
    currentScene: scene?.id ?? sceneName,
    enabled: true,
  })

  // 揭晓区域计数：装配层已算过一次（同一入参），这里复用其结果而不是重复算
  const regionCount = revealRegions(gaps, dossier).length
  const result: SupplementResult = {
    ...assembled,
    query: retrieval.query,
    degraded: reranked.degraded,
    error: retrieval.error ?? reranked.error,
    revealRegions: regionCount,
    durationMs: Date.now() - started,
  }
  // 诊断回调：抛错被吞（同 prefetch.onEvent 的处理），不影响回合
  try {
    deps.onEvent?.({
      scene: sceneName || undefined,
      query: retrieval.query,
      usedPlayerText,
      rewritten: retrieval.rewritten,
      recall: retrieval.chunks.length,
      kept: assembled.blocks.length,
      chars: assembled.chars,
      droppedSpoiler: assembled.droppedSpoiler,
      droppedOverlap: assembled.droppedOverlap,
      revealRegions: regionCount,
      degraded: reranked.degraded,
      error: result.error,
      durationMs: result.durationMs,
    })
  } catch {
    /* 追踪失败不影响回合 */
  }
  return result
}

/** 默认改写器：一次 LLM 调用（低分才触发，见 queryBuild.retrieveWithRewrite）。 */
export function defaultRewrite(userId: number, model?: string): RewriteFn {
  return (query, sceneName) => rewriteQuery(query, sceneName, { userId, model })
}

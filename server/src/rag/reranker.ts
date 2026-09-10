/**
 * 本地 cross-encoder 重排器（M1-T2 / issue #46，spec #44 / ADR-0007 决策 7）。
 *
 * 用途：向量检索取 top10 后做相关性重排，取 top3 注入（检索补充层）。
 *
 * ⚠️ **必须绕开 `pipeline('text-classification')`**（实测确认的静默失效）：
 * 本模型 ONNX 输出是 `[batch, 1]` 单 logit，而该 pipeline 内部对 logits 做 softmax——
 * 单元素 softmax 恒等于 1.0，所有候选得分全变 1、排序完全失效且不报错。
 * 因此这里直接用 `AutoModelForSequenceClassification` 取 logits 后 **sigmoid**；
 * pair 输入走 tokenizer 层（`text` 与 `text_pair` 需为等长数组）。
 *
 * 降级（ADR-0007 决策 7）：模型不可用 / 打分失败 → `{ ok: false }`，调用方退化为纯余弦排序，
 * **绝不抛出、绝不阻断回合**；`MOCK_AI=1` 下完全跳过模型加载与下载。
 *
 * 打分器可注入（`RerankScorer`）：单测用确定性假打分器，不触碰 279MB 模型。
 */
import { MODELS_DIR } from '../config.js'

/** 重排模型（q8 约 279MB；xlm-roberta 架构，transformers.js 原生支持）。 */
export const RERANK_MODEL_ID = 'onnx-community/bge-reranker-base-ONNX'
/** 重排后保留的条数（缺省）。 */
export const DEFAULT_RERANK_TOP_N = 3

/** 打分器：给定 query 与候选文本，返回等长的相关性分数（越大越相关）。 */
export type RerankScorer = (query: string, passages: string[]) => Promise<number[]>

export interface RerankResult {
  ok: boolean
  /** 降序排列；`index` 指向传入的 passages 下标。失败时为 undefined。 */
  ranked?: { index: number; score: number }[]
  error?: string
  /** 实际使用的打分来源（诊断用：'model' = 本地 cross-encoder）。 */
  source?: 'model'
}

export interface RerankOptions {
  /** 打分器注入（缺省 = 本地模型；`MOCK_AI` 下缺省即降级）。 */
  scorer?: RerankScorer
  /** 截断条数，缺省 DEFAULT_RERANK_TOP_N。 */
  topN?: number
}

export function isMockAiMode(): boolean {
  const v = String(process.env.MOCK_AI ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/* ── 本地模型：单例 + 惰性加载（照 embedding.ts 的 MODELS_DIR/单例模式） ── */

type RerankModelHandle = {
  tokenizer: (text: string[], opts: Record<string, unknown>) => Promise<unknown>
  model: (inputs: unknown) => Promise<{ logits?: { sigmoid?: () => { tolist?: () => number[][] }; tolist?: () => number[][] } }>
}

let modelPromise: Promise<RerankModelHandle | null> | null = null

/** 是否已加载（测试与诊断用）。 */
export function isRerankerLoaded(): boolean {
  return modelPromise !== null
}

/** 加载本地重排模型（单例；失败返回 null → 调用方降级）。 */
export async function loadRerankModel(): Promise<RerankModelHandle | null> {
  if (isMockAiMode()) return null
  if (!modelPromise) {
    modelPromise = (async () => {
      try {
        const mod = (await import('@huggingface/transformers')) as Record<string, unknown>
        const env = mod.env as { cacheDir?: string } | undefined
        if (env && typeof env === 'object') env.cacheDir = MODELS_DIR
        const AutoTokenizer = mod.AutoTokenizer as { from_pretrained: (id: string) => Promise<unknown> }
        const AutoModelForSequenceClassification = mod.AutoModelForSequenceClassification as {
          from_pretrained: (id: string, opts?: Record<string, unknown>) => Promise<unknown>
        }
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(RERANK_MODEL_ID),
          // dtype q8：model_quantized.onnx（279MB）；fp32 对部分 reranker 是外挂数据桩，不可用
          AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, { dtype: 'q8' }),
        ])
        return { tokenizer: tokenizer as RerankModelHandle['tokenizer'], model: model as RerankModelHandle['model'] }
      } catch {
        return null
      }
    })()
  }
  return modelPromise
}

/** 测试用：清空单例缓存。 */
export function _resetRerankModelForTests(): void {
  modelPromise = null
}

/**
 * 本地模型打分：逐批 (query, passage) 取 logits → **sigmoid**（不是 softmax）。
 * 任何异常向上抛，由 rerank() 统一转为 ok:false。
 */
async function modelScorer(query: string, passages: string[]): Promise<number[]> {
  const handle = await loadRerankModel()
  if (!handle) throw new Error('rerank model unavailable')
  const inputs = (await handle.tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  })) as unknown
  const out = await handle.model(inputs)
  const logits = out?.logits
  if (!logits) throw new Error('rerank model returned no logits')
  // 单 logit 必须 sigmoid：pipeline('text-classification') 的 softmax 会恒返回 1.0
  const probs = typeof logits.sigmoid === 'function' ? logits.sigmoid() : logits
  const rows = (typeof probs.tolist === 'function' ? probs.tolist() : []) as number[][]
  return rows.map((r) => (Array.isArray(r) && r.length > 0 ? Number(r[0]) : 0))
}

/**
 * 重排：`passages` 按与 `query` 的相关性降序，截断 topN。
 * 失败（模型不可用 / 打分抛错 / 分数长度不符）→ `{ ok: false }`，调用方退化。
 */
export async function rerank(query: string, passages: string[], options: RerankOptions = {}): Promise<RerankResult> {
  const texts = (passages ?? []).map((p) => String(p ?? ''))
  const topN = Number.isFinite(options.topN) && (options.topN as number) > 0 ? (options.topN as number) : DEFAULT_RERANK_TOP_N
  if (String(query ?? '').trim().length === 0 || texts.length === 0) {
    return { ok: true, ranked: [] }
  }
  // 全空候选：没有可排序的东西
  if (texts.every((t) => t.trim().length === 0)) return { ok: true, ranked: [] }

  if (!options.scorer && isMockAiMode()) {
    return { ok: false, error: 'mock mode: rerank skipped' }
  }
  const scorer: RerankScorer = options.scorer ?? modelScorer
  let scores: number[]
  try {
    scores = await scorer(String(query), texts)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!Array.isArray(scores) || scores.length !== texts.length) {
    return { ok: false, error: `rerank scorer returned ${Array.isArray(scores) ? scores.length : 'non-array'} scores for ${texts.length} passages` }
  }
  const ranked = texts
    .map((_, index) => ({ index, score: Number(scores[index]) || 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topN)
  return { ok: true, ranked, source: options.scorer ? undefined : 'model' }
}

/**
 * 调用方便捷入口：重排成功返回截断后的 `{index, score}[]`；失败返回 null
 * （调用方据此退化为纯余弦 topN，不阻断回合）。
 */
export async function selectTop(
  query: string,
  passages: string[],
  options: RerankOptions = {},
): Promise<{ index: number; score: number }[] | null> {
  const res = await rerank(query, passages, options)
  return res.ok ? res.ranked ?? [] : null
}

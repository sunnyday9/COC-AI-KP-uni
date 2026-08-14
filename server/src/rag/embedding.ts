/**
 * Embedding for RAG: built-in local model (default) or user's OpenAI-compatible API.
 *
 * Migrated from original/ai-trpg-web/electron/rag/embedding.mjs.
 * Adjustments (task-4-brief decision 2):
 *  - builtin mode points the transformers.js model cache at `MODELS_DIR`
 *    (server/data/models) instead of the process cwd default;
 *  - outbound URL safety is NOT enforced here — callers (ragService) apply
 *    `assertSafeOutboundUrl` before creating an API embedder (single choke
 *    point, consistent with the AI chat path).
 */

import { MODELS_DIR } from '../config.js'

const DEFAULT_API_MODEL = 'text-embedding-3-small'
/**
 * Chinese sentence embedding (text2vec); ONNX model for Transformers.js.
 *
 * ADJUSTMENT vs original embedding.mjs: the original id
 * `shibing624/text2vec-base-chinese-sentence` points at a repo that contains
 * PyTorch weights only (no onnx/ export) — transformers.js fails with
 * "Could not locate file .../onnx/model.onnx" (verified on 3.5.0 and 3.8.1).
 * `Xenova/text2vec-base-chinese-sentence` is the same model exported to ONNX
 * by the canonical transformers.js mirror org; embeddings are equivalent.
 * (See task-4-report.md — original code bug observation.)
 */
const BUILTIN_MODEL_ID = 'Xenova/text2vec-base-chinese-sentence'

let builtinPipeline: unknown = null

/** A text → dense vector function (normalized). */
export type Embedder = (text: string) => Promise<number[]>

/**
 * Preloaded default: local model via @huggingface/transformers (no API key).
 * Lazy-loads on first use. Returns null if the optional dependency is not available.
 * @returns Promise<Embedder | null>
 */
export async function createBuiltinEmbedder(): Promise<Embedder | null> {
  try {
    const mod = await import('@huggingface/transformers')
    const pipeline = (mod as { pipeline: (...args: unknown[]) => Promise<unknown> }).pipeline
    // Cache the model under server/data/models (decision 2); the module-level
    // builtinPipeline cache keeps the pipeline loaded across calls.
    const env = (mod as { env?: { cacheDir?: string } }).env
    if (env && typeof env === 'object') {
      env.cacheDir = MODELS_DIR
    }
    if (!builtinPipeline) {
      builtinPipeline = await pipeline('feature-extraction', BUILTIN_MODEL_ID)
    }
    const extractor = builtinPipeline
    return async function getEmbedding(text: string): Promise<number[]> {
      if (!text || typeof text !== 'string') return []
      const t = text.slice(0, 8192)
      const output = await (extractor as (text: string, opts: Record<string, unknown>) => Promise<{ data?: unknown }>)(t, { pooling: 'mean', normalize: true })
      const data = output && output.data
      if (data && typeof (data as { forEach?: unknown }).forEach === 'function') {
        return Array.from(data as ArrayLike<number>)
      }
      if (Array.isArray(data)) return data
      return []
    }
  } catch {
    return null
  }
}

/**
 * User-provided API: OpenAI-compatible /v1/embeddings.
 * @param config { baseUrl: string, apiKey: string, model?: string }
 * @returns Embedder | null
 */
export function createEmbedder(config: { baseUrl?: string; apiKey?: string; model?: string }): Embedder | null {
  const baseUrl = (config?.baseUrl || '').replace(/\/$/, '')
  const apiKey = config?.apiKey
  const model = config?.model || DEFAULT_API_MODEL

  if (!baseUrl || !apiKey) {
    return null
  }

  return async function getEmbedding(text: string): Promise<number[]> {
    if (!text || typeof text !== 'string') return []
    const url = `${baseUrl}/v1/embeddings`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text.slice(0, 8192),
      }),
    })
    if (!res.ok) {
      const err = new Error(`Embedding API ${res.status}: ${res.statusText}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    const json = (await res.json()) as { data?: { embedding?: unknown }[] }
    const embedding = json?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) throw new Error('Invalid embedding response')
    return embedding as number[]
  }
}

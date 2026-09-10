/**
 * 索引编排（M1-T3 / issue #48，spec #44 决策 4 / ADR-0007 决策 4）。
 *
 * 索引从"客户端切好块上传"改为"服务端自读自切"：
 *   故事 id → 读原文（readStoryForRag）→ 递归切块（chunker）→ 逐块嵌入 → 落盘（块带字符偏移）。
 *
 * 与旧路由行为的差别（有意断代，无兼容层）：请求体不再收 chunks；客户端切块器随票删除；
 * 存量索引不迁移（按新管线重建）。
 *
 * 索引期顺带**预取重排模型**（重排器加载即下载/常驻）：失败只记告警，绝不影响索引成功——
 * 检索侧的降级由重排器自己负责（ok:false → 纯余弦）。
 */
import { readStoryForRag } from './storyService.js'
import * as vectorStore from '../rag/vectorStore.js'
import { chunkStoryText } from '../rag/chunker.js'
import { loadRerankModel } from '../rag/reranker.js'
import { logger } from '../utils/logging.js'

export interface IndexOptions {
  /** 嵌入函数（缺省由调用方按设置提供；不传则索引只有词面统计）。 */
  getEmbedding?: (text: string) => Promise<number[]>
  /** 故事展示名（缺省取自读取结果）。 */
  storyMeta?: { name?: string }
}

export interface IndexResult {
  ok: boolean
  indexed?: number
  error?: string
  /** 非致命问题（如重排模型预取失败）。 */
  warning?: string
}

/**
 * 服务端索引编排：读原文 → 切块（带偏移）→ 嵌入 → 落盘；预取重排模型（非致命）。
 * 永不抛出：失败以 `{ok:false, error}` 返回。
 */
export async function indexStoryForRag(
  userId: number,
  scriptId: string,
  storyMeta?: { name?: string },
  options: IndexOptions = {},
): Promise<IndexResult> {
  const id = String(scriptId ?? '').trim()
  if (!id) return { ok: false, error: 'scriptId required' }

  let raw: { name: string; content: string }
  try {
    raw = await readStoryForRag(userId, id)
  } catch (e) {
    return { ok: false, error: `story not readable: ${e instanceof Error ? e.message : String(e)}` }
  }
  const text = String(raw?.content ?? '')
  if (text.trim().length === 0) return { ok: false, error: 'story content is empty' }

  const chunks = chunkStoryText(text)
  if (chunks.length === 0) return { ok: false, error: 'story content is empty' }

  const inputs = chunks.map((c, i) => ({
    id: `${id}-chunk-${i}`,
    content: c.content,
    type: 'rule',
    // 字符偏移供查询期"场景归属"现算（块不写死场景）
    metadata: { storyId: id, chunkIndex: i, start: c.start },
  }))

  const stored = await vectorStore.indexChunks(
    userId,
    id,
    inputs,
    { name: storyMeta?.name ?? raw.name },
    options.getEmbedding ? { getEmbedding: options.getEmbedding } : undefined,
  )

  // 预取重排模型（非致命）：让首次检索不必等冷启；失败仅告警
  let warning: string | undefined
  try {
    await loadRerankModel()
  } catch (e) {
    warning = `rerank model prefetch failed: ${e instanceof Error ? e.message : String(e)}`
    logger.warn('rag:index rerank prefetch failed', { userId, scriptId: id, error: warning })
  }

  return { ok: stored.ok, indexed: stored.indexed, warning }
}

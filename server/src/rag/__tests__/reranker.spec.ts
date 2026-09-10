/**
 * 本地 cross-encoder 重排器 spec（M1-T2 / issue #46，TDD）。
 *
 * 契约（spec #44 / ADR-0007 决策 7）：
 *  - `rerank(query, passages, opts)` → 按相关性降序的 `{ index, score }[]`（至多 topN）；
 *  - **打分器可注入**（单测用假打分器，不下载模型）；
 *  - **降级**：模型不可用 → 返回 `{ ok: false }`（调用方退化为纯余弦），绝不抛出；
 *  - `MOCK_AI=1` → 不加载/不下载模型；
 *  - 排序稳定性：同分保持传入顺序。
 *
 * ⚠️ 真实模型路径的关键约束（实测确认）：该模型 ONNX 输出是 `[batch,1]` 单 logit，
 * transformers.js 的 `pipeline('text-classification')` 会对其做 softmax——
 * 单元素 softmax 恒等于 1.0（**静默失效**）。因此实现必须直接取 logits 后 sigmoid。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  rerank,
  selectTop,
  DEFAULT_RERANK_TOP_N,
  RERANK_MODEL_ID,
  type RerankScorer,
} from '../reranker.js'

/** 假打分器：按关键词出现次数给分（确定性、可排序）。 */
function keywordScorer(keyword: string): RerankScorer {
  return async (_query, passages) =>
    passages.map((p) => (p.match(new RegExp(keyword, 'g')) ?? []).length)
}

describe('reranker: 排序与截断', () => {
  it('按分数降序返回，且带原始下标（供调用方取回块）', async () => {
    const passages = ['无关的段落', '关键词 关键词 关键词', '关键词 一次']
    const res = await rerank('query', passages, { scorer: keywordScorer('关键词') })
    expect(res.ok).toBe(true)
    expect(res.ranked?.map((r) => r.index)).toEqual([1, 2, 0])
    expect(res.ranked?.[0]?.score).toBe(3)
  })

  it('topN 截断（缺省取 3）', async () => {
    const passages = ['关键词', '关键词关键词', '关键词关键词关键词', '关键词关键词关键词关键词']
    const all = await rerank('q', passages, { scorer: keywordScorer('关键词') })
    expect(all.ranked?.length).toBe(DEFAULT_RERANK_TOP_N)
    const only2 = await rerank('q', passages, { scorer: keywordScorer('关键词'), topN: 2 })
    expect(only2.ranked?.map((r) => r.index)).toEqual([3, 2])
  })

  it('同分保持传入顺序（稳定排序）', async () => {
    const passages = ['平', '平', '平']
    const res = await rerank('q', passages, { scorer: keywordScorer('不存在') })
    expect(res.ranked?.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('空候选 → ok 且空结果（不调用打分器）', async () => {
    const scorer = vi.fn(keywordScorer('x'))
    const res = await rerank('q', [], { scorer })
    expect(res.ok).toBe(true)
    expect(res.ranked).toEqual([])
    expect(scorer).not.toHaveBeenCalled()
  })

  it('空 query 或全空候选 → 安全返回', async () => {
    expect((await rerank('', ['甲'], { scorer: keywordScorer('x') })).ranked).toEqual([])
    expect((await rerank('q', ['', '  '], { scorer: keywordScorer('x') })).ranked).toEqual([])
  })
})

describe('reranker: 降级与语义', () => {
  it('打分器抛错 → ok:false（不抛出），调用方可退化', async () => {
    const scorer: RerankScorer = async () => {
      throw new Error('model load failed')
    }
    const res = await rerank('q', ['甲'], { scorer })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('model load failed')
    expect(res.ranked).toBeUndefined()
  })

  it('打分器返回长度不符 → ok:false（防御性，不静默错排）', async () => {
    const scorer: RerankScorer = async () => [1] // 3 个候选只回 1 分
    const res = await rerank('q', ['甲', '乙', '丙'], { scorer })
    expect(res.ok).toBe(false)
  })

  it('无打分器注入且 MOCK_AI=1 → 不加载模型，直接降级', async () => {
    vi.stubEnv('MOCK_AI', '1')
    try {
      const res = await rerank('q', ['甲', '乙'])
      expect(res.ok).toBe(false)
      expect(res.error).toContain('mock')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('模型缺失路径（loadRerankModel 返回 null）→ 降级且错误信息可诊断', async () => {
    // 直接测 modelScorer 的真实失败路径：把动态 import 的模块替换为缺 AutoTokenizer 的桩，
    // 使 loadRerankModel 抛错（而不是走 MOCK_AI 早退）。
    vi.resetModules()
    vi.doMock('@huggingface/transformers', () => ({ env: {} }))
    try {
      const fresh = await import('../reranker.js')
      fresh._resetRerankModelForTests()
      const res = await fresh.rerank('q', ['甲', '乙'])
      expect(res.ok).toBe(false)
      // 保留原始错误信息（不再是笼统的 "unavailable"）
      expect(String(res.error).length).toBeGreaterThan(0)
    } finally {
      vi.doUnmock('@huggingface/transformers')
      vi.resetModules()
    }
  })

  it('加载失败不永久化：下次调用会重试（不是一次失败终生降级）', async () => {
    vi.resetModules()
    let attempts = 0
    vi.doMock('@huggingface/transformers', () => ({
      env: {},
      get AutoTokenizer() {
        attempts++
        throw new Error('transient failure')
      },
    }))
    try {
      const fresh = await import('../reranker.js')
      fresh._resetRerankModelForTests()
      await fresh.rerank('q', ['甲'])
      await fresh.rerank('q', ['甲'])
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      vi.doUnmock('@huggingface/transformers')
      vi.resetModules()
    }
  })
})

describe('reranker: selectTop（调用方工具）', () => {
  it('重排成功 → 按重排结果取块；失败 → 返回 null 让调用方走余弦兜底', async () => {
    const passages = ['a', '关键词 b', 'c']
    const ok = await selectTop('q', passages, { scorer: keywordScorer('关键词') })
    expect(ok?.map((r) => r.index)).toEqual([1, 0, 2])
    const failed = await selectTop('q', passages, {
      scorer: async () => {
        throw new Error('boom')
      },
    })
    expect(failed).toBeNull()
  })
})

describe('reranker: 模型标识', () => {
  it('默认模型为 onnx-community 的 bge-reranker-base（q8）', () => {
    expect(RERANK_MODEL_ID).toBe('onnx-community/bge-reranker-base-ONNX')
  })
})

/**
 * 真实模型冒烟（默认跳过：首次运行要下 279MB 并加载 ~90s）。
 * 手动跑：RERANK_SMOKE=1 npx vitest run src/rag/__tests__/reranker.spec.ts
 * 价值：钉住"Sigmoid 路径真的能区分相关/无关"——这是 pipeline softmax 静默失效的反面证据。
 */
const smoke = process.env.RERANK_SMOKE === '1' ? it : it.skip
describe('reranker: 真实模型冒烟', () => {
  smoke(
    '相关段落得分显著高于无关段落（sigmoid 生效，非全 1.0）',
    async () => {
      const query = '祭坛上刻着什么样的纹样？'
      const passages = [
        '钟楼地下室的门被木板钉死，墙上有六道抓痕。',
        '祭坛边缘的石座上刻着三颗眼状纹样，香炉里积着黑色的灰。',
        '旅馆前台的登记簿上有三个名字被划掉了。',
      ]
      const res = await rerank(query, passages)
      expect(res.ok).toBe(true)
      expect(res.ranked?.[0]?.index).toBe(1)
      const scores = res.ranked?.map((r) => r.score) ?? []
      expect(new Set(scores).size).toBeGreaterThan(1)
      expect(Math.max(...scores)).toBeGreaterThan(0.5)
      expect(Math.min(...scores)).toBeLessThan(0.5)
      // sigmoid 值域钉住：若误用原始 logits（或 pipeline softmax 全 1.0），分数会跑出 [0,1]
      for (const s of scores) {
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    },
    180_000,
  )
})

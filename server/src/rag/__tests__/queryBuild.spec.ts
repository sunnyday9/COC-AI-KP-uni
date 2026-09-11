/**
 * 检索 query 构造与低分改写 spec（M1-T4 / issue #47，TDD）。
 *
 * 契约（spec #44 / ADR-0007 决策 6、CONTEXT「检索补充层」）：
 *  - 默认 query = 当前场景名 + 玩家合并发言；玩家发言先剥 `【玩家名】` 前缀与行动壳/噪声；
 *  - 无玩家文本（开局）→ 退化为纯场景名；
 *  - **仅当检索最高分低于阈值**时做**至多一次** LLM 改写并重检一次；
 *  - 改写失败/超时/空答 → 回退原 query 结果，**绝不抛出、绝不阻断回合**；
 *  - 改写只影响检索用 query，不进入对话内容。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildSceneQuery,
  shouldRewrite,
  retrieveWithRewrite,
  cleanPlayerText,
  rewriteQuery,
  sanitizeRewrite,
  DEFAULT_REWRITE_THRESHOLD,
  type ScoredChunk,
  type RewriteFn,
} from '../queryBuild.js'
import type { ChatMessage } from '../../services/llm/types.js'

/** 假重排候选：分数递增便于断言"是否换了 query"。 */
function hits(tag: string, score: number): ScoredChunk[] {
  return [{ id: `${tag}-1`, score }, { id: `${tag}-2`, score: score - 0.1 }]
}

describe('queryBuild: 玩家文本清洗', () => {
  it('剥离 【玩家名】 前缀（多人合并消息逐行）', () => {
    const out = cleanPlayerText('【爱丽丝】我推开门\n【鲍勃】我举枪警戒')
    expect(out).not.toContain('爱丽丝')
    expect(out).not.toContain('鲍勃')
    expect(out).toContain('推开门')
    expect(out).toContain('举枪警戒')
  })

  it('剥离行动壳（我想/我要/我尝试/我打算/我去 等意图标记）', () => {
    expect(cleanPlayerText('我想要检查书桌的抽屉')).toBe('检查书桌的抽屉')
    expect(cleanPlayerText('我尝试推开那扇门')).toBe('推开那扇门')
    expect(cleanPlayerText('我去看看窗外')).toBe('看看窗外')
  })

  it('剥离中缀元数据标记（点数/骰子等 【】 内容）与空白噪声', () => {
    const out = cleanPlayerText('我翻找书架【D100=42】　然后查看  笔记本')
    expect(out).not.toContain('D100')
    expect(out).not.toContain('42')
    expect(out).toContain('翻找书架')
    expect(out).toContain('笔记本')
  })

  it('折叠重复标点与纯符号噪声（情绪壳不进检索词）', () => {
    expect(cleanPlayerText('门开了？？？！！！')).toBe('门开了')
    expect(cleanPlayerText('——……')).toBe('')
  })

  it('无前缀无壳的裸文本保留原句（信息不丢）', () => {
    expect(cleanPlayerText('调查员走向祭坛')).toBe('调查员走向祭坛')
  })

  it('代词不被剥壳：复数/助词形态的原句保留字头（审查回归）', () => {
    expect(cleanPlayerText('我们决定推开门')).toBe('我们决定推开门')
    expect(cleanPlayerText('他们打开了门')).toBe('他们打开了门')
    expect(cleanPlayerText('她的笔记本')).toBe('她的笔记本')
    // 单字代词 + 动词仍是行动壳（保留原设计意图）
    expect(cleanPlayerText('我推开门')).toBe('推开门')
  })
})

describe('queryBuild: query 构造', () => {
  it('场景名 + 清洗后的玩家文本', () => {
    const q = buildSceneQuery({ sceneName: '书房', playerText: '【爱丽丝】我想检查书桌的抽屉' })
    expect(q.text).toBe('书房 检查书桌的抽屉')
    expect(q.usedPlayerText).toBe(true)
  })

  it('无玩家文本（开局）→ 退化为纯场景名', () => {
    expect(buildSceneQuery({ sceneName: '门厅', playerText: '' }).text).toBe('门厅')
    expect(buildSceneQuery({ sceneName: '门厅', playerText: '   ' }).text).toBe('门厅')
    expect(buildSceneQuery({ sceneName: '门厅' }).text).toBe('门厅')
    expect(buildSceneQuery({ sceneName: '门厅', playerText: '【爱丽丝】' }).usedPlayerText).toBe(false)
  })

  it('清洗后为空（纯符号壳）→ 视为无玩家文本', () => {
    const q = buildSceneQuery({ sceneName: '门厅', playerText: '【爱丽丝】？？！' })
    expect(q.text).toBe('门厅')
    expect(q.usedPlayerText).toBe(false)
  })

  it('无场景名 → 只用玩家文本（不产出前导空格）', () => {
    const q = buildSceneQuery({ sceneName: '', playerText: '【爱丽丝】我想开门' })
    expect(q.text).toBe('开门')
  })

  it('场景名与玩家文本都空 → 空 query（调用方据此跳过检索）', () => {
    expect(buildSceneQuery({ sceneName: '', playerText: '' }).text).toBe('')
    expect(buildSceneQuery({ sceneName: '   ', playerText: '' }).text).toBe('')
  })

  it('超长玩家文本按上限截断（query 不进上下文，仅用于检索）', () => {
    const long = '调查'.repeat(300)
    const q = buildSceneQuery({ sceneName: '书房', playerText: long, maxPlayerChars: 50 })
    expect(q.text.length).toBeLessThanOrEqual(3 + 50)
    expect(q.text.startsWith('书房 ')).toBe(true)
  })

  it('不做任何 IO / 异步——纯函数（同输入同输出）', () => {
    const input = { sceneName: '书房', playerText: '【爱丽丝】我想检查抽屉' }
    expect(buildSceneQuery(input)).toEqual(buildSceneQuery(input))
  })
})

describe('queryBuild: 低分改写判定', () => {
  it('最高分 ≥ 阈值 → 不改写', () => {
    expect(shouldRewrite(hits('x', DEFAULT_REWRITE_THRESHOLD), DEFAULT_REWRITE_THRESHOLD)).toBe(false)
    expect(shouldRewrite(hits('x', 0.99), DEFAULT_REWRITE_THRESHOLD)).toBe(false)
  })

  it('最高分 < 阈值 → 改写', () => {
    expect(shouldRewrite(hits('x', 0.1), DEFAULT_REWRITE_THRESHOLD)).toBe(true)
  })

  it('空候选 → 不改写（无分可低，白花一次 LLM）', () => {
    expect(shouldRewrite([], DEFAULT_REWRITE_THRESHOLD)).toBe(false)
  })

  it('阈值可调（调用方显式传入）', () => {
    expect(shouldRewrite(hits('x', 0.5), 0.4)).toBe(false)
    expect(shouldRewrite(hits('x', 0.5), 0.6)).toBe(true)
  })
})

describe('queryBuild: 检索 + 至多一次改写重检', () => {
  it('高分：只检索一次，不调用 LLM', async () => {
    const retrieve = vi.fn(async () => hits('high', 0.9))
    const rewrite = vi.fn(async () => '改写后的 query')
    const res = await retrieveWithRewrite({ query: '书房 检查抽屉', retrieve, rewrite })
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(rewrite).not.toHaveBeenCalled()
    expect(res.rewritten).toBe(false)
    expect(res.chunks.map((c) => c.id)).toEqual(['high-1', 'high-2'])
  })

  it('低分：LLM 改写一次 + 重检一次（共两次检索）', async () => {
    const retrieve = vi
      .fn<(q: string) => Promise<ScoredChunk[]>>()
      .mockResolvedValueOnce(hits('low', 0.2))
      .mockResolvedValueOnce(hits('better', 0.7))
    const rewrite: RewriteFn = vi.fn(async () => '书桌 抽屉 暗格')
    const res = await retrieveWithRewrite({ query: '书房 检查抽屉', retrieve, rewrite })
    expect(rewrite).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(retrieve).toHaveBeenLastCalledWith('书桌 抽屉 暗格')
    expect(res.rewritten).toBe(true)
    expect(res.query).toBe('书桌 抽屉 暗格')
    expect(res.chunks.map((c) => c.id)).toEqual(['better-1', 'better-2'])
  })

  it('改写后仍低分 → 仍然用新结果（不无限重试，改写上限一次）', async () => {
    const retrieve = vi
      .fn<(q: string) => Promise<ScoredChunk[]>>()
      .mockResolvedValueOnce(hits('low', 0.2))
      .mockResolvedValueOnce(hits('still-low', 0.25))
    const rewrite = vi.fn(async () => '换个说法')
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite })
    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(rewrite).toHaveBeenCalledTimes(1)
    expect(res.chunks.map((c) => c.id)).toEqual(['still-low-1', 'still-low-2'])
  })

  it('改写后更差 → 回退原 query 的结果（重检不倒退）', async () => {
    const retrieve = vi
      .fn<(q: string) => Promise<ScoredChunk[]>>()
      .mockResolvedValueOnce(hits('orig', 0.3))
      .mockResolvedValueOnce(hits('worse', 0.05))
    const rewrite = vi.fn(async () => '歪掉的改写')
    const res = await retrieveWithRewrite({ query: 'orig query', retrieve, rewrite })
    expect(res.rewritten).toBe(false)
    expect(res.query).toBe('orig query')
    expect(res.chunks.map((c) => c.id)).toEqual(['orig-1', 'orig-2'])
  })

  it('改写失败（抛错）→ 回退原结果，不抛出', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.2))
    const rewrite = vi.fn(async () => {
      throw new Error('upstream 503')
    })
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite })
    expect(res.rewritten).toBe(false)
    expect(res.chunks.map((c) => c.id)).toEqual(['orig-1', 'orig-2'])
    expect(res.error).toContain('503')
  })

  it('改写返回空串/纯空白 → 视为失败，回退原结果', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.2))
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite: async () => '   ' })
    expect(res.rewritten).toBe(false)
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(res.error).toBeTruthy()
  })

  it('未注入 rewrite → 不改写（M1 开关关闭/无 LLM 的降级形态）', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.05))
    const res = await retrieveWithRewrite({ query: 'q', retrieve })
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(res.rewritten).toBe(false)
  })

  it('改写超时 → 回退原结果（有界等待，不阻断回合）', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.2))
    const rewrite: RewriteFn = () => new Promise(() => {}) // 永不 resolve
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite, timeoutMs: 30 })
    expect(res.rewritten).toBe(false)
    expect(res.chunks.map((c) => c.id)).toEqual(['orig-1', 'orig-2'])
  })

  it('检索本身失败 → 空候选结果，不抛出（回合不因检索中断）', async () => {
    const retrieve = vi.fn(async () => {
      throw new Error('vector store down')
    })
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite: async () => 'x' })
    expect(res.chunks).toEqual([])
    expect(res.error).toContain('vector store down')
  })

  it('结构化结果带诊断字段（报告/采样消费）', async () => {
    const retrieve = vi.fn(async () => hits('high', 0.8))
    const res = await retrieveWithRewrite({ query: '书房 检查', retrieve, rewrite: async () => 'x' })
    expect(res.query).toBe('书房 检查')
    expect(res.topScore).toBeCloseTo(0.8)
    expect(res.rewritten).toBe(false)
    expect(typeof res.durationMs).toBe('number')
  })

  it('改写把检索打成空候选 → 拒绝采纳，回退原结果（审查回归）', async () => {
    const retrieve = vi
      .fn<(q: string) => Promise<ScoredChunk[]>>()
      .mockResolvedValueOnce(hits('orig', 0.2))
      .mockResolvedValueOnce([])
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite: async () => '改写' })
    expect(res.rewritten).toBe(false)
    expect(res.chunks.map((c) => c.id)).toEqual(['orig-1', 'orig-2'])
  })

  it('原候选全为负分时仍守住「重检不倒退」（topScore 不从 0 起算）', async () => {
    const negative: ScoredChunk[] = [{ id: 'n1', score: -0.5 }, { id: 'n2', score: -0.8 }]
    const retrieve = vi
      .fn<(q: string) => Promise<ScoredChunk[]>>()
      .mockResolvedValueOnce(negative)
      .mockResolvedValueOnce([{ id: 'w1', score: -0.9 }])
    const res = await retrieveWithRewrite({ query: 'q', retrieve, rewrite: async () => '改写' })
    expect(res.topScore).toBeCloseTo(-0.5)
    expect(res.rewritten).toBe(false)
    expect(res.chunks.map((c) => c.id)).toEqual(['n1', 'n2'])
  })

  it('改写原样回吐 query → 不重检、记诊断（同 query 重检没有意义）', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.2))
    const res = await retrieveWithRewrite({ query: ' q ', retrieve, rewrite: async () => 'q' })
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(res.rewritten).toBe(false)
    expect(res.query).toBe('q')
    expect(res.error).toContain('unchanged')
  })

  it('query 前后空白先归一（避免把 " q " 当成与 "q" 不同的改写）', async () => {
    const retrieve = vi.fn(async () => hits('orig', 0.9))
    const res = await retrieveWithRewrite({ query: '  门厅 推门  ', retrieve })
    expect(res.query).toBe('门厅 推门')
  })

  it('畸形入参（null / 无 retrieve）→ 空结果，不抛（头注释承诺"永不抛出"）', async () => {
    const nulled = await retrieveWithRewrite(null as unknown as Parameters<typeof retrieveWithRewrite>[0])
    expect(nulled.chunks).toEqual([])
    const noRetrieve = await retrieveWithRewrite({ query: 'q' } as unknown as Parameters<typeof retrieveWithRewrite>[0])
    expect(noRetrieve.chunks).toEqual([])
  })
})

describe('queryBuild: 改写器默认实现（注入 LLM，不触网）', () => {
  it('把场景名与 query 交给 LLM，只取清洗后的单行查询', async () => {
    const llm = vi.fn(async (_msgs: ChatMessage[], _maxTokens: number) => '  1. 「书桌 抽屉 暗格」\n多余的解释行')
    const out = await rewriteQuery('书房 检查抽屉', '书房', { userId: 1, llm })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(out).toBe('书桌 抽屉 暗格')
    const messages = llm.mock.calls[0][0]
    expect(messages[1]!.content).toContain('书房')
    expect(messages[1]!.content).toContain('检查抽屉')
  })

  it('sanitizeRewrite：剥引号/编号/前缀标签、压空白、超长截断', () => {
    expect(sanitizeRewrite('"书房 书架"')).toBe('书房 书架')
    expect(sanitizeRewrite('查询：祭坛 血迹')).toBe('祭坛 血迹')
    expect(sanitizeRewrite('Query: altar blood')).toBe('altar blood')
    expect(sanitizeRewrite('  祭坛   血迹  ')).toBe('祭坛 血迹')
    expect(sanitizeRewrite('')).toBe('')
    expect(sanitizeRewrite('长'.repeat(200)).length).toBe(80)
  })

  it('模型守卫生效：-pro 变体直接拒绝（铁律 1）', async () => {
    const llm = vi.fn(async () => 'x')
    await expect(rewriteQuery('q', 's', { userId: 1, model: 'mimo-v2.5-pro', llm })).rejects.toThrow(/-pro/)
    expect(llm).not.toHaveBeenCalled()
    // 非 -pro 正常放行
    await expect(rewriteQuery('q', 's', { userId: 1, model: 'mimo-v2.5', llm })).resolves.toBe('x')
  })
})

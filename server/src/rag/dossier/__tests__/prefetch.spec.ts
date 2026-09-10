/**
 * prefetch spec（P27，TDD）— 服务端自动预取原文查证。
 *
 * P26 负结论：把"档案可能不全""事实问先查证"写进提示词后，KP 仍不调用
 * verify_original（40 个游玩回合合计 1 次）。因此改为服务端自己判定并预取：
 * 玩家发言是事实问句 + 当前场景档案对不上问题措辞 → 服务端先跑一次查证，
 * 把结论并入本轮 system 上下文（对玩家不可见，不依赖 KP 自觉）。
 *
 * LLM 与档案全部注入（deps.verify / deps.onEvent），不触网不落盘。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  decidePrefetch,
  runPrefetch,
  FACT_QUESTION,
  OVERLAP_RATIO,
  type PrefetchInput,
} from '../prefetch.js'
import type { VerifyOriginalResult } from '../originalLookup.js'

const SCENE_BLOCK = '场景：旧图书馆\n现场描述：管理员阿洛伊斯站在借阅台后，书架角落放着一只青瓷花瓶。'

function input(over: Partial<PrefetchInput> = {}): PrefetchInput {
  return {
    // 默认问句刻意选档案里没有的角色（触发路径）；档案覆盖的问句在专门用例里给
    playerText: '海哥的本名是什么？他有什么过去？',
    sceneBlock: SCENE_BLOCK,
    sceneName: '旧图书馆',
    coverage: null,
    ...over,
  }
}

describe('prefetch: 触发判定（纯函数）', () => {
  it('行动叙述（非问句）→ 不触发', () => {
    expect(decidePrefetch(input({ playerText: '我环顾四周，仔细观察一下现在的环境。' })).trigger).toBe(false)
    // 含疑问词但以陈述句收尾（"打听…发生了什么。"）→ 行动叙述，不触发
    expect(decidePrefetch(input({ playerText: '我试着和在场的人交谈，打听这里到底发生了什么。' })).trigger).toBe(false)
    expect(decidePrefetch(input({ playerText: '我想知道这里曾经出过什么事。' })).reason).toBe('not-a-question')
  })

  it('问句但档案已覆盖问题措辞 → 不触发（省一次 LLM 调用）', () => {
    const d = decidePrefetch(input({ playerText: '青瓷花瓶是什么？' }))
    expect(d.trigger).toBe(false)
    expect(d.reason).toBe('dossier-covers')
    // 命中率可诊断（同口径暴露给调用方）：刚好达到阈值即视为覆盖
    expect(d.overlap).toBeGreaterThanOrEqual(OVERLAP_RATIO)
  })

  it('问句 + 档案对不上问题措辞 → 触发，并把原问题作为查证问题', () => {
    const d = decidePrefetch(input({ playerText: '海哥的本名是什么？他有什么过去？' }))
    expect(d.trigger).toBe(true)
    expect(d.reason).toBe('dossier-miss')
    expect(d.question).toBe('海哥的本名是什么？他有什么过去？')
  })

  it('场景档案缺失（未匹配到场景）+ 问句 → 触发', () => {
    const d = decidePrefetch(input({ playerText: '那扇门后面有什么？', sceneBlock: '' }))
    expect(d.trigger).toBe(true)
    expect(d.reason).toBe('no-scene-block')
  })

  it('覆盖完整（≥阈值）且问句 → 不触发（本轮已知档案完整，省调用）', () => {
    const d = decidePrefetch(
      input({
        playerText: '海哥的本名是什么？他有什么过去？',
        coverage: { sceneId: 's', sceneName: '旧图书馆', regionChars: 100, gapChars: 2, coveragePct: 98, gapCount: 1 },
      }),
    )
    expect(d.trigger).toBe(false)
    expect(d.reason).toBe('coverage-sufficient')
  })

  it('覆盖不足（<阈值）不额外放行——仍需问句 + 措辞对不上', () => {
    const cov = { sceneId: 's', sceneName: '旧图书馆', regionChars: 100, gapChars: 60, coveragePct: 40, gapCount: 3 }
    // 问句 + 档案覆盖措辞：即便覆盖率低也不触发（问题已在档案里答得出）
    expect(decidePrefetch(input({ playerText: '青瓷花瓶是什么？', coverage: cov })).trigger).toBe(false)
    // 行动叙述：哪怕覆盖率很低也不触发
    expect(decidePrefetch(input({ playerText: '我推开门走进去。', coverage: cov })).trigger).toBe(false)
  })

  it('问句识别（P27b 收紧）：行动叙述不误判，含疑问词的陈述也不误判', () => {
    // 「吗/呢」只在句读边界才算问句信号——"吗啡"这类词内出现不算
    expect(decidePrefetch(input({ playerText: '我打开吗啡瓶看看里面有什么' })).reason).toBe('not-a-question')
    expect(decidePrefetch(input({ playerText: '我拿起呢绒外套穿上' })).reason).toBe('not-a-question')
    // 含疑问词但以陈述句收尾（"打听…发生了什么。"）→ 行动叙述
    expect(decidePrefetch(input({ playerText: '我试着和在场的人交谈，打听这里到底发生了什么。' })).reason).toBe('not-a-question')
    expect(decidePrefetch(input({ playerText: '我想知道这里曾经出过什么事。' })).reason).toBe('not-a-question')
    // 真问句（问号 / 句末疑问语气）照常识别
    expect(FACT_QUESTION.test('他是谁')).toBe(true)
    expect(FACT_QUESTION.test('这里曾经发生过什么？')).toBe(true)
    expect(FACT_QUESTION.test('你确定是这样吗')).toBe(true)
    expect(FACT_QUESTION.test('海哥呢')).toBe(true)
  })

  it('过短文本（<最短问句长度）→ 不触发', () => {
    expect(decidePrefetch(input({ playerText: '谁？' })).trigger).toBe(false)
  })
})

describe('prefetch: 执行（注入 verifyOriginal）', () => {
  const hitResult: VerifyOriginalResult = {
    content: '【原文查证·旧图书馆】海哥本名海华，曾是登山向导。\n【原文】"海华曾经是这一带有名的登山向导。"',
    meta: { ok: true, tier: 'scene', spoiler: 'normal', cached: false, chars: 3_000, durationMs: 120 },
  }

  it('触发 → 调用查证并把结论交给调用方（含问题与场景）', async () => {
    const verify = vi.fn(async (_input: { question: string; scene?: string }, _deps: unknown) => hitResult)
    const res = await runPrefetch(input(), { userId: 1, scriptId: 's1', verify })
    expect(verify).toHaveBeenCalledTimes(1)
    const call = verify.mock.calls[0]?.[0] as { question: string; scene?: string }
    expect(call.question).toContain('海哥')
    expect(call.scene).toBe('旧图书馆')
    expect(res?.content).toContain('海华')
  })

  it('不触发 → 不调用查证，返回 null', async () => {
    const verify = vi.fn(async () => hitResult)
    expect(await runPrefetch(input({ playerText: '我环顾四周。' }), { userId: 1, scriptId: 's1', verify })).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })

  it('查证失败（ok=false）→ 返回 null（不注入噪音），不抛出', async () => {
    const verify = vi.fn(async (): Promise<VerifyOriginalResult> => ({
      content: '【原文查证】未取得：原文中未定位到与问题相关的片段。',
      meta: { ok: false, tier: 'none', spoiler: 'normal', cached: false, chars: 0, reason: 'no-location', durationMs: 5 },
    }))
    expect(await runPrefetch(input(), { userId: 1, scriptId: 's1', verify })).toBeNull()
  })

  it('查证超时 → 返回 null，不阻断回合', async () => {
    const verify = vi.fn(() => new Promise<VerifyOriginalResult>(() => { /* 永不 resolve */ }))
    const res = await runPrefetch(input(), { userId: 1, scriptId: 's1', verify, timeoutMs: 40 })
    expect(res).toBeNull()
  })

  it('查证抛错 → 返回 null，不抛出', async () => {
    const verify = vi.fn(async (): Promise<VerifyOriginalResult> => {
      throw new Error('upstream 503')
    })
    expect(await runPrefetch(input(), { userId: 1, scriptId: 's1', verify })).toBeNull()
  })

  it('onEvent 回报判定与结果（供日志/报告统计，失败不影响主流程）', async () => {
    const events: Record<string, unknown>[] = []
    await runPrefetch(input(), { userId: 1, scriptId: 's1', verify: async () => hitResult, onEvent: (e) => events.push(e) })
    expect(events.map((e) => e.type)).toEqual(['prefetch-decision', 'prefetch-result'])
    expect(events[0]?.trigger).toBe(true)
    expect(events[1]?.ok).toBe(true)
    // 不触发时不产生 result 事件
    const quiet: Record<string, unknown>[] = []
    await runPrefetch(input({ playerText: '我走进房间。' }), { userId: 1, scriptId: 's1', verify: async () => hitResult, onEvent: (e) => quiet.push(e) })
    expect(quiet.map((e) => e.type)).toEqual(['prefetch-decision'])
  })
})

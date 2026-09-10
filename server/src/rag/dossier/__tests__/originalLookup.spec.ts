/**
 * originalLookup spec（P25，TDD）— 运行时「原文查证」工具：场景锚点/gap 窗口
 * 定位（P23 结论：运行时必须场景级定向）、词面兜底、预算拼装、剧透 gate、
 * 答案缓存（TTL）、LLM 失败/无定位降级（不阻断回合）。
 *
 * LLM 与文件读取全部注入（deps.loadStoryText / loadGaps / loadDossier / ask），
 * 不触网、不落盘。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ANCHOR_LEAD,
  ANCHOR_SPAN,
  DEFAULT_BUDGET,
  buildSceneWindows,
  buildGlobalWindows,
  scoreWindows,
  selectWindows,
  locateForQuestion,
  classifySpoiler,
  renderVerifyContent,
  verifyOriginal,
  clearVerifyCaches,
  type LocateWindow,
} from '../originalLookup.js'
import type { CoverageGaps } from '../coverageGaps.js'
import type { StoryDossier } from '../schema.js'

/* ── 测试夹具：原文 20k 字符，场景 A 锚在 2_000/12_000，场景 B 在 9_000 ── */
function makeStory(): string {
  const filler = (label: string, n: number) => `${label}${'甲'.repeat(n)}`
  return [
    filler('序章', 1_900), // 0..1897
    '场景A的第一段原文：祭坛上刻着三颗眼状纹样，香炉里积着黑色的灰。', // 锚点 1
    filler('过渡', 4_000),
    '场景B的原文：钟楼地下室的门被木板钉死，墙上有六道抓痕。', // 锚点 2（场景B）
    filler('中段', 1_500),
    '场景A的第二段原文：密室里堆着七具石棺，其中一具盖子半开。', // 锚点 3
    filler('尾段', 1_500),
  ].join('\n\n')
}

function gapsFixture(): CoverageGaps {
  const text = makeStory()
  const a1 = text.indexOf('场景A的第一段原文')
  const b1 = text.indexOf('场景B的原文')
  const a2 = text.indexOf('场景A的第二段原文')
  return {
    storyChars: text.length,
    sceneTextChars: 100,
    gapCount: 2,
    gapChars: 2_400,
    gapPct: 12,
    spans: [
      // 场景 A 范围内（锚 1 与锚 3 之间）的缺口：密室的补充说明
      { start: a2 + 300, end: a2 + 900, chars: 600, preview: '密室砖缝里的符文' },
      // 全篇无关位置的缺口
      { start: 200, end: 400, chars: 200, preview: '序章附录' },
    ],
    sceneAnchors: [
      { id: 'scene_a', name: '祭坛厅', matched: true, starts: [a1, a2] },
      { id: 'scene_b', name: '钟楼', matched: true, starts: [b1] },
      { id: 'scene_c', name: '无锚场景', matched: false },
    ],
  }
}

function dossierFixture(): StoryDossier {
  return {
    scriptId: 's1',
    storyName: '测试模组',
    generatedAt: 0,
    scenes: [
      { id: 'scene_a', name: '祭坛厅', description: '祭坛', sceneText: '祭坛上刻着三颗眼状纹样。' },
      { id: 'scene_b', name: '钟楼', description: '钟楼', sceneText: '钟楼地下室的门被木板钉死。' },
      { id: 'scene_c', name: '无锚场景', description: '无锚', sceneText: '没有对应原文。' },
      { id: 'scene_reveal', name: '真相之室', description: '揭晓', sceneText: '真相在此揭晓。' },
    ],
    clues: [],
    npcs: [],
    truths: [{ id: 'truth_1', title: '邪教仪式', detail: '每夜献祭。', revealScene: '真相之室' }],
    endings: [],
  } as unknown as StoryDossier
}

describe('originalLookup: 场景窗口定位', () => {
  it('按场景锚点开窗（start-LEAD .. start+SPAN），含与该场景相交的 gap span', () => {
    const text = makeStory()
    const gaps = gapsFixture()
    const windows = buildSceneWindows(text, gaps, { id: 'scene_a', name: '祭坛厅' })
    const anchors = windows.filter((w) => w.kind === 'anchor')
    expect(anchors.length).toBe(2)
    expect(anchors[0]?.start).toBe(Math.max(0, text.indexOf('场景A的第一段原文') - ANCHOR_LEAD))
    expect(anchors[0]?.end).toBe(text.indexOf('场景A的第一段原文') + ANCHOR_SPAN)
    const gapWin = windows.filter((w) => w.kind === 'gap')
    expect(gapWin.length).toBe(1) // 只有与场景 A 范围相交的那条缺口
    expect(gapWin[0]?.start).toBe(gaps.spans[0]?.start)
    expect(windows[0]?.sceneId).toBe('scene_a')
  })

  it('非锚场景（matched=false）无窗口；缺 gaps 文件同样安全返回空', () => {
    const text = makeStory()
    expect(buildSceneWindows(text, gapsFixture(), { id: 'scene_c', name: '无锚场景' })).toEqual([])
    expect(buildSceneWindows(text, null, { id: 'scene_a', name: '祭坛厅' })).toEqual([])
  })

  it('全局候选：全部锚点 + 全部 gap span（长 gap 再切块）', () => {
    const text = makeStory()
    const gaps = gapsFixture()
    const wins = buildGlobalWindows(text, gaps)
    expect(wins.filter((w) => w.kind === 'anchor').length).toBe(3)
    expect(wins.filter((w) => w.kind === 'gap').length).toBe(2)
    for (const w of wins) {
      expect(w.end).toBeGreaterThan(w.start)
      expect(w.end).toBeLessThanOrEqual(text.length)
    }
  })
})

describe('originalLookup: 词面评分与预算拼装', () => {
  it('评分按问题 CJK 二元组命中数，命中的窗口排在前面', () => {
    const text = makeStory()
    const wins: LocateWindow[] = [
      { start: text.indexOf('场景B的原文'), end: text.indexOf('场景B的原文') + 40, kind: 'anchor' },
      { start: text.indexOf('场景A的第二段原文'), end: text.indexOf('场景A的第二段原文') + 40, kind: 'anchor' },
    ]
    const scored = scoreWindows(text, wins, '密室里堆着什么？')
    expect(scored[0]?.score).toBeGreaterThan(scored[1]?.score ?? 0)
  })

  it('预算内拼装：总量 ≤ 预算、按原文顺序、重叠区不重复', () => {
    const text = makeStory()
    const a1 = text.indexOf('场景A的第一段原文')
    const wins: LocateWindow[] = [
      { start: a1, end: a1 + 1_000, kind: 'anchor' },
      { start: a1 + 500, end: a1 + 1_500, kind: 'gap' },
    ]
    const picked = selectWindows(text, wins, 1_200)
    expect(picked.text.length).toBeLessThanOrEqual(1_200)
    // 重叠区（a1+500..a1+1000）只出现一次 → 拼接长度 = 1500-重叠500 = 1000
    expect(picked.text.length).toBe(1_000)
    expect(picked.text.startsWith(text.slice(a1, a1 + 100))).toBe(true)
  })
})

describe('originalLookup: 定位分层（场景级优先 → 全局词面兜底）', () => {
  it('问题命中当前场景窗口 → tier=scene，只取该场景窗口', () => {
    const text = makeStory()
    const loc = locateForQuestion(text, gapsFixture(), dossierFixture(), '祭坛厅', '祭坛上刻着什么纹样？')
    expect(loc.tier).toBe('scene')
    expect(loc.sceneId).toBe('scene_a')
    expect(loc.text).toContain('三颗眼状纹样')
    expect(loc.text).not.toContain('钟楼地下室')
  })

  it('当前场景窗口无一命中 → 退全局词面定位（tier=global）', () => {
    const text = makeStory()
    const loc = locateForQuestion(text, gapsFixture(), dossierFixture(), '祭坛厅', '钟楼地下室的门是什么状态？')
    expect(loc.tier).toBe('global')
    expect(loc.text).toContain('钟楼地下室')
  })

  it('无锚场景 + 无词面命中 → tier=none（调用方据此降级）', () => {
    const text = makeStory()
    const loc = locateForQuestion(text, gapsFixture(), dossierFixture(), '无锚场景', '完全不存在的词面占位符zzz')
    expect(loc.tier).toBe('none')
    expect(loc.text).toBe('')
  })

  it('定位总量不超过预算', () => {
    const text = makeStory()
    const loc = locateForQuestion(text, gapsFixture(), dossierFixture(), '祭坛厅', '祭坛 密室 钟楼 纹样 石棺', DEFAULT_BUDGET)
    expect(loc.chars).toBeLessThanOrEqual(DEFAULT_BUDGET)
  })
})

describe('originalLookup: 剧透 gate', () => {
  it('真相/结局类问句 → kp_only', () => {
    const text = makeStory()
    const gaps = gapsFixture()
    const loc = locateForQuestion(text, gaps, dossierFixture(), '祭坛厅', '这起事件的真相是什么？')
    const g = classifySpoiler('这起事件的真相是什么？', dossierFixture(), gaps, loc.windows)
    expect(g.level).toBe('kp_only')
    expect(g.reason).toContain('query')
  })

  it('普通事实问句 → normal', () => {
    const text = makeStory()
    const gaps = gapsFixture()
    const loc = locateForQuestion(text, gaps, dossierFixture(), '祭坛厅', '祭坛上刻着什么纹样？')
    expect(classifySpoiler('祭坛上刻着什么纹样？', dossierFixture(), gaps, loc.windows).level).toBe('normal')
  })

  it('所选窗口与 revealScene 锚点相交 → kp_only（review-scene 命中）', () => {
    const text = makeStory()
    const a1 = text.indexOf('场景A的第一段原文')
    const gaps: CoverageGaps = {
      ...gapsFixture(),
      sceneAnchors: [
        { id: 'scene_a', name: '祭坛厅', matched: true, starts: [a1] },
        { id: 'scene_reveal', name: '真相之室', matched: true, starts: [a1 + 60] },
      ],
    }
    const windows: LocateWindow[] = [{ start: a1, end: a1 + 1_000, kind: 'anchor' }]
    const g = classifySpoiler('密室里有什么？', dossierFixture(), gaps, windows)
    expect(g.level).toBe('kp_only')
    expect(g.reason).toContain('reveal')
  })
})

describe('originalLookup: 渲染与工具响应', () => {
  it('渲染出查证结论 + 原文引用；kp_only 加剧透层标注', () => {
    const normal = renderVerifyContent({ answer: '祭坛刻着三颗眼状纹样。', quote: '祭坛上刻着三颗眼状纹样', sceneName: '祭坛厅', spoiler: 'normal' })
    expect(normal).toContain('祭坛')
    expect(normal).not.toContain('剧透')
    const gated = renderVerifyContent({ answer: '幕后是邪教。', quote: '真相在此揭晓', sceneName: '真相之室', spoiler: 'kp_only' })
    expect(gated).toContain('剧透')
    expect(gated).toContain('幕')
  })

  it('渲染总长度受限（会话回填 600 字符截断线以内）', () => {
    const out = renderVerifyContent({
      answer: '甲'.repeat(2_000),
      quote: '乙'.repeat(500),
      sceneName: '祭坛厅',
      spoiler: 'normal',
    })
    expect(out.length).toBeLessThanOrEqual(580)
  })
})

describe('originalLookup: verifyOriginal 端到端（注入 LLM）', () => {
  const text = makeStory()
  const gaps = gapsFixture()
  const dossier = dossierFixture()
  const mkDeps = (askImpl?: (m: unknown[], max: number) => Promise<string>) => {
    const ask = vi.fn(askImpl ?? (async () => JSON.stringify({ answer: '祭坛刻着三颗眼状纹样。', quote: '祭坛上刻着三颗眼状纹样', found: true })))
    return {
      ask,
      deps: {
        userId: 1,
        scriptId: 's1',
        loadStoryText: async () => text,
        loadGaps: async () => gaps,
        loadDossier: async () => dossier,
        ask: ask as never,
      },
    }
  }

  beforeEach(() => clearVerifyCaches())

  it('定位 → 一次全新上下文 LLM 调用（原文窗口 + 问题）→ 渲染结论', async () => {
    const { ask, deps } = mkDeps()
    const res = await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, deps)
    expect(ask).toHaveBeenCalledTimes(1)
    const messages = ask.mock.calls[0]?.[0] as { role: string; content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.content).toContain('三颗眼状纹样')
    expect(messages[1]?.content).toContain('祭坛上刻着什么纹样？')
    expect(res.content).toContain('祭坛刻着三颗眼状纹样')
    expect(res.meta.tier).toBe('scene')
    expect(res.meta.cached).toBe(false)
  })

  it('同问同场景命中进程内缓存（不再调用 LLM）', async () => {
    const { ask, deps } = mkDeps()
    await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, deps)
    const second = await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, deps)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(second.meta.cached).toBe(true)
    // 不同问句不共享缓存
    await verifyOriginal({ question: '钟楼地下室的门是什么状态？', scene: '祭坛厅' }, deps)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('缓存过期（TTL）后重新调用', async () => {
    let now = 1_000
    const { ask, deps } = mkDeps()
    const depsT = { ...deps, now: () => now }
    await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, depsT)
    now += 11 * 60_000
    await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, depsT)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('LLM 抛错 → 降级为「未取得」内容，不抛出', async () => {
    const { deps } = mkDeps(async () => {
      throw new Error('upstream 503')
    })
    const res = await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, deps)
    expect(res.content).toContain('未取得')
    expect(res.meta.ok).toBe(false)
  })

  it('原文缺失 → 「未取得」，且不调用 LLM', async () => {
    const { ask, deps } = mkDeps()
    const res = await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, { ...deps, loadStoryText: async () => null })
    expect(res.content).toContain('未取得')
    expect(ask).not.toHaveBeenCalled()
  })

  it('定位不到 → 「未取得」（不调用 LLM，不阻断）', async () => {
    const { ask, deps } = mkDeps()
    const res = await verifyOriginal({ question: '无关问句zzz', scene: '无锚场景' }, deps)
    expect(res.content).toContain('未取得')
    expect(ask).not.toHaveBeenCalled()
  })

  it('剧透问句 → 输出带「剧透」标注（供 KP 内部裁定）', async () => {
    const { deps } = mkDeps(async () => JSON.stringify({ answer: '邪教每晚献祭。', quote: '每夜献祭', found: true }))
    const res = await verifyOriginal({ question: '这件事背后的真相是什么？', scene: '祭坛厅' }, deps)
    expect(res.content).toContain('剧透')
    expect(res.meta.spoiler).toBe('kp_only')
  })

  it('LLM 返回非 JSON（散文）→ 原文截断兜底，仍可用', async () => {
    const { deps } = mkDeps(async () => '祭坛上刻着三颗眼状纹样，香炉里有黑色灰烬。')
    const res = await verifyOriginal({ question: '祭坛上刻着什么纹样？', scene: '祭坛厅' }, deps)
    expect(res.content).toContain('眼状纹样')
    expect(res.meta.ok).toBe(true)
  })
})

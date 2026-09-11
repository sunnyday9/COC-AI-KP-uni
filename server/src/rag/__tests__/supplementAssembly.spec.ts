/**
 * 检索编排与注入装配 spec（M1-T5 / issue #49，TDD）。
 *
 * 契约（spec #44 / ADR-0007 决策 2/5/8、CONTEXT「检索补充层」）：
 *  - **装配为纯函数**：候选块 + 归属 + 档案（真相锚点 / 档案块文本）→ 注入小节；
 *  - **剧透硬闸**：与 `truths[].revealScene` 锚点区域相交的块**直接丢弃**；
 *  - 与档案块高重叠的块剔除（档案已有的内容不再喂一遍）；
 *  - 排序：场景内优先 → 无归属次之；**跨场景至多 1 条**且带「未来场景片段」前缀；
 *  - 字符预算 **1.6k 硬截断**（在装配层一次完成，不靠渲染层事后裁剪）；
 *  - 空候选 → 空小节；总开关关闭 → 空；
 *  - 编排：query → 嵌入 → 向量 top10 → 重排 top3；重排器不可用 → 余弦 top3 + 降级标记。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  assembleSupplement,
  SUPPLEMENT_HEADING,
  SUPPLEMENT_BUDGET_CHARS,
  MAX_CROSS_SCENE_CHUNKS,
  MAX_SUPPLEMENT_CHUNKS,
  CROSS_SCENE_PREFIX,
  OVERLAP_DROP_RATIO,
  renderSupplement,
  type SupplementCandidate,
} from '../supplementAssembly.js'
import type { CoverageGaps } from '../dossier/coverageGaps.js'
import type { StoryDossier } from '../dossier/schema.js'

/** 场景区域：s1 = [0,2500)，s2 = [5000,7500)（storyChars 20000）。 */
function gaps(): CoverageGaps {
  return {
    storyChars: 20000,
    sceneTextChars: 0,
    gapCount: 0,
    gapChars: 0,
    gapPct: 0,
    spans: [],
    sceneAnchors: [
      { id: 's1', name: '门厅', matched: true, starts: [300] },
      { id: 's2', name: '书房', matched: true, starts: [5300] },
    ],
  }
}

function dossier(truths: { revealScene?: string }[] = []): StoryDossier {
  return {
    schemaVersion: 2,
    storyName: '测试',
    generatedAt: 0,
    scenes: [
      { id: 's1', name: '门厅', sceneText: '门厅里挂着黄铜吊灯，地板上铺着深红地毯。' },
      { id: 's2', name: '书房', sceneText: '书房四壁皆是书架，写字台上摊着一本账簿。' },
    ],
    clues: [],
    npcs: [],
    transitions: [],
    events: [],
    truths: truths.map((t, i) => ({ id: `t${i}`, title: `真相${i}`, detail: '细节', ...t })),
    endings: [],
  } as unknown as StoryDossier
}

/** 候选简写：content + 偏移 + 分数（score = 相关性，越大越相关）。 */
function cand(
  id: string,
  content: string,
  start: number,
  score = 0.5,
): SupplementCandidate {
  return { id, content, start, score }
}

const LONG = (tag: string, n = 400) => `${tag}`.repeat(n)

describe('supplementAssembly: 空输入与降级', () => {
  it('空候选 → 空小节（section 为空串，blocks 为空）', () => {
    const res = assembleSupplement({ candidates: [], gaps: gaps(), dossier: dossier(), currentScene: 's1' })
    expect(res.section).toBe('')
    expect(res.blocks).toEqual([])
  })

  it('无 gaps（无档案锚点）→ 全部无归属，仍可注入（只是不排序为场景内）', () => {
    const res = assembleSupplement({
      candidates: [cand('c1', '铜灯下的地毯泛着暗红。', 100)],
      gaps: null,
      dossier: null,
      currentScene: 's1',
    })
    expect(res.blocks).toHaveLength(1)
    expect(res.blocks[0].attribution).toBe('none')
    expect(res.section).toContain('铜灯下的地毯泛着暗红。')
  })

  it('空 content / 纯空白候选被丢弃（不占预算）', () => {
    const res = assembleSupplement({
      candidates: [cand('c1', '   ', 100), cand('c2', '有内容。', 100)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['c2'])
  })

  it('总开关关闭（enabled=false）→ 空小节，且**不渲染标题**', () => {
    const res = assembleSupplement({
      candidates: [cand('c1', '铜灯。', 100)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
      enabled: false,
    })
    expect(res.section).toBe('')
    expect(res.blocks).toEqual([])
  })
})

describe('supplementAssembly: 剧透硬闸（revealScene 锚点相交即丢）', () => {
  it('与 revealScene 区域相交的块被丢弃（即便分最高）', () => {
    const res = assembleSupplement({
      // s2 是真相揭晓场景；块落在 s2 区域内
      candidates: [cand('spoiler', '凶手其实是管家，他在地窖里藏了尸体。', 5300, 0.99), cand('ok', '门厅的铜灯。', 500, 0.4)],
      gaps: gaps(),
      dossier: dossier([{ revealScene: 's2' }]),
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['ok'])
    expect(res.droppedSpoiler).toBe(1)
  })

  it('revealScene 用场景名（而非 id）同样命中', () => {
    const res = assembleSupplement({
      candidates: [cand('spoiler', '结局：星之彩降临。', 5300, 0.9)],
      gaps: gaps(),
      dossier: dossier([{ revealScene: '书房' }]),
      currentScene: 's1',
    })
    expect(res.blocks).toEqual([])
    expect(res.droppedSpoiler).toBe(1)
  })

  it('当前场景就是揭晓场景时同样丢弃（锚点相交不区分当前/未来）', () => {
    const res = assembleSupplement({
      candidates: [cand('spoiler', '真相在书房揭晓。', 5300, 0.9)],
      gaps: gaps(),
      dossier: dossier([{ revealScene: 's2' }]),
      currentScene: 's2',
    })
    expect(res.blocks).toEqual([])
  })

  it('revealScene 无锚点（matched=false / 未收录）→ 闸门不误伤其它块', () => {
    const g = gaps()
    g.sceneAnchors = [...g.sceneAnchors, { id: 's3', name: '地窖', matched: false }]
    const res = assembleSupplement({
      candidates: [cand('c1', '地窖的台阶湿滑。', 12000, 0.6)],
      gaps: g,
      dossier: dossier([{ revealScene: 's3' }]),
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['c1'])
    expect(res.droppedSpoiler).toBe(0)
  })

  it('无 truths → 无剧透丢弃', () => {
    const res = assembleSupplement({
      candidates: [cand('c1', '书房里账簿摊开。', 5300, 0.6)],
      gaps: gaps(),
      dossier: dossier([]),
      currentScene: 's1',
    })
    expect(res.blocks).toHaveLength(1)
    expect(res.droppedSpoiler).toBe(0)
  })
})

describe('supplementAssembly: 与档案块高重叠剔除', () => {
  it('块与场景档案文本高度重叠 → 剔除（档案已有的不再喂一遍）', () => {
    const d = dossier()
    // 与 s1 的 sceneText 近乎逐字相同
    const dup = d.scenes[0].sceneText
    const res = assembleSupplement({
      candidates: [cand('dup', dup, 300, 0.9), cand('fresh', '窗外的雨声盖过了交谈。', 900, 0.5)],
      gaps: gaps(),
      dossier: d,
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['fresh'])
    expect(res.droppedOverlap).toBe(1)
  })

  it('只是少量词面重合 → 保留（阈值判定，不是有任何重合就丢）', () => {
    const d = dossier()
    const res = assembleSupplement({
      candidates: [cand('partial', '门厅里挂着吊灯，墙上还留着一道新鲜抓痕。', 300, 0.8)],
      gaps: gaps(),
      dossier: d,
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['partial'])
    expect(res.droppedOverlap).toBe(0)
  })

  it('重叠比对是"块 vs 该块所属场景的档案文本"，不是全档案', () => {
    const d = dossier()
    // 块与 s2 档案文本重合，但归属 s1 → 不属于"当前档案内容重复"
    const res = assembleSupplement({
      candidates: [cand('x', d.scenes[1].sceneText, 300, 0.7)],
      gaps: gaps(),
      dossier: d,
      currentScene: 's1',
    })
    expect(res.blocks).toHaveLength(1)
    expect(res.droppedOverlap).toBe(0)
  })

  it('阈值常量可核（OVERLAP_DROP_RATIO 用于判定，不是魔数散落）', () => {
    expect(OVERLAP_DROP_RATIO).toBeGreaterThan(0)
    expect(OVERLAP_DROP_RATIO).toBeLessThanOrEqual(1)
  })
})

describe('supplementAssembly: 排序（场景内优先 → 无归属次之 → 跨场景最后）', () => {
  it('场景内块排在最前，其次无归属，跨场景最后（分数只在同级内起作用）', () => {
    const res = assembleSupplement({
      candidates: [
        cand('cross', '未来场景的描写。', 5600, 0.99), // 落在 s2 区域（但 s2 非当前场景）
        cand('none', '两场景之间的过渡段。', 3000, 0.98),
        cand('in', '门厅铜灯的光晕。', 400, 0.10),
      ],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
      maxCross: 1,
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['in', 'none', 'cross'])
  })

  it('同级内按分数降序', () => {
    // 三块都在当前场景末锚点附近（s1 锚点 300 → 场景内上界 600），确保同属"场景内"
    const res = assembleSupplement({
      candidates: [cand('a', '门厅 A。', 400, 0.2), cand('b', '门厅 B。', 450, 0.9), cand('c', '门厅 C。', 500, 0.5)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['b', 'c', 'a'])
  })

  it('场景内收窄：末锚点之后（信封尾巴）的块按"场景外"处理并带前缀（审查发现）', () => {
    // s1 末锚点 300 → 场景内上界 600；offset 1500 仍在 T4 信封内（[0,2800)）却已越过上界
    const res = assembleSupplement({
      candidates: [cand('tail', '门厅之后的一段描写。', 1500, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks).toHaveLength(1)
    expect(res.blocks[0].attribution).toBe('single') // T4 归属仍如实报告
    expect(res.blocks[0].crossScene).toBe(true) // 但装配按场景外处理
    expect(res.section).toContain(CROSS_SCENE_PREFIX)
  })

  it('无当前场景 → 无"场景内"排名，全部按无归属/跨场景处理', () => {
    const res = assembleSupplement({
      candidates: [cand('in', '门厅铜灯。', 400, 0.1), cand('none', '过渡段。', 3000, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: '',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['none', 'in'])
  })
})

describe('supplementAssembly: 跨场景块至多 1 条 + 前缀', () => {
  it('跨场景块最多 1 条（其余丢弃）', () => {
    const g = gaps()
    // 让 s1 与 s2 区域重叠 → 落在重叠区的块判为 cross
    g.sceneAnchors = [
      { id: 's1', name: '门厅', matched: true, starts: [300] },
      { id: 's2', name: '书房', matched: true, starts: [2000] },
    ]
    const res = assembleSupplement({
      candidates: [cand('x1', '重叠区描写一。', 2100, 0.9), cand('x2', '重叠区描写二。', 2200, 0.8)],
      gaps: g,
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks.filter((b) => b.attribution === 'cross')).toHaveLength(1)
    expect(res.blocks[0].id).toBe('x1') // 分数更高的那条
  })

  it('跨场景块在渲染文本里带「未来场景片段·不得向玩家揭示」前缀', () => {
    const g = gaps()
    g.sceneAnchors = [
      { id: 's1', name: '门厅', matched: true, starts: [300] },
      { id: 's2', name: '书房', matched: true, starts: [2000] },
    ]
    const res = assembleSupplement({
      candidates: [cand('x1', '重叠区描写一。', 2100, 0.9)],
      gaps: g,
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.section).toContain(CROSS_SCENE_PREFIX)
    expect(res.blocks[0].crossScene).toBe(true)
  })

  it('maxCross=0 → 跨场景块全丢', () => {
    const g = gaps()
    g.sceneAnchors = [
      { id: 's1', name: '门厅', matched: true, starts: [300] },
      { id: 's2', name: '书房', matched: true, starts: [2000] },
    ]
    const res = assembleSupplement({
      candidates: [cand('x1', '重叠区描写一。', 2100, 0.9)],
      gaps: g,
      dossier: dossier(),
      currentScene: 's1',
      maxCross: 0,
    })
    expect(res.blocks).toEqual([])
  })

  it('缺省跨场景上限 = MAX_CROSS_SCENE_CHUNKS（1）', () => {
    expect(MAX_CROSS_SCENE_CHUNKS).toBe(1)
  })
})

describe('supplementAssembly: 预算与条数', () => {
  it('总字符不超 1.6k（含标题/前缀等渲染开销）', () => {
    const res = assembleSupplement({
      candidates: [
        cand('big1', LONG('甲').repeat(3), 400, 0.9),
        cand('big2', LONG('乙').repeat(3), 600, 0.8),
        cand('big3', LONG('丙').repeat(3), 800, 0.7),
      ],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.section.length).toBeLessThanOrEqual(SUPPLEMENT_BUDGET_CHARS)
    expect(res.chars).toBeLessThanOrEqual(SUPPLEMENT_BUDGET_CHARS)
  })

  it('预算不足时丢弃整条（不截断半句留残缺描写）', () => {
    const res = assembleSupplement({
      candidates: [cand('a', LONG('甲').repeat(2), 400, 0.9), cand('big', LONG('乙').repeat(3), 600, 0.8)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
      budgetChars: 900,
    })
    // 第一条能放下；第二条超预算 → 整条丢弃
    expect(res.blocks.map((b) => b.id)).toEqual(['a'])
    expect(res.section).not.toContain('乙')
  })

  it('至多 MAX_SUPPLEMENT_CHUNKS 条（默认 3）', () => {
    expect(MAX_SUPPLEMENT_CHUNKS).toBe(3)
    const many = Array.from({ length: 8 }, (_, i) => cand(`c${i}`, `短句${i}。`, 400 + i, 0.9 - i * 0.01))
    const res = assembleSupplement({ candidates: many, gaps: gaps(), dossier: dossier(), currentScene: 's1' })
    expect(res.blocks.length).toBeLessThanOrEqual(MAX_SUPPLEMENT_CHUNKS)
  })

  it('单条候选本身超预算 → 该条被丢（不当成"部分可用"）', () => {
    const res = assembleSupplement({
      candidates: [cand('huge', LONG('超').repeat(10), 400, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks).toEqual([])
    expect(res.section).toBe('')
  })

  it('空小节：无块时 section 为空串（调用方据此不追加任何内容）', () => {
    const res = assembleSupplement({ candidates: [], gaps: gaps(), dossier: dossier(), currentScene: 's1' })
    expect(res.section).toBe('')
    expect(renderSupplement([])).toBe('')
  })
})

describe('supplementAssembly: 小节形态', () => {
  it('渲染为独立小节，标题为 spec 指定文案', () => {
    expect(SUPPLEMENT_HEADING).toBe('## 原文片段（检索补充·仅作描写素材）')
    const res = assembleSupplement({
      candidates: [cand('c1', '铜灯下的地毯泛着暗红。', 400, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.section.startsWith(SUPPLEMENT_HEADING)).toBe(true)
    expect(res.section).toContain('铜灯下的地毯泛着暗红。')
  })

  it('块文本原样保留（不加工、不改写——它是原文素材）', () => {
    const text = '原文的措辞与具体数字：37 英尺、夜里十一点半。'
    const res = assembleSupplement({
      candidates: [cand('c1', text, 400, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.section).toContain(text)
  })

  it('结构化返回供 wire 采样消费（块文本/分数/归属/是否跨场景）', () => {
    const res = assembleSupplement({
      candidates: [cand('c1', '铜灯。', 400, 0.77)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks[0]).toMatchObject({
      id: 'c1',
      score: 0.77,
      attribution: 'single',
      crossScene: false,
      text: '铜灯。',
    })
    expect(res.chars).toBe(res.section.length)
  })

  it('same content dedup：内容相同的块只留分最高的一条', () => {
    const res = assembleSupplement({
      candidates: [cand('a', '同一段原文。', 400, 0.4), cand('b', '同一段原文。', 500, 0.9)],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.blocks.map((b) => b.id)).toEqual(['b'])
  })
})

describe('supplementAssembly: 纯函数（无 IO、不改入参）', () => {
  it('同输入同输出；不 mutate 传入的候选数组/对象', () => {
    const candidates = [cand('c1', '铜灯。', 400, 0.9), cand('c2', '地毯。', 500, 0.8)]
    const snapshot = JSON.stringify(candidates)
    const a = assembleSupplement({ candidates, gaps: gaps(), dossier: dossier(), currentScene: 's1' })
    const b = assembleSupplement({ candidates, gaps: gaps(), dossier: dossier(), currentScene: 's1' })
    expect(a.section).toBe(b.section)
    expect(JSON.stringify(candidates)).toBe(snapshot)
  })

  it('对畸形输入不抛：gaps/dossier 为 null、字符串 score、缺 start', () => {
    expect(() =>
      assembleSupplement({
        candidates: [
          { id: 'x', content: 'x', start: Number.NaN, score: Number.NaN },
          { id: 'y', content: 'y', start: 400, score: '0.5' as unknown as number },
        ],
        gaps: null,
        dossier: null,
        currentScene: 's1',
      }),
    ).not.toThrow()
  })

  it('候选数组为 null → 空小节', () => {
    const res = assembleSupplement({
      candidates: null as unknown as SupplementCandidate[],
      gaps: gaps(),
      dossier: dossier(),
      currentScene: 's1',
    })
    expect(res.section).toBe('')
  })
})

describe('supplementAssembly: 检索编排（注入缝，不触网）', () => {
  it('编排：query → 向量 top10 → 重排 top3；重排器可用时不打降级标记', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [
      { id: 'c1', content: '门厅的铜灯。', start: 400, score: 0.9 },
      { id: 'c2', content: '地毯的暗红。', start: 500, score: 0.8 },
      { id: 'c3', content: '窗外的雨。', start: 600, score: 0.7 },
      { id: 'c4', content: '壁炉的灰。', start: 700, score: 0.6 },
    ])
    // 重排器返回 {index, score}（顺序不限）：把第三条判为最相关
    const rerank = vi.fn(async (_q: string, passages: string[]) =>
      passages.map((_, i) => ({ index: i, score: i === 2 ? 0.9 : 0.1 })),
    )
    const res = await retrieveSupplement({ query: '门厅', retrieve, rerank, topN: 3 })
    expect(retrieve).toHaveBeenCalledWith('门厅')
    expect(res.candidates[0].id).toBe('c3')
    expect(res.candidates[0].score).toBeCloseTo(0.9)
    expect(res.degraded).toBe(false)
  })

  it('重排器返回乱序分数 → 由编排自行排序（不假设注入方已排序）', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [
      { id: 'a', content: 'a', start: 1, score: 0.9 },
      { id: 'b', content: 'b', start: 2, score: 0.8 },
      { id: 'c', content: 'c', start: 3, score: 0.7 },
    ])
    const res = await retrieveSupplement({
      query: 'q',
      retrieve,
      rerank: async () => [
        { index: 0, score: 0.1 },
        { index: 1, score: 0.5 },
        { index: 2, score: 0.9 },
      ],
    })
    expect(res.candidates.map((c) => c.id)).toEqual(['c', 'b', 'a'])
  })

  it('重排器返回全越界下标 → 视同降级，回退余弦 topN', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [{ id: 'a', content: 'a', start: 1, score: 0.9 }])
    const res = await retrieveSupplement({ query: 'q', retrieve, rerank: async () => [{ index: 99, score: 1 }] })
    expect(res.degraded).toBe(true)
    expect(res.candidates.map((c) => c.id)).toEqual(['a'])
  })

  it('重排器失败（返回 null）→ 余弦 top3 且打降级标记', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [
      { id: 'c1', content: 'a', start: 400, score: 0.9 },
      { id: 'c2', content: 'b', start: 500, score: 0.8 },
    ])
    const res = await retrieveSupplement({ query: 'q', retrieve, rerank: async () => null })
    expect(res.degraded).toBe(true)
    expect(res.candidates.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('未注入重排器 → 直接用余弦结果（同样打降级标记）', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [{ id: 'c1', content: 'a', start: 400, score: 0.9 }])
    const res = await retrieveSupplement({ query: 'q', retrieve })
    expect(res.degraded).toBe(true)
    expect(res.candidates).toHaveLength(1)
  })

  it('检索失败 → 空候选 + error，不抛出', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const res = await retrieveSupplement({
      query: 'q',
      retrieve: async () => {
        throw new Error('index missing')
      },
    })
    expect(res.candidates).toEqual([])
    expect(res.error).toContain('index missing')
  })

  it('空 query → 空候选，不检索', async () => {
    const { retrieveSupplement } = await import('../supplementAssembly.js')
    const retrieve = vi.fn(async () => [{ id: 'c1', content: 'a', start: 400, score: 0.9 }])
    const res = await retrieveSupplement({ query: '  ', retrieve })
    expect(retrieve).not.toHaveBeenCalled()
    expect(res.candidates).toEqual([])
  })
})

describe('supplementService: 端到端编排（注入缝，不触网不加载模型）', () => {
  const GAPS: CoverageGaps = {
    storyChars: 20000,
    sceneTextChars: 0,
    gapCount: 0,
    gapChars: 0,
    gapPct: 0,
    spans: [],
    sceneAnchors: [
      { id: 's1', name: '门厅', matched: true, starts: [300] },
      { id: 's2', name: '书房', matched: true, starts: [5300] },
    ],
  }
  const DOSSIER = dossier([{ revealScene: 's2' }])

  /** 向量检索假实现：按距离返回候选（distance = 1 - score）。 */
  function fakeVectors(chunks: { id: string; content: string; start: number; distance: number }[]) {
    return vi.fn(async () => ({
      chunks: chunks.map((c) => ({ id: c.id, content: c.content, metadata: { start: c.start }, distance: c.distance })),
    }))
  }

  it('端到端：query → 向量 → 重排 → 装配；剧透块被丢弃，场景内块保留', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const queryVectors = fakeVectors([
      { id: 'in-scene', content: '门厅的铜灯泛着暖光，地毯是深红色的。', start: 400, distance: 0.2 },
      { id: 'spoiler', content: '书房里，管家承认了一切。', start: 5300, distance: 0.1 },
    ])
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '【爱丽丝】我想看看门厅', sceneName: '门厅' },
      {
        queryVectors,
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        // 假重排：保持余弦顺序
        rerank: async (_q, passages) => passages.map((_, i) => ({ index: i, score: 1 - i * 0.1 })),
      },
    )
    expect(res.section).toContain('## 原文片段（检索补充·仅作描写素材）')
    expect(res.section).toContain('铜灯')
    expect(res.section).not.toContain('管家承认了一切')
    expect(res.droppedSpoiler).toBe(1)
    expect(res.blocks[0].attribution).toBe('single')
    expect(res.degraded).toBe(false)
    expect(res.revealRegions).toBe(1)
  })

  it('总开关关闭 → 不检索（零 queryVectors 调用）、空小节', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const queryVectors = fakeVectors([{ id: 'a', content: '门厅的铜灯。', start: 400, distance: 0.2 }])
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看', sceneName: '门厅', enabled: false },
      { queryVectors, loadGaps: async () => GAPS, loadDossier: async () => DOSSIER },
    )
    expect(queryVectors).not.toHaveBeenCalled()
    expect(res.section).toBe('')
    expect(res.blocks).toEqual([])
  })

  it('重排器不可用 → 纯余弦 top3 + 降级标记，小节照常产出', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([{ id: 'a', content: '门厅的铜灯。', start: 400, distance: 0.2 }]),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        rerank: async () => null,
      },
    )
    expect(res.degraded).toBe(true)
    expect(res.section).toContain('铜灯')
  })

  it('注入量硬约束：小节 ≤1.6k 字符', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const long = '描写'.repeat(600)
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([
          { id: 'a', content: long, start: 400, distance: 0.1 },
          { id: 'b', content: long, start: 500, distance: 0.2 },
        ]),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        rerank: async (_q, p) => p.map((_, i) => ({ index: i, score: 1 - i * 0.1 })),
      },
    )
    expect(res.chars).toBeLessThanOrEqual(1_600)
  })

  it('无档案（gaps/dossier 均 null）→ 归属全 none、闸门不生效，仍能注入纹理', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([{ id: 'a', content: '门厅的铜灯泛着暖光。', start: 400, distance: 0.2 }]),
        loadGaps: async () => null,
        loadDossier: async () => null,
        rerank: async (_q, p) => p.map((_, i) => ({ index: i, score: 1 - i * 0.1 })),
      },
    )
    expect(res.section).toContain('铜灯')
    expect(res.blocks[0].attribution).toBe('none')
    expect(res.blocks[0].crossScene).toBe(false)
  })

  it('检索抛错 → 空小节 + error，不抛出（回合不中断）', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看', sceneName: '门厅' },
      {
        queryVectors: async () => {
          throw new Error('index missing')
        },
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
      },
    )
    expect(res.section).toBe('')
    expect(res.error).toContain('index missing')
  })

  it('开局（无玩家文本）→ query 退化为纯场景名，仍检索', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const queryVectors = fakeVectors([{ id: 'a', content: '门厅的铜灯。', start: 400, distance: 0.2 }])
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', sceneName: '门厅' },
      {
        queryVectors,
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        rerank: async (_q, p) => p.map((_, i) => ({ index: i, score: 1 - i * 0.1 })),
      },
    )
    expect(queryVectors).toHaveBeenCalledWith(expect.objectContaining({ query: '门厅' }))
    expect(res.section).toContain('铜灯')
  })

  it('投影真值：distance → score 取反（0.1 距离应比 0.2 距离更靠前）', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([
          { id: 'far', content: '远处的雾。', start: 400, distance: 0.9 },
          { id: 'near', content: '铜灯的光。', start: 500, distance: 0.1 },
        ]),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        // 必须显式注入假重排：不注入会落到真实模型路径，可能触发 279MB 下载（审查发现）
        rerank: async () => null,
      },
    )
    expect(res.blocks[0].id).toBe('near')
    expect(res.blocks[0].score).toBeCloseTo(0.9)
    expect(res.degraded).toBe(true)
  })

  it('剧透闸门 fail closed：有揭晓区域但块无有效偏移（旧索引）→ 一律丢弃', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        // 旧索引：metadata 无 start（或 start: null）
        queryVectors: async () => ({
          chunks: [
            { id: 'nostart', content: '某段无偏移的原文。', metadata: {}, distance: 0.1 },
            { id: 'nullstart', content: '另一段 null 偏移的原文。', metadata: { start: null }, distance: 0.2 },
          ],
        }),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER, // DOSSIER 有一条 revealScene=s2 的真相
        rerank: async () => null,
      },
    )
    expect(res.blocks).toEqual([])
    expect(res.section).toBe('')
    expect(res.droppedSpoiler).toBe(2)
  })

  it('无揭晓区域时，无偏移块仍可注入（闸门不该在无剧透风险时误杀）', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: async () => ({ chunks: [{ id: 'nostart', content: '无偏移的原文描写。', metadata: {}, distance: 0.1 }] }),
        loadGaps: async () => GAPS,
        loadDossier: async () => dossier([]), // 无 truths → 无揭晓区域
        rerank: async () => null,
      },
    )
    expect(res.blocks.map((b) => b.id)).toEqual(['nostart'])
    expect(res.blocks[0].attribution).toBe('none')
  })

  it('重排同步抛错 → 降级余弦，不抛出（"永不抛出"须覆盖同步异常）', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([{ id: 'a', content: '门厅的铜灯。', start: 400, distance: 0.2 }]),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        rerank: () => {
          throw new Error('scorer exploded')
        },
      },
    )
    expect(res.degraded).toBe(true)
    expect(res.section).toContain('铜灯')
  })

  it('onEvent 回调抛错 → 不影响回合结果', async () => {
    const { buildSupplement } = await import('../supplementService.js')
    const res = await buildSupplement(
      { userId: 1, scriptId: 'st1', playerText: '看看门厅', sceneName: '门厅' },
      {
        queryVectors: fakeVectors([{ id: 'a', content: '门厅的铜灯。', start: 400, distance: 0.2 }]),
        loadGaps: async () => GAPS,
        loadDossier: async () => DOSSIER,
        rerank: async () => null,
        onEvent: () => {
          throw new Error('trace sink down')
        },
      },
    )
    expect(res.section).toContain('铜灯')
  })
})

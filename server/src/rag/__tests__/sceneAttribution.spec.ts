/**
 * 场景归属 spec（M1-T4 / issue #47，TDD）。
 *
 * 契约（spec #44 / ADR-0007 决策 4/8、CONTEXT「场景归属」）：
 *  - **纯函数**：块只落盘字符偏移，查询期用 coverageGaps 的 sceneAnchors 现算归属；
 *  - 场景原文区域 = 锚点窗口 `[start-LEAD, start+SPAN]`（与 coverageGaps 的
 *    SceneCoverage / originalLookup 的取文窗口同口径，共享同一对常量）；
 *  - 命中单场景窗口 → `single`；跨多个场景窗口 → `cross`；不命中任何窗口 → `none`；
 *  - 无 gaps / 无锚点 / 输入畸形 → 全部 `none`，**不抛异常**。
 */
import { describe, it, expect } from 'vitest'
import {
  attributeChunks,
  computeSceneWindows,
  SCENE_REGION_LEAD,
  SCENE_REGION_SPAN,
} from '../sceneAttribution.js'
import type { CoverageGaps } from '../dossier/coverageGaps.js'

/** 三个互不重叠的场景锚点（0 / 5000 / 10000）——窗口 [0,2500] [4700,7500] [9700,12500]。 */
function gapsThree(): CoverageGaps {
  return {
    storyChars: 20000,
    sceneTextChars: 3000,
    gapCount: 0,
    gapChars: 0,
    gapPct: 0,
    spans: [],
    sceneAnchors: [
      { id: 's1', name: '门厅', matched: true, starts: [0] },
      { id: 's2', name: '书房', matched: true, starts: [5000] },
      { id: 's3', name: '地窖', matched: true, starts: [10000] },
    ],
  }
}

/** 单块简写（偏移 + 长度）。 */
function chunk(start: number, len = 100): { content: string; start: number } {
  return { content: 'x'.repeat(len), start }
}

describe('sceneAttribution: 窗口计算', () => {
  it('区域 = [首锚点-LEAD, 末锚点+SPAN]，共用 coverageGaps 的常量（不各自写一份）', () => {
    expect(SCENE_REGION_LEAD).toBe(300)
    expect(SCENE_REGION_SPAN).toBe(2500)
    const w = computeSceneWindows(gapsThree())
    expect(w.get('s1')).toEqual({ start: 0, end: 2500 })
    expect(w.get('s2')).toEqual({ start: 4700, end: 7500 })
  })

  it('多锚点场景取包络（首锚点-LEAD .. 末锚点+SPAN）——与 coveragePct 的区域同一定义', () => {
    const gaps = gapsThree()
    gaps.sceneAnchors = [{ id: 'a', name: 'A', matched: true, starts: [1000, 4000] }]
    expect(computeSceneWindows(gaps).get('a')).toEqual({ start: 700, end: 6500 })
  })

  it('无 gaps / 无锚点场景 → 无窗口（该场景永不命中）', () => {
    expect(computeSceneWindows(null).size).toBe(0)
    const gaps = gapsThree()
    gaps.sceneAnchors = [{ id: 'sx', name: '无锚', matched: false }]
    expect(computeSceneWindows(gaps).size).toBe(0)
  })

  it('畸形输入不进窗口：非有限偏移 / NaN / 空数组', () => {
    const gaps = gapsThree()
    gaps.sceneAnchors = [
      { id: 'bad', name: 'bad', matched: true, starts: [Number.NaN, Number.POSITIVE_INFINITY] },
      { id: 'ok', name: 'ok', matched: true, starts: [1000] },
    ]
    const w = computeSceneWindows(gaps)
    expect(w.has('bad')).toBe(false)
    expect(w.get('ok')).toEqual({ start: 700, end: 3500 })
  })
})

describe('sceneAttribution: 单场景命中', () => {
  it('块落在场景窗口内 → single + 该场景', () => {
    const res = attributeChunks(gapsThree(), [chunk(1000)])
    expect(res).toHaveLength(1)
    expect(res[0].kind).toBe('single')
    expect(res[0].scenes.map((s) => s.id)).toEqual(['s1'])
    expect(res[0].primary?.name).toBe('门厅')
  })

  it('多个块各自归属到不同场景（按输入顺序一一对应）', () => {
    const res = attributeChunks(gapsThree(), [chunk(0), chunk(5000), chunk(10000)])
    expect(res.map((r) => r.kind)).toEqual(['single', 'single', 'single'])
    expect(res.map((r) => r.primary?.id)).toEqual(['s1', 's2', 's3'])
  })

  it('场景内块（当前场景）与 outro 场景块区分——归属 id 就是档案场景 id', () => {
    const res = attributeChunks(gapsThree(), [chunk(4900, 200)])
    expect(res[0].kind).toBe('single')
    expect(res[0].primary?.id).toBe('s2')
    expect(res[0].scenes).toHaveLength(1)
  })
})

describe('sceneAttribution: 无归属', () => {
  it('块落在所有窗口之外 → none', () => {
    const res = attributeChunks(gapsThree(), [chunk(3000)])
    expect(res[0].kind).toBe('none')
    expect(res[0].scenes).toEqual([])
    expect(res[0].primary).toBeUndefined()
  })

  it('位于两个窗口之间（场景之间的过渡段）→ none', () => {
    // s1 窗口止于 2500，s2 窗口起于 4700
    expect(attributeChunks(gapsThree(), [chunk(2600, 200)])[0].kind).toBe('none')
  })
})

describe('sceneAttribution: 跨场景', () => {
  it('块同时落在两个场景窗口 → cross（列出全部命中场景）', () => {
    // s1 窗口 [0,2500]，s2 窗口 [4700,7500] 不叠；用多锚点场景造重叠
    const gaps = gapsThree()
    gaps.sceneAnchors = [
      { id: 'a', name: 'A', matched: true, starts: [1000] },
      { id: 'b', name: 'B', matched: true, starts: [2600] },
    ]
    // a 窗口 [700,3500]，b 窗口 [2300,5100] → 重叠区 [2300,3500]
    const res = attributeChunks(gaps, [chunk(2800, 100)])
    expect(res[0].kind).toBe('cross')
    expect(res[0].scenes.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('多锚点场景：锚点之间的间隔仍归属该场景（同一场景正文，不是跨场景/无归属）', () => {
    const gaps = gapsThree()
    gaps.sceneAnchors = [
      { id: 'a', name: 'A', matched: true, starts: [1000, 4000] },
      { id: 'b', name: 'B', matched: true, starts: [9000] },
    ]
    // a 的锚点窗口 [700,3500] 与 [3700,6500] 合并为 [700,6500]（锚点间隔 [3500,3700]
    // 只是采样缝隙，块落在其中仍是该场景的正文）
    const across = attributeChunks(gaps, [chunk(3550, 60)])
    expect(across[0].kind).toBe('single')
    expect(across[0].primary?.id).toBe('a')
    // 缝隙两侧各自的块同样归属 a（不是部分命中、不是 none）
    for (const at of [3400, 3750]) {
      const r = attributeChunks(gaps, [chunk(at, 50)])
      expect(r[0].kind).toBe('single')
      expect(r[0].primary?.id).toBe('a')
    }
  })
})

describe('sceneAttribution: 窗口边界（start-300 / start+2500 两侧）', () => {
  it('块起点恰在 start-LEAD → 命中', () => {
    expect(attributeChunks(gapsThree(), [chunk(4700, 100)])[0].kind).toBe('single')
  })

  it('块终点恰在 start-LEAD（紧贴左侧）→ 不命中', () => {
    expect(attributeChunks(gapsThree(), [chunk(4600, 100)])[0].kind).toBe('none')
  })

  it('块终点恰在 anchor+SPAN → 命中', () => {
    const res = attributeChunks(gapsThree(), [chunk(2400, 100)])
    expect(res[0].kind).toBe('single')
    expect(res[0].primary?.id).toBe('s1')
  })

  it('块终点越过 anchor+SPAN 一字符 → 仍命中（只要与窗口有交叠）', () => {
    // s1 窗口 [0,2500]；块 [2401,2501] 越界 1 字符但仍与窗口交叠
    const res = attributeChunks(gapsThree(), [chunk(2401, 100)])
    expect(res[0].kind).toBe('single')
    expect(res[0].primary?.id).toBe('s1')
  })

  it('块整体越过 anchor+SPAN（起点已在窗口右侧）→ 不命中', () => {
    // s1 窗口止于 2500，s2 窗口起于 4700 → [2501,2601] 落在两窗之间
    expect(attributeChunks(gapsThree(), [chunk(2501, 100)])[0].kind).toBe('none')
  })

  it('块跨越窗口右边界进入下一场景 → cross', () => {
    const gaps = gapsThree()
    gaps.sceneAnchors = [
      { id: 'a', name: 'A', matched: true, starts: [1000] },
      { id: 'b', name: 'B', matched: true, starts: [3000] },
    ]
    // a 窗口 [700,3500]，b 窗口 [2700,5500]
    const res = attributeChunks(gaps, [chunk(3400, 200)])
    expect(res[0].kind).toBe('cross')
  })
})

describe('sceneAttribution: 安全降级（不抛异常）', () => {
  it('gaps 为 null → 全部 none', () => {
    const res = attributeChunks(null, [chunk(0), chunk(5000)])
    expect(res.map((r) => r.kind)).toEqual(['none', 'none'])
  })

  it('gaps 无 sceneAnchors → 全部 none', () => {
    const gaps = { ...gapsThree(), sceneAnchors: [] }
    expect(attributeChunks(gaps, [chunk(1000)])[0].kind).toBe('none')
  })

  it('块偏移畸形（NaN / 负数 / 非数字）→ none，不抛', () => {
    const res = attributeChunks(gapsThree(), [
      { content: 'x', start: Number.NaN },
      { content: 'x', start: -5 },
      { content: 'x', start: undefined as unknown as number },
    ])
    expect(res.map((r) => r.kind)).toEqual(['none', 'none', 'none'])
  })

  it('空块列表 → 空结果', () => {
    expect(attributeChunks(gapsThree(), [])).toEqual([])
  })

  it('返回顺序与输入一一对应（下标稳定）', () => {
    const res = attributeChunks(gapsThree(), [chunk(1000), chunk(3000), chunk(5000)])
    expect(res.map((r) => r.index)).toEqual([0, 1, 2])
  })
})

/**
 * 场景归属（M1-T4 / issue #47，spec #44 / ADR-0007 决策 4）——检索补充层的
 * **查询期现算**归属：索引只落盘字符偏移，档案重生成后归属自动跟随，无需重建索引。
 *
 * 场景原文区域 = 锚点窗口 `[anchor-LEAD, anchor+SPAN)`，与 coverageGaps 的
 * `computeSceneCoverage`（场景级覆盖度）和 originalLookup 的取文窗口**共享同一对
 * 常量**（`SCENE_REGION_LEAD/SPAN` 由 coverageGaps 定义、此处 re-export）——
 * 三处各写一份会静默漂移（P26 审查教训）。
 *
 * 纯函数，无 IO/模型；输入畸形一律降级为「无归属」，绝不抛异常。
 */
import {
  SCENE_REGION_LEAD,
  SCENE_REGION_SPAN,
} from './dossier/regions.js'
import type { CoverageGaps } from './dossier/coverageGaps.js'

export { SCENE_REGION_LEAD, SCENE_REGION_SPAN }

/** 块在原文中的位置（只需偏移与长度；内容由调用方保留）。 */
export interface OffsetChunk {
  start: number
  /** 块内容（只取长度；可缺省——缺省时按零宽点处理）。 */
  content?: string
  /** 显式长度覆盖（content 不可用时）。 */
  length?: number
}

export interface SceneRef {
  id: string
  name: string
}

export interface Attribution {
  /** 输入下标（与传入块数组一一对应）。 */
  index: number
  kind: 'single' | 'cross' | 'none'
  /** 命中场景（按锚点位置升序；cross 含 ≥2 个，none 为空）。 */
  scenes: SceneRef[]
  /** 主场景：single = 该场景；cross = 锚点最靠前的命中场景（供排序/取证）。 */
  primary?: SceneRef
}

export interface Window {
  start: number
  end: number
}

/** 块长度：优先显式 length，其次 content 长度；都不可用则 0（零宽点）。 */
function chunkLength(c: OffsetChunk): number {
  if (Number.isFinite(c?.length)) return Math.max(0, c.length as number)
  const content = c?.content
  return typeof content === 'string' ? content.length : 0
}

/**
 * 每场景的原文区域（纯函数）：`[首锚点-LEAD, 末锚点+SPAN)` —— 与
 * coverageGaps.computeSceneCoverage 算 coveragePct 所用的区域**同一口径**
 * （区别仅在两处对 `storyChars` 的钳制：那边把 `end` 夹到原文长度并可能返回 null，
 * 这里不持原文长度、依赖"块不可能越出原文"这一事实）。
 *
 * 为什么取包络而不是"每个锚点各一个窗口"：档案 sceneText 只覆盖原文 30–60%
 * （gapPct 52–86%），一个场景的锚点之间必然有大段空档。按锚点分窗会让这些空档里的
 * 块落到"无归属"，而它们恰恰是检索补充层最该提供的文本（档案没收录的原文纹理），
 * 却被降级到与全篇无关块同级竞争。取包络后场景内文本稳定归属本场景。
 *
 * 代价（已知且保守）：若两个场景的锚点在原文中交错，两者区域重叠 → 相关块判为
 * 跨场景，装配时按"跨场景至多 1 条 + 加前缀"处理——是安全方向的降级，不泄漏。
 */
export function computeSceneWindows(gaps: CoverageGaps | null | undefined): Map<string, Window> {
  const out = new Map<string, Window>()
  const anchors = Array.isArray(gaps?.sceneAnchors) ? (gaps as CoverageGaps).sceneAnchors : []
  for (const a of anchors) {
    if (!a || typeof a.id !== 'string' || !a.id) continue
    if (!a.matched) continue
    const starts = (Array.isArray(a.starts) ? a.starts : [])
      .filter((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0)
      .sort((x, y) => x - y)
    if (!starts.length) continue
    out.set(a.id, {
      start: Math.max(0, (starts[0] as number) - SCENE_REGION_LEAD),
      end: (starts[starts.length - 1] as number) + SCENE_REGION_SPAN,
    })
  }
  return out
}

/**
 * 给候选块打场景归属（纯函数）。判定是**半开区间交叠**：区域 `[start,end)` 与
 * 块 `[start,start+len)` 满足 `start < end_region && end_chunk > start_region` 才算命中
 * ——块紧贴在区域左边界外侧（`end_chunk === start_region`）不算，块终点越过区域右边界
 * 仍算命中。
 *
 * - 命中 1 个场景 → `single`，≥2 个 → `cross`，0 个 → `none`（按场景区域起点升序给出）；
 * - 无 gaps / 无锚点场景 / 偏移畸形（NaN、负数、零长）→ `none`（安全降级，不抛）。
 */
export function attributeChunks(
  gaps: CoverageGaps | null | undefined,
  chunks: OffsetChunk[] | null | undefined,
): Attribution[] {
  const list = Array.isArray(chunks) ? chunks : []
  const windows = computeSceneWindows(gaps)
  const refs = new Map<string, SceneRef>()
  for (const a of Array.isArray(gaps?.sceneAnchors) ? (gaps as CoverageGaps).sceneAnchors : []) {
    if (a && typeof a.id === 'string' && a.id) refs.set(a.id, { id: a.id, name: typeof a.name === 'string' && a.name ? a.name : a.id })
  }
  /** 场景区域（按起点升序，便于早退）。 */
  const spans = [...windows.entries()]
    .map(([id, w]) => ({ id, ...w }))
    .sort((a, b) => a.start - b.start)

  return list.map((c, index) => {
    const start = typeof c?.start === 'number' && Number.isFinite(c.start) ? c.start : Number.NaN
    const len = chunkLength(c)
    if (!Number.isFinite(start) || start < 0 || len <= 0) {
      return { index, kind: 'none' as const, scenes: [] }
    }
    const end = start + len
    const hits: string[] = []
    for (const s of spans) {
      if (end <= s.start) break // 区域按起点升序：后面的更远
      if (start < s.end) hits.push(s.id)
    }
    if (hits.length === 0) return { index, kind: 'none' as const, scenes: [] }
    const scenes = hits.map((id) => refs.get(id) ?? { id, name: id })
    const primary = scenes[0]
    return { index, kind: hits.length > 1 ? ('cross' as const) : ('single' as const), scenes, primary }
  })
}

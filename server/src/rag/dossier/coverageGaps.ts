/**
 * Coverage gaps（P22，实验分支 feature/kp-dossier-workflow）— "压缩缺失标记"的
 * 可寻址落地：把 coveragePct 单一数字升级为「原文哪些段落没被任何 sceneText
 * 覆盖」的区间清单 + 每场景在原文中的锚点。
 *
 * 动机（用户提议 + P21 原文回退原型结论）：回退原文理解的瓶颈是定位——词面
 * 窗口 1/4 概率漏段落。gap spans 直接回答"档案丢在原文哪里"；sceneAnchors 给
 * 每个场景一个原文起点，运行时回退工具可按场景取 span 内原文，不再靠词面猜。
 *
 * 纯本地计算（无 LLM 调用）：
 *  - 把原文按段落切成块（长段在句末再切 ≤900 字）；
 *  - 块被"覆盖"= 该块的 40 字窗口（0/40/80/120 偏移处取样）逐字出现在任一
 *    sceneText（归一化去空白后）——sceneText 是 LLM 从原文誊抄的，整句复制
 *    是常态；轻度改写只影响取样窗口未覆盖处（宁可多报缺口，不硬编覆盖）；
 *  - 连续未覆盖块合并成 gap span {start,end,chars,preview}；
 *  - sceneAnchors：每场景 sceneText 首段在原文中的近似起点（matched=false 表
 *    示 sceneText 与原文无逐字对应——纯改写/摘要，回退时该场景锚不到原文）。
 *
 * 落盘 DOSSIER_DATA_DIR/<uid>/<sanitize>.gaps.json（明细）；dossier JSON 只带
 * 计数摘要（schema.StoryDossier.coverageGaps）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOSSIER_DATA_DIR } from '../../config.js'
import { resolveFileInDir } from '../../utils/pathSafety.js'
import { sanitizeScriptId, type DossierScene } from './schema.js'
import { SCENE_REGION_LEAD, SCENE_REGION_SPAN, normalizeText } from './regions.js'

/** 太短的段落不计缺口（目录页/占位符等噪声）。 */
const MIN_BLOCK_CHARS = 20
/** 长段在句末切分上限。 */
const MAX_BLOCK_CHARS = 900
/** 覆盖判定窗口长度（逐字匹配样本）。 */
const MATCH_WINDOW = 40
/** 每块取样窗口起始偏移（容忍 sceneText 从段中某处开始誊抄/开头被改写）。 */
const WINDOW_OFFSETS = [0, 40, 80, 120]

export interface GapSpan {
  start: number
  end: number
  chars: number
  /** 段落开头预览（人工/报告复核用）。 */
  preview: string
}

export interface SceneAnchor {
  id: string
  name: string
  matched: boolean
  /** sceneText 逐字誊抄片段在原文中的位置（可多处——LLM 常在前后加衔接语；
   *  空=无逐字对应，纯改写/摘要，回退时该场景锚不到原文）。 */
  starts?: number[]
}

/** 场景原文区域常量 + 文本归一化：单源在 `./regions.js`（极轻模块——查询期模块
 *  不该为了这两个常量被拖进本文件的重依赖链）。此处 re-export 保持既有调用方。 */
export { SCENE_REGION_LEAD, SCENE_REGION_SPAN, normalizeText } from './regions.js'

export interface CoverageGaps {
  storyChars: number
  sceneTextChars: number
  /** 未覆盖区间数（相邻未覆盖块已合并）。 */
  gapCount: number
  gapChars: number
  gapPct: number
  spans: GapSpan[]
  sceneAnchors: SceneAnchor[]
}

export interface CoverageGapsFile extends CoverageGaps {
  scriptId: string
  storyName: string
  generatedAt: number
  /** 算法版本（GAPS_VERSION）：落盘结构/语义变更时递增。旧文件缺该字段 =
   *  版本 1（P26a 之前，gap span 会把紧随的被覆盖块算进缺口 → gapPct 偏高）。 */
  gapsVersion?: number
}

/** 当前 gaps 算法版本。1 = P22 初版；2 = P26a（closeGap 在被覆盖块前收口）。 */
export const GAPS_VERSION = 2

interface Block {
  start: number
  end: number
  text: string
}

/** 原文分块：段落优先（空行分隔），长段在句末/行末切到 ≤MAX_BLOCK_CHARS。 */
export function splitStoryBlocks(storyText: string): Block[] {
  const text = String(storyText ?? '')
  if (!text) return []
  const blocks: Block[] = []
  const pushChunk = (start: number, end: number) => {
    const slice = text.slice(start, end)
    const lead = slice.match(/^\s*/)?.[0].length ?? 0
    const trail = slice.match(/\s*$/)?.[0].length ?? 0
    const content = slice.slice(lead, slice.length - trail)
    if (content.length >= MIN_BLOCK_CHARS) {
      blocks.push({ start: start + lead, end: end - trail, text: content })
    }
  }
  // 段落边界（空行/换行簇）；段落间空白归下段 trim 处理
  const paraBreaks: number[] = []
  const re = /\n[ \t]*\n+/g
  for (const m of text.matchAll(re)) paraBreaks.push(m.index)
  const boundaries = [0, ...paraBreaks.map((p) => p + 1), text.length]
  for (let i = 0; i + 1 < boundaries.length; i++) {
    let start = boundaries[i]
    const end = boundaries[i + 1]
    const slice = text.slice(start, end)
    const lead = slice.match(/^[ \t\n]*/)?.[0].length ?? 0
    start += lead
    const len = end - start
    if (len <= MAX_BLOCK_CHARS) {
      if (len >= MIN_BLOCK_CHARS) pushChunk(start, end)
      continue
    }
    // 长段：从句末/行末切分
    let from = start
    const segEnd = end
    while (segEnd - from > MAX_BLOCK_CHARS) {
      const head = text.slice(from, from + MAX_BLOCK_CHARS)
      const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('”'), head.lastIndexOf('\n'))
      const at = cut >= 30 ? from + cut + 1 : from + MAX_BLOCK_CHARS
      pushChunk(from, at)
      from = at
    }
    pushChunk(from, segEnd)
  }
  return blocks
}

/** 某块是否被任一 sceneText 覆盖：取样窗口逐字出现（归一化后）。 */
function blockCovered(block: Block, normScenes: string[]): boolean {
  const norm = normalizeText(block.text)
  if (norm.length < MATCH_WINDOW) {
    // 短块：整块作为 needle
    return normScenes.some((s) => s.includes(norm))
  }
  const offsets = WINDOW_OFFSETS.filter((o) => o + MATCH_WINDOW <= norm.length)
  if (!offsets.length) offsets.push(0)
  return offsets.some((o) => {
    const needle = norm.slice(o, o + MATCH_WINDOW)
    return normScenes.some((s) => s.includes(needle))
  })
}

/** 在原文中找一个归一化 needle 的（首个）原文偏移。 */
function findRawOffset(rawText: string, needle: string): number {
  const first = needle[0]
  let from = 0
  for (let guard = 0; guard < 200; guard++) {
    const p = rawText.indexOf(first, from)
    if (p < 0) break
    const probe = normalizeText(rawText.slice(p, p + needle.length + 16))
    if (probe.startsWith(needle)) return p
    from = p + 1
  }
  return -1
}

/**
 * sceneText 在原文中的逐字誊抄位置：跨 sceneText 采样（每 120 字一个 40 字窗，
 * 最多 10 个）找命中——LLM 常在誊抄前后加衔接语，只锚头部会大面积漏。
 */
function anchorStartsOf(rawText: string, sceneText: string): number[] {
  const norm = normalizeText(sceneText)
  if (norm.length < 10) return []
  const starts: number[] = []
  const step = 120
  const maxSamples = 10
  const samples = Math.min(maxSamples, Math.floor(norm.length / step) + 1)
  for (let k = 0; k < samples; k++) {
    const off = k * step
    if (off + MATCH_WINDOW > norm.length) break
    const needle = norm.slice(off, off + MATCH_WINDOW)
    const hit = findRawOffset(rawText, needle)
    if (hit >= 0) starts.push(hit)
  }
  return [...new Set(starts)].sort((a, b) => a - b)
}

/**
 * 计算覆盖缺口（纯函数，无 IO）：
 *  - storyText：生成器实际看到的原文（分块偏移即原文偏移）；
 *  - scenes：dossier.scenes（sceneText 为誊抄原文的叙事段）。
 * gapPct = 未覆盖字符 / storyChars（%）。
 */
export function computeCoverageGaps(storyText: string, scenes: DossierScene[]): CoverageGaps {
  const text = String(storyText ?? '')
  const normScenes = (scenes ?? [])
    .map((sc) => normalizeText(sc.sceneText ?? ''))
    .filter((s) => s.length >= MATCH_WINDOW)
  const sceneTextChars = (scenes ?? []).reduce((sum, sc) => sum + String(sc.sceneText ?? '').length, 0)

  const spans: GapSpan[] = []
  let open: Block | null = null
  const closeGap = (end: number) => {
    if (!open) return
    const spanText = text.slice(open.start, end)
    spans.push({ start: open.start, end, chars: end - open.start, preview: normalizeText(spanText).slice(0, 60) })
    open = null
  }
  const blocks = splitStoryBlocks(text)
  for (const b of blocks) {
    if (blockCovered(b, normScenes)) {
      // 缺口在前一个未覆盖块处收口，不用 b.end——P26 修：b.end 会把紧随其后的
      // 被覆盖块一并算进缺口，gapChars/gapPct 系统性偏高
      if (open) closeGap(open.end)
    } else if (open) {
      // 相邻未覆盖块合并（间距 ≤30 字符视作连续——残留空白噪声）
      if (b.start - open.end <= 30) {
        open.end = b.end
      } else {
        closeGap(b.start)
        open = { start: b.start, end: b.end, text: b.text }
      }
    } else {
      open = { start: b.start, end: b.end, text: b.text }
    }
  }
  closeGap(text.length)

  const gapChars = spans.reduce((sum, s) => sum + s.chars, 0)
  const sceneAnchors: SceneAnchor[] = (scenes ?? []).map((sc) => {
    const starts = anchorStartsOf(text, sc.sceneText ?? '')
    return starts.length ? { id: sc.id, name: sc.name, matched: true, starts } : { id: sc.id, name: sc.name, matched: false }
  })
  return {
    storyChars: text.length,
    sceneTextChars,
    gapCount: spans.length,
    gapChars,
    gapPct: text.length ? Math.round((gapChars / text.length) * 1000) / 10 : 0,
    spans,
    sceneAnchors,
  }
}

/* ═══════════════════ 场景级覆盖度（P26） ═══════════════════ */

export interface SceneCoverage {
  sceneId: string
  sceneName: string
  /** 该场景原文区域（首锚点-LEAD .. 末锚点+SPAN）的字符数。 */
  regionChars: number
  /** 区域内未被任何 sceneText 收录的字符数。 */
  gapChars: number
  /** 区域内已收录比例 %（0–100，一位小数；与 schema 的 coveragePct 同向）。 */
  coveragePct: number
  /** 落在该区域内的缺口段数（相邻缺口已合并）。 */
  gapCount: number
}

/**
 * 场景级覆盖度（纯函数，无 IO）：把 story 级 gap spans 按场景锚点区域归属。
 * 用途是给运行时一个"这份场景块不全"的信号（P25 观测：KP 以档案块为完整真源，
 * 从不主动查原文）——coveragePct/gapCount 进场景块提示行，不含任何剧情信息。
 *
 * 无 gaps / 未知场景 / 场景无锚点（纯摘要，matched=false）→ null（调用方保持安静）。
 */
export function computeSceneCoverage(gaps: CoverageGaps | null, sceneIdOrName: string): SceneCoverage | null {
  if (!gaps) return null
  const target = String(sceneIdOrName ?? '').trim()
  if (!target) return null
  const anchor = (gaps.sceneAnchors ?? []).find((a) => a.id === target || a.name === target)
  if (!anchor || !anchor.matched) return null
  const starts = (anchor.starts ?? []).filter((s) => Number.isFinite(s)).sort((a, b) => a - b)
  if (starts.length === 0) return null
  const storyChars = Number.isFinite(gaps.storyChars) ? gaps.storyChars : Number.MAX_SAFE_INTEGER
  const regionStart = Math.max(0, (starts[0] as number) - SCENE_REGION_LEAD)
  const regionEnd = Math.min(storyChars, (starts[starts.length - 1] as number) + SCENE_REGION_SPAN)
  const regionChars = regionEnd - regionStart
  if (regionChars <= 0) return null
  let gapChars = 0
  let gapCount = 0
  for (const sp of gaps.spans ?? []) {
    const overlap = Math.min(sp.end, regionEnd) - Math.max(sp.start, regionStart)
    if (overlap > 0) {
      gapChars += overlap
      gapCount++
    }
  }
  const coveragePct = Math.round((1 - gapChars / regionChars) * 1000) / 10
  return { sceneId: anchor.id, sceneName: anchor.name, regionChars, gapChars, coveragePct, gapCount }
}

/* ═══════════════════ 落盘 / 读取（白名单 + resolve 双保险，同 dossier/annex） ═══════════════════ */

function gapsFile(userId: number, scriptId: string): string {
  const safe = sanitizeScriptId(scriptId)
  return resolveFileInDir(path.join(DOSSIER_DATA_DIR, String(userId)), `${safe}.gaps.json`, 'gaps file')
}

export async function persistGaps(userId: number, gaps: CoverageGapsFile): Promise<void> {
  await fs.mkdir(path.join(DOSSIER_DATA_DIR, String(userId)), { recursive: true })
  const stamped: CoverageGapsFile = { ...gaps, gapsVersion: gaps.gapsVersion ?? GAPS_VERSION }
  await fs.writeFile(gapsFile(userId, gaps.scriptId), JSON.stringify(stamped, null, 2), 'utf-8')
}

export async function loadGaps(userId: number, scriptId: string): Promise<CoverageGapsFile | null> {
  try {
    const raw = await fs.readFile(gapsFile(userId, scriptId), 'utf-8')
    const parsed = JSON.parse(raw) as CoverageGapsFile
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.spans) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 该 gaps 文件是否由当前算法版本算出（缺字段 = 版本 1）。
 * 消费方（覆盖提示）对旧版本文件自行取舍：数值偏高但方向正确，仍可用。
 */
export function isCurrentGapsVersion(gaps: CoverageGapsFile | null): boolean {
  return (gaps?.gapsVersion ?? 1) >= GAPS_VERSION
}

export async function deleteGaps(userId: number, scriptId: string): Promise<boolean> {
  try {
    await fs.unlink(gapsFile(userId, scriptId))
    return true
  } catch {
    return false
  }
}

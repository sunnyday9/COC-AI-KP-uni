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
}

/** 去空白（含换行/全角空格）——誊抄匹配对排版不敏感。 */
export function normalizeText(s: string): string {
  return String(s ?? '').replace(/\s+/g, '')
}

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
      closeGap(b.end)
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

/* ═══════════════════ 落盘 / 读取（白名单 + resolve 双保险，同 dossier/annex） ═══════════════════ */

function gapsFile(userId: number, scriptId: string): string {
  const safe = sanitizeScriptId(scriptId)
  return resolveFileInDir(path.join(DOSSIER_DATA_DIR, String(userId)), `${safe}.gaps.json`, 'gaps file')
}

export async function persistGaps(userId: number, gaps: CoverageGapsFile): Promise<void> {
  await fs.mkdir(path.join(DOSSIER_DATA_DIR, String(userId)), { recursive: true })
  await fs.writeFile(gapsFile(userId, gaps.scriptId), JSON.stringify(gaps, null, 2), 'utf-8')
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

export async function deleteGaps(userId: number, scriptId: string): Promise<boolean> {
  try {
    await fs.unlink(gapsFile(userId, scriptId))
    return true
  } catch {
    return false
  }
}

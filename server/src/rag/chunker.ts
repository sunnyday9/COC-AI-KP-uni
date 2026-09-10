/**
 * 服务端递归语义切块器（M1-T1 / issue #45，spec #44 / ADR-0007）。
 * 索引从"客户端切好块上传"改为"服务端自读自切"——本模块是后者的地基。
 * 契约：
 *  - **纯函数**：同输入同输出，无 IO / 网络 / 模型；
 *  - **递归层级** 标题 → 段落 → 句末标点：任一层切出的片段超过目标长度时继续下沉；
 *  - **字符偏移**：每块带 `start`，`text.slice(start, start + content.length) === content`；
 *  - **重叠**：相邻块在原文上回退 `overlap` 字符（避免切点处信息断裂）；
 *  - 超短片段（< minChunkChars）不单独成块。
 *
 * 与旧客户端切块器的差别（有意）：旧实现按 UTF-16 长度两级切分（段落 → 句末）、
 * 无层级、无偏移；本实现三级递归 + 偏移，且**不与旧索引兼容**（存量索引按新管线重建）。
 */
import type { RAGChunkInput } from './vectorStore.js'

/** chunker 的产出形状与索引输入契约一致（索引编排按序补 id）。 */
export type ChunkerChunkInput = Omit<RAGChunkInput, 'id'>

/** 目标块长（字符）。 */
export const DEFAULT_CHUNK_CHARS = 800
/** 相邻块重叠（字符）。 */
export const DEFAULT_CHUNK_OVERLAP = 100
/** 低于该长度的片段不单独成块（并入相邻块或补齐到最小长度）。 */
export const DEFAULT_MIN_CHUNK_CHARS = 40

export interface ChunkOptions {
  /** 目标块长（字符），缺省 DEFAULT_CHUNK_CHARS。 */
  chunkChars?: number
  /** 相邻块重叠（字符），缺省 DEFAULT_CHUNK_OVERLAP。 */
  overlap?: number
  /** 最小块长（字符），缺省 DEFAULT_MIN_CHUNK_CHARS。 */
  minChunkChars?: number
}

/** 切块产物：内容 + 原文起始偏移（供场景归属与还原）。 */
export interface StoryChunk extends ChunkerChunkInput {
  content: string
  /** 在原文中的起始字符偏移。 */
  start: number
}

interface Span {
  start: number
  content: string
}

/** 句末标点（中英，含收尾引号/括号）。 */
const SENTENCE_END = /[。！？!?]["'”’」』）)]?/

/**
 * 在 [from, to) 内找一个"尽量靠后但不超过 limit"的切点，优先句末标点、其次换行。
 * 返回切点（不含），找不到返回 -1。
 */
function findCutPoint(text: string, from: number, limit: number): number {
  const head = text.slice(from, limit)
  const minKeep = Math.max(1, Math.floor(head.length * 0.5))
  // 句末标点：从后往前找
  for (let i = head.length - 1; i >= minKeep; i--) {
    const m = SENTENCE_END.exec(head.slice(i, i + 3))
    if (m && m.index === 0) {
      let end = i + m[0].length
      // 吞掉紧随其后的空白（不跨到下一句正文）
      while (end < head.length && /\s/.test(head[end] as string)) end++
      return from + end
    }
  }
  // 换行兜底
  const nl = head.lastIndexOf('\n', head.length - 1)
  if (nl >= minKeep) return from + nl + 1
  return -1
}

/** 句末层级：把一段按句子边界切成 ≤ chunkChars 的片段（偏移保留）。 */
function splitBySentences(text: string, start: number, chunkChars: number): Span[] {
  const out: Span[] = []
  let from = 0
  while (from < text.length) {
    const limit = from + chunkChars
    if (limit >= text.length) {
      out.push({ start: start + from, content: text.slice(from) })
      break
    }
    const cut = findCutPoint(text, from, limit)
    const at = cut > from ? cut : limit // 硬切兜底（无句末标点）
    out.push({ start: start + from, content: text.slice(from, at) })
    from = at
  }
  return out
}

/** 段落层级：按空行切段（偏移保留，段内容已 trim 前后空白）。 */
function splitByParagraphs(text: string, start: number): Span[] {
  const out: Span[] = []
  const re = /\n[\t ]*\n+/g
  let from = 0
  for (const m of text.matchAll(re)) {
    pushParagraph(out, text, start, from, m.index)
    from = m.index + m[0].length
  }
  pushParagraph(out, text, start, from, text.length)
  return out
}

function pushParagraph(out: Span[], text: string, base: number, from: number, to: number): void {
  const slice = text.slice(from, to)
  const lead = slice.match(/^[\s]*/)?.[0].length ?? 0
  const trail = slice.match(/[\s]*$/)?.[0].length ?? 0
  const content = slice.slice(lead, slice.length - trail)
  if (content.length > 0) out.push({ start: base + from + lead, content })
}

/** 标题层级：按 Markdown 标题行切分（标题与其后正文同段，不孤立）。 */
function splitByHeadings(text: string, start: number): Span[] {
  const out: Span[] = []
  const re = /^[ \t]*#{1,6}[ \t]+\S/gm
  const marks: number[] = []
  for (const m of text.matchAll(re)) marks.push(m.index)
  if (marks.length === 0) return [{ start, content: text }]
  const bounds = [...new Set([0, ...marks, text.length])].sort((a, b) => a - b)
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i] as number
    const to = bounds[i + 1] as number
    const slice = text.slice(from, to)
    if (slice.length > 0) out.push({ start: start + from, content: slice })
  }
  return out
}

/** 递归：把片段降到目标长度之下（标题 → 段落 → 句末；每层只在超长时才下沉）。 */
function recurse(span: Span, opts: Required<ChunkOptions>): Span[] {
  if (span.content.length <= opts.chunkChars) return [span]
  for (const level of [splitByHeadings, splitByParagraphs]) {
    const parts = level(span.content, span.start)
    if (parts.length > 1) {
      return parts.flatMap((p) => recurse(p, opts))
    }
  }
  const sentences = splitBySentences(span.content, span.start, opts.chunkChars)
  if (sentences.length > 1) return sentences.flatMap((p) => recurse(p, opts))
  return [span]
}

/** 合并相邻片段到目标长度（保序、保留各自起点；重叠在合并阶段不引入）。 */
function packSpans(spans: Span[], opts: Required<ChunkOptions>): Span[] {
  const out: Span[] = []
  let cur: Span | null = null
  for (const s of spans) {
    if (!cur) {
      cur = { ...s }
      continue
    }
    const mergedLen = cur.content.length + 1 + s.content.length
    if (mergedLen <= opts.chunkChars) {
      cur = { start: cur.start, content: `${cur.content}\n${s.content}` }
    } else {
      out.push(cur)
      cur = { ...s }
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 相邻块重叠：把后一块的起点前移 overlap（不越过前一块起点）。 */
function applyOverlap(spans: Span[], text: string, opts: Required<ChunkOptions>): StoryChunk[] {
  if (opts.overlap <= 0) return spans.map((s) => ({ start: s.start, content: s.content }))
  const out: StoryChunk[] = []
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i] as Span
    const prev = spans[i - 1]
    let start = s.start
    if (prev) {
      const want = s.start - opts.overlap
      start = Math.max(prev.start, want)
      if (start < s.start) {
        const content = text.slice(start, start + (s.content.length + (s.start - start)))
        out.push({ start, content })
        continue
      }
    }
    out.push({ start: s.start, content: s.content })
  }
  return out
}

/**
 * 合并过短片段：**按原文区间**取内容（不是拼接片段），保证不丢字符、偏移仍可还原。
 * 过短块并入前一块的区间末尾；首块过短则并入后一块的区间开头。
 */
function mergeTinySpans(text: string, spans: Span[], opts: Required<ChunkOptions>): Span[] {
  if (spans.length <= 1) return spans
  const merged: Span[] = []
  for (const s of spans) {
    const tiny = s.content.trim().length < opts.minChunkChars
    if (!tiny) {
      merged.push(s)
      continue
    }
    const prev = merged[merged.length - 1]
    if (!prev) {
      merged.push(s) // 首块偏短：留给收尾合并
      continue
    }
    // 并入前一块：区间向后延伸（原文区间包含两者及其中间空白）
    prev.content = text.slice(prev.start, s.start + s.content.length)
  }
  // 首块仍偏短且有后继 → 与后继合并（区间从首块起点开始）
  if (merged.length >= 2 && (merged[0] as Span).content.trim().length < opts.minChunkChars) {
    const first = merged[0] as Span
    const second = merged[1] as Span
    merged.splice(0, 2, { start: first.start, content: text.slice(first.start, second.start + second.content.length) })
  }
  return merged
}

/**
 * 递归语义切块：原文 → 带偏移的块数组。
 * 空白归一化（trim 段首尾）不改变偏移语义——每块的 start 指向其内容在原文中的真实起点。
 */
export function chunkStoryText(text: string, options: ChunkOptions = {}): StoryChunk[] {
  const raw = String(text ?? '')
  if (raw.trim().length === 0) return []
  const opts: Required<ChunkOptions> = {
    chunkChars: options.chunkChars ?? DEFAULT_CHUNK_CHARS,
    overlap: options.overlap ?? DEFAULT_CHUNK_OVERLAP,
    minChunkChars: options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS,
  }
  const root: Span = { start: 0, content: raw }
  const leaves = recurse(root, opts)
  const packed = packSpans(leaves, opts)
  const mergedTiny = mergeTinySpans(raw, packed, opts)
  const withOverlap = applyOverlap(mergedTiny, raw, opts)
  // 契约兜底：偏移必须能还原内容（重叠可能把起点挪进上一块，拼接后就地重取）
  return withOverlap.map((c) => {
    const exact = raw.slice(c.start, c.start + c.content.length)
    return exact === c.content ? c : { start: c.start, content: exact }
  })
}

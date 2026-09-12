/**
 * 离线剧本语料（T4）：PDF/txt → 文本 → RAG chunk → 词面检索 → 线上同形注入串。
 *
 * 用户提供的剧本库（AI-COC-KP Story Document/，票 #40 开工对齐结论）离线切片后做
 * BM25-lite 词面检索——检索器与线上 embedding 不同源，产出如实标注 caveat
 * rag_lexical_approximation_offline（数据卡同步记录）。
 *
 * 复用面：
 *  - 切块 = server/src/rag/chunker.chunkStoryText（M1-T3 起产品索引的真实切块器：递归
 *    语义分块、带字符偏移，纯函数且对 vectorStore 仅 type-import。旧 client
 *    storyService.textToChunks 已随 M1-T3 客户端断代删除，import 契约随之改指向服务端；
 *    注入串格式侧另引 supplementAssembly / promptMarkers 纯模块常量，见下条）；
 *  - 注入串格式 = 线上 rag 房注入现口径（票 #65；旧镜像对象 vectorStore.buildContext
 *    已随 1d83408 退役）：turnKnowledge.fetchRagContext = buildSupplement(plain) 的
 *    blocks → renderBlock（trim）→ join('\n\n')，无标题、无 `### [n]` 分节标记，块数
 *    与字符预算由线上装配常量封顶。装配常量直接 import server/src/rag/supplementAssembly
 *    与 promptMarkers（纯模块，可离线 import；promptMarkers 本就是零依赖叶子）——
 *    单源引用，杜绝再次漂移。
 */
import fs from 'node:fs'
import path from 'node:path'
import { chunkStoryText } from '../../../server/src/rag/chunker.js'
import { MAX_SUPPLEMENT_CHUNKS, SUPPLEMENT_BUDGET_CHARS } from '../../../server/src/rag/supplementAssembly.js'
import { SUPPLEMENT_HEADING } from '../../../server/src/rag/promptMarkers.js'

export interface StoryDoc {
  storyId: string
  name: string
  /** 提取的全文（失败/空文本的故事不进语料）。 */
  text: string
}

export interface CorpusChunk {
  storyId: string
  storyName: string
  index: number
  content: string
}

/** 语料根边界（#38 导出器同尺度，内联实现——候选路径必须落在 root 内，../ 逃逸拒绝）。 */
function assertPathInCorpusRoot(root: string, candidate: string): string {
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`语料路径越界，拒绝: ${candidate}`)
  }
  return resolved
}

/** PDF 文本层提取（pdf-parse v2，与 storyParsers.parsePdfWithOcr 的主路径同参；不做内嵌图 OCR）。 */
export async function extractPdfText(filePath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const dataBuffer = fs.readFileSync(filePath)
  const uint8Array = new Uint8Array(dataBuffer.buffer, dataBuffer.byteOffset, dataBuffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  try {
    const pdfData = await parser.getText()
    return (pdfData.text || '').trim()
  } finally {
    await parser.destroy()
  }
}

/** 语料根目录扫描：pdf/txt/md 逐一提取（提取失败只告警不中断——坏文件不进语料）。 */
export async function loadCorpus(corpusRoot: string): Promise<{ docs: StoryDoc[]; warnings: string[] }> {
  const root = path.resolve(corpusRoot)
  if (!fs.existsSync(root)) throw new Error(`语料目录不存在: ${corpusRoot}`)
  const storyDirs = [root, assertPathInCorpusRoot(root, path.join(root, 'stories'))]
  const warnings: string[] = []
  const docs: StoryDoc[] = []
  for (const dir of storyDirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!['.pdf', '.txt', '.md'].includes(ext)) continue
      const filePath = assertPathInCorpusRoot(root, path.join(dir, entry.name))
      const name = entry.name.slice(0, entry.name.length - ext.length)
      try {
        const text = ext === '.pdf' ? await extractPdfText(filePath) : fs.readFileSync(filePath, 'utf-8').trim()
        if (text.length < 500) {
          warnings.push(`语料 ${entry.name}: 文本层不足 500 字符（疑似扫描件/空文档），已跳过`)
          continue
        }
        docs.push({ storyId: name, name, text })
      } catch (err) {
        warnings.push(`语料 ${entry.name}: 提取失败已跳过（${err instanceof Error ? err.message : String(err)}）`)
      }
    }
  }
  return { docs, warnings }
}

/** 产品切块器出 chunk（M1 递归语义切块，~800 字/100 重叠，与线上索引同形），摊平成语料级检索集合。 */
export function buildCorpusChunks(docs: StoryDoc[]): CorpusChunk[] {
  const chunks: CorpusChunk[] = []
  for (const doc of docs) {
    const raw = chunkStoryText(doc.text)
    raw.forEach((c, i) => {
      chunks.push({ storyId: doc.storyId, storyName: doc.name, index: i, content: c.content })
    })
  }
  return chunks
}

/* ── 词面检索（BM25-lite；确定性，无网络/embedding）─────────────────────── */

/** 中文按 2-gram、ASCII 按小写词 tokenize（检索器本地实现；与产品 tf 词表不同源，仅离线用）。 */
export function tokenizeForRetrieval(text: string): string[] {
  const tokens: string[] = []
  const ascii = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  tokens.push(...ascii)
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2))
  if (cjk.length === 1) tokens.push(cjk)
  return tokens
}

/** 检索索引：chunk → 词频表（构建一次，查询多次）。 */
export class LexicalIndex {
  private readonly docs: { chunk: CorpusChunk; tf: Map<string, number> }[] = []
  private readonly idf = new Map<string, number>()

  constructor(chunks: CorpusChunk[]) {
    for (const chunk of chunks) {
      const tf = new Map<string, number>()
      const tokens = tokenizeForRetrieval(chunk.content)
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      this.docs.push({ chunk, tf })
    }
    for (const { tf } of this.docs) {
      for (const term of tf.keys()) this.idf.set(term, (this.idf.get(term) ?? 0) + 1)
    }
    const n = this.docs.length || 1
    for (const [term, df] of this.idf) this.idf.set(term, Math.log(1 + n / df))
  }

  /** Top-k 检索（按词面重合得分降序；无命中返回空）。 */
  search(query: string, k: number): CorpusChunk[] {
    const qTokens = new Set(tokenizeForRetrieval(query))
    if (qTokens.size === 0) return []
    const scored = this.docs.map(({ chunk, tf }) => {
      let score = 0
      for (const term of qTokens) {
        const f = tf.get(term)
        if (f) score += f * (this.idf.get(term) ?? 0)
      }
      return { chunk, score }
    })
    scored.sort((a, b) => b.score - a.score || a.chunk.storyId.localeCompare(b.chunk.storyId) || a.chunk.index - b.chunk.index)
    return scored.filter((s) => s.score > 0).slice(0, k).map((s) => s.chunk)
  }
}

/**
 * chunk 列表 → 注入原文。与线上 rag 房 `rag_context` 列逐块同构（票 #65）：
 * turnKnowledge.fetchRagContext = `blocks.map(renderBlock).join('\n\n')`——无标题、
 * 无 `### [n]` 分节标记，块 trim 后以空行相连；块数 ≤MAX_SUPPLEMENT_CHUNKS、
 * 整块试放不超 SUPPLEMENT_BUDGET_CHARS（线上 assembleSupplement 同口径——计量按
 * 含标题的 renderSupplement 长度，输出则按 rag 房口径不含标题）。
 * 块顺序（BM25 分数序）与块来源（词面检索，非 embedding+rerank）仍属离线近似，
 * 由 caveat rag_lexical_approximation_offline 标注，不属于格式漂移。
 */
export function buildRagContext(chunks: CorpusChunk[]): string {
  const picked: string[] = []
  for (const chunk of chunks) {
    if (picked.length >= MAX_SUPPLEMENT_CHUNKS) break
    const text = chunk.content.trim()
    if (!text) continue
    // 预算计量与线上一致：renderSupplement(trial) = [标题, ...块] 按 '\n' 连接
    const trial = [SUPPLEMENT_HEADING, ...picked, text].join('\n')
    if (trial.length > SUPPLEMENT_BUDGET_CHARS) continue
    picked.push(text)
  }
  return picked.join('\n\n')
}

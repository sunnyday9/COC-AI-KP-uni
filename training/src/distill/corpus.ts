/**
 * 离线剧本语料（T4）：PDF/txt → 文本 → RAG chunk → 词面检索 → 线上同形注入串。
 *
 * 用户提供的剧本库（AI-COC-KP Story Document/，票 #40 开工对齐结论）离线切片后做
 * BM25-lite 词面检索——检索器与线上 embedding 不同源，产出如实标注 caveat
 * rag_lexical_approximation_offline（数据卡同步记录）。
 *
 * 复用面：
 *  - 切块 = server/src/rag/chunker.chunkStoryText（M1-T3 起产品索引的真实切块器：递归
 *    语义分块、带字符偏移，纯函数且对 vectorStore 仅 type-import——training 工作区
 *    跨工作区 import 的唯一扩展点。旧 client storyService.textToChunks 已随 M1-T3
 *    客户端断代删除，import 契约随之改指向服务端）；
 *  - 注入串格式 = server/src/rag/vectorStore.buildContext 的 8 行组装（## 剧本相关情报 /
 *    ### [n] type 分节）。vectorStore 拖 server 运行时栈不可离线 import，按
 *    training/eval/lib/request.ts「最小复制 + 来源锚定注释」先例逐字镜像。
 */
import fs from 'node:fs'
import path from 'node:path'
import { chunkStoryText } from '../../../server/src/rag/chunker.js'

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
 * chunk 列表 → 注入原文。格式逐字镜像 vectorStore.buildContext（`## 剧本相关情报`
 * + `### [n] type` 分节）——线上 rag_context 列存的就是这个形态，教师看到的
 * 「故事情报」块与线上一比一。
 */
export function buildRagContext(chunks: CorpusChunk[]): string {
  if (chunks.length === 0) return ''
  const lines = ['## 剧本相关情报']
  for (let i = 0; i < chunks.length; i++) {
    lines.push(`### [${i + 1}] rule`)
    lines.push(chunks[i]!.content)
    lines.push('')
  }
  return lines.join('\n')
}

/** 瘦身裁剪：线上 top8 注入串取前 keepSections 节（分节按 `### [n]` 头切分）。 */
export function slimRagContext(ragContext: string, keepSections: number): string {
  if (!ragContext) return ''
  const sections = ragContext.split(/(?=^### \[\d+\])/m)
  const head = sections[0] ?? ''
  const body = sections.slice(1, keepSections + 1)
  const kept = [head, ...body].join('')
  // 去掉因截断产生的尾随空行差异，保持「节间一个空行」的线上形态
  return kept.replace(/\n+$/, '\n')
}

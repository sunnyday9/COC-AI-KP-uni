/**
 * Story file parsers — extract plain text from various formats.
 * Used by fileHandlers for RAG indexing.
 *
 * Migrated from original/ai-trpg-web/electron/rag/storyParsers.mjs
 * (docx/epub/html + parseByExtension) — line-for-line.
 *
 * ADDED (task-4-brief decision 4/5): `parsePdfWithOcr` — the PDF text +
 * embedded-image OCR flow. In the original project this code lives in
 * electron/ipc/fileHandlers.cjs (file:readStoryForRag); the brief's deliverable
 * places PDF/OCR parsing in rag/storyParsers, so it is extracted here for the
 * server (Task 5 stories routes will call it). tesseract.js is pointed at
 * `server/assets/tesseract/` (chi_sim + eng traineddata) via `langPath`;
 * `new PDFParse({ data })` is the type-correct form of the original's
 * `new PDFParse(uint8Array)` (pdfjs accepts both).
 */
import { JSDOM } from 'jsdom'
import { TESSERACT_DATA_DIR } from '../config.js'

function stripHtml(html: string): string {
  if (!html || typeof html !== 'string') return ''
  try {
    const dom = new JSDOM(html)
    return (dom.window.document.body?.textContent || '').trim()
  } catch {
    return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
}

/**
 * Parse DOCX buffer to plain text.
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  const mammothMod = await import('mammoth')
  // CJS interop: `default` holds module.exports when present; fall back to the
  // namespace itself (identical to the original `(await import('mammoth')).default || await import('mammoth')`).
  const mammoth = ((mammothMod as { default?: unknown }).default || mammothMod) as typeof mammothMod
  const result = await mammoth.extractRawText({ buffer })
  return (result?.value || '').trim()
}

/**
 * Parse EPUB buffer to plain text (chapter contents concatenated).
 * Uses epub2 which provides a clean Promise-based API.
 */
export async function parseEpub(buffer: Buffer): Promise<string> {
  const { createTempFile } = await getTempFileHelper()
  const tmpPath = await createTempFile(buffer, '.epub')
  try {
    const epubMod = await import('epub2')
    const EPub = (epubMod as { default?: unknown; EPub?: unknown }).default || (epubMod as { EPub?: unknown }).EPub
    const epub = await (EPub as { createAsync: (p: string) => Promise<{ flow?: { id?: string }[]; getChapter: (id: string, cb: (err: unknown, data?: string) => void) => void }> }).createAsync(tmpPath)
    const flow = epub.flow || []
    const texts: string[] = []
    for (const chapter of flow) {
      if (!chapter.id) continue
      try {
        const html = await new Promise<string | undefined>((resolve, reject) => {
          epub.getChapter(chapter.id as string, (err, data) => {
            if (err) reject(err)
            else resolve(data)
          })
        })
        if (html) texts.push(stripHtml(html))
      } catch {
        // Skip unreadable chapters
      }
    }
    return texts.join('\n\n')
  } finally {
    try { const { unlink } = await import('node:fs/promises'); await unlink(tmpPath) } catch { /* ignore */ }
  }
}

/**
 * Helper to write buffer to a temp file (epub2 requires a file path).
 */
async function getTempFileHelper(): Promise<{ createTempFile: (buffer: Buffer, ext: string) => Promise<string> }> {
  const { writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomBytes } = await import('node:crypto')
  return {
    createTempFile: async (buffer: Buffer, ext: string): Promise<string> => {
      const name = `coc_epub_${randomBytes(8).toString('hex')}${ext}`
      const p = join(tmpdir(), name)
      await writeFile(p, buffer)
      return p
    },
  }
}

/**
 * Parse HTML string to plain text.
 */
export function parseHtml(htmlString: string): string {
  return stripHtml(htmlString || '')
}

/**
 * Parse story content by extension. Returns plain text.
 * @param ext - e.g. '.docx', '.epub', '.html'
 * @param data - file buffer (docx, epub) or string (html, txt, md)
 */
export async function parseByExtension(ext: string, data: Buffer | string): Promise<string | null> {
  const e = (ext || '').toLowerCase()
  if (e === '.docx') {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8')
    return parseDocx(buf)
  }
  if (e === '.epub') {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'binary')
    return parseEpub(buf)
  }
  if (e === '.html' || e === '.htm') {
    return parseHtml(typeof data === 'string' ? data : String(data))
  }
  return null
}

/**
 * PDF → text: pdf-parse v2 extraction, plus OCR of embedded images.
 *
 * Extracted from original fileHandlers.cjs `file:readStoryForRag`:
 *  1. pdf-parse extracts the main text layer;
 *  2. pdf-lib enumerates indirect objects, grabs up to 8 embedded
 *     JPEG/PNG images (≤5MB each, skipping non-DCT filters that fail to
 *     decode), and tesseract.js OCRs them with chi_sim+eng;
 *  3. OCR text is appended with a marker header, or the main text alone is
 *     returned when the PDF is >50MB / extraction fails.
 * Defensive limits, error swallowing and message texts are preserved verbatim.
 */
export async function parsePdfWithOcr(dataBuffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(dataBuffer.buffer, dataBuffer.byteOffset, dataBuffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  const pdfData = await parser.getText()
  let mainText = (pdfData.text || '').trim()
  try {
    // Defensive limits: avoid main-process stalls on huge or image-heavy PDFs.
    if (dataBuffer.length > 50 * 1024 * 1024) return mainText

    const { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } = await import('pdf-lib')
    const Tesseract = (await import('tesseract.js')).default
    const doc = await PDFDocument.load(uint8Array)
    const entries = doc.context.enumerateIndirectObjects()
    const imageBuffers: Buffer[] = []
    for (const [, obj] of entries) {
      if (imageBuffers.length >= 8) break
      if (!(obj instanceof PDFRawStream)) continue
      const dict = obj.dict
      const subtypeRef = dict.get(PDFName.of('Subtype'))
      if (!subtypeRef) continue
      const subtype = doc.context.lookup(subtypeRef)
      if (!subtype || (subtype as { encodedName?: string }).encodedName !== '/Image') continue
      let bytes = obj.getContents()
      const filterRef = dict.get(PDFName.of('Filter'))
      if (filterRef) {
        const filter = doc.context.lookup(filterRef)
        const isDCT = filter && (filter as { encodedName?: string }).encodedName === '/DCTDecode'
        if (!isDCT) {
          try {
            // pdf-lib's runtime decodePDFRawStream takes { dict, contents };
            // its .d.ts (wrongly) types the param as PDFRawStream — cast only.
            const decoded = decodePDFRawStream({ dict: obj.dict, contents: bytes } as unknown as Parameters<typeof decodePDFRawStream>[0])
            // runtime getBytes() with no args returns all remaining bytes
            bytes = (decoded.getBytes as (length?: number, forceClamped?: boolean) => Uint8Array)()
          } catch {
            continue
          }
        }
      }
      const buf = Buffer.from(bytes)
      if (buf.length > 5 * 1024 * 1024) continue
      const isJpeg = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8
      const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      if (isJpeg || isPng) imageBuffers.push(buf)
    }
    if (imageBuffers.length) {
      // traineddata is staged in server/assets/tesseract (chi_sim + eng)
      const worker = await Tesseract.createWorker('chi_sim+eng', 1, { langPath: TESSERACT_DATA_DIR })
      const imageTexts: string[] = []
      for (let i = 0; i < imageBuffers.length; i++) {
        const { data } = await worker.recognize(imageBuffers[i] as Buffer)
        if (data.text && data.text.trim()) {
          imageTexts.push(`[插图 ${i + 1}]\n${data.text.trim()}`)
        }
      }
      await worker.terminate()
      if (imageTexts.length) {
        mainText += '\n\n--- 以下为 PDF 内嵌插图中识别的内容（场景结构图等）---\n\n' + imageTexts.join('\n\n')
      }
    }
  } catch {
    // 内嵌图提取或 OCR 失败时仅保留正文
  }
  return mainText
}

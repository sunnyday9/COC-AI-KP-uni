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

interface EpubSpineRef {
  '@'?: { idref?: string }
}

/**
 * Parse EPUB buffer to plain text (chapter contents concatenated).
 * Uses epub2 which provides a clean Promise-based API.
 */
export async function parseEpub(buffer: Buffer, requireComplete = false, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const { createTempFile } = await getTempFileHelper()
  const tmpPath = await createTempFile(buffer, '.epub')
  try {
    const { EPub } = await import('epub2')
    signal?.throwIfAborted()
    class CompleteEPub extends EPub {
      override parseSpine(spine: { itemref?: EpubSpineRef | EpubSpineRef[] }): void {
        // epub2 drops unresolved references before exposing the chapter flow.
        const { itemref = [] } = spine
        const refs = Array.isArray(itemref) ? itemref : [itemref]
        for (const ref of refs) {
          const id = ref['@']?.idref
          if (!id || !Object.hasOwn(this.manifest, id)) {
            this.emit('error', new Error('EPUB spine references a missing manifest entry'))
            return
          }
        }
        super.parseSpine(spine)
      }
    }
    const Parser = requireComplete ? CompleteEPub : EPub
    const epub: InstanceType<typeof EPub> = await Parser.createAsync(tmpPath)
    signal?.throwIfAborted()
    const flow = epub.flow || []
    const texts: string[] = []
    for (const chapter of flow) {
      signal?.throwIfAborted()
      const id = chapter.id
      if (!id) continue
      try {
        const html = await new Promise<string | undefined>((resolve, reject) => {
          epub.getChapter(id, (err, data) => {
            if (err) reject(err)
            else resolve(data)
          })
        })
        if (html) texts.push(stripHtml(html))
      } catch (error) {
        if (requireComplete) throw error
        // Skip unreadable chapters
      }
    }
    signal?.throwIfAborted()
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
 * pdf-parse extracts the text layer; pdf-lib then walks page image resources
 * in page/resource order and tesseract.js OCRs supported JPEG/PNG streams.
 * Image OCR is bounded by PDF, per-image, aggregate-image, image-count, and
 * elapsed-time limits. Reaching a limit is reported in the returned text.
 */
const MAX_PDF_OCR_BYTES = 50 * 1024 * 1024
const MAX_PDF_OCR_IMAGES = 32
const MAX_PDF_OCR_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PDF_OCR_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const PDF_OCR_TIME_LIMIT_MS = 60_000
const PDF_OCR_IMAGE_TIME_LIMIT_MS = 15_000
const MAX_OCR_DIAGNOSTIC_DETAILS = 8

interface PdfOcrImage {
  bytes: Buffer
  page: number
  image: number
}

interface PdfOcrOptions {
  requireComplete?: boolean
  signal?: AbortSignal
  totalOcrTimeLimitMs?: number
  imageOcrTimeLimitMs?: number
}

class PdfOcrTimeoutError extends Error {
  constructor(readonly limit: 'total' | 'image') {
    super(`PDF ${limit} OCR time limit reached`)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, limit: 'total' | 'image', signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    abort = () => reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new PdfOcrTimeoutError(limit)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (abort) signal?.removeEventListener('abort', abort)
    if (timer !== undefined) clearTimeout(timer)
  })
}

export async function parsePdfWithOcr(dataBuffer: Buffer, options: PdfOcrOptions = {}): Promise<string> {
  const { signal } = options
  signal?.throwIfAborted()
  // Decide whether the image/OCR pass is allowed before any PDF parsing. The
  // text-layer parse still runs so oversized PDFs retain their readable text.
  const exceedsPdfOcrSizeLimit = dataBuffer.length > MAX_PDF_OCR_BYTES
  if (options.requireComplete && exceedsPdfOcrSizeLimit) throw new Error('PDF exceeds OCR file-size limit')
  const { PDFParse } = await import('pdf-parse')
  signal?.throwIfAborted()
  // pdf-parse can transfer/detach its input while initializing its worker.
  // Give it a copy so the original upload bytes remain available to pdf-lib.
  const parserBytes = Uint8Array.from(dataBuffer)
  const pdfImageBytes = new Uint8Array(dataBuffer.buffer, dataBuffer.byteOffset, dataBuffer.byteLength)
  const parser = new PDFParse({ data: parserBytes })
  const pdfData = await parser.getText()
  signal?.throwIfAborted()
  let mainText = (pdfData.text || '').trim()
  const safetySkipDetails: string[] = []
  let safetySkipCount = 0
  let timeLimitDiagnostic = ''
  const diagnostics: string[] = []
  const totalOcrTimeLimitMs = options.totalOcrTimeLimitMs ?? PDF_OCR_TIME_LIMIT_MS
  const imageOcrTimeLimitMs = options.imageOcrTimeLimitMs ?? PDF_OCR_IMAGE_TIME_LIMIT_MS
  const recordSafetySkip = (page: number, image: number, reason: string) => {
    if (options.requireComplete) throw new Error(`Page ${page} image ${image}: ${reason}`)
    safetySkipCount += 1
    if (safetySkipDetails.length < MAX_OCR_DIAGNOSTIC_DETAILS) {
      safetySkipDetails.push(`Page ${page} image ${image}: ${reason}.`)
    }
  }
  const appendDiagnostics = (): string => {
    const messages = [...diagnostics]
    if (safetySkipCount > 0) {
      messages.push(`Safety limits skipped OCR for ${safetySkipCount} embedded image(s).`)
      messages.push(...safetySkipDetails)
      if (safetySkipCount > safetySkipDetails.length) {
        messages.push(`${safetySkipCount - safetySkipDetails.length} additional skipped image(s) not listed.`)
      }
    }
    if (timeLimitDiagnostic) messages.push(timeLimitDiagnostic)
    if (!messages.length) return mainText
    return `${mainText}${mainText ? '\n\n' : ''}--- PDF image OCR diagnostics ---\n${messages.join('\n')}`
  }

  if (exceedsPdfOcrSizeLimit) {
    diagnostics.push(`Image OCR skipped: PDF exceeds the ${MAX_PDF_OCR_BYTES / (1024 * 1024)} MiB file-size limit.`)
    return appendDiagnostics()
  }

  try {
    const { PDFDocument, PDFDict, PDFRawStream, PDFName, decodePDFRawStream } = await import('pdf-lib')
    signal?.throwIfAborted()
    const doc = await PDFDocument.load(pdfImageBytes)
    const imageBuffers: PdfOcrImage[] = []
    let imageResourceCount = 0
    let totalImageBytes = 0
    const pages = doc.getPages()
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      signal?.throwIfAborted()
      const page = pages[pageIndex]
      const resourcesRef = page.node.get(PDFName.of('Resources'))
      const resources = resourcesRef ? doc.context.lookup(resourcesRef) : undefined
      if (!(resources instanceof PDFDict)) continue
      const xObjectsRef = resources.get(PDFName.of('XObject'))
      const xObjects = xObjectsRef ? doc.context.lookup(xObjectsRef) : undefined
      if (!(xObjects instanceof PDFDict)) continue

      let pageImageIndex = 0
      for (const imageRef of xObjects.values()) {
        const obj = doc.context.lookup(imageRef)
        if (!(obj instanceof PDFRawStream)) continue
        const subtype = doc.context.lookup(obj.dict.get(PDFName.of('Subtype')))
        if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Image') continue

        pageImageIndex += 1
        imageResourceCount += 1
        if (imageResourceCount > MAX_PDF_OCR_IMAGES) {
          recordSafetySkip(pageIndex + 1, pageImageIndex, `image-count limit (${MAX_PDF_OCR_IMAGES}) reached`)
          continue
        }

        let bytes = Buffer.from(obj.getContents())
        if (bytes.length > MAX_PDF_OCR_IMAGE_BYTES) {
          recordSafetySkip(pageIndex + 1, pageImageIndex, `image exceeds the ${MAX_PDF_OCR_IMAGE_BYTES / (1024 * 1024)} MiB per-image byte limit`)
          continue
        }

        const filterRef = obj.dict.get(PDFName.of('Filter'))
        if (filterRef) {
          const filter = doc.context.lookup(filterRef)
          const isDCT = filter instanceof PDFName && filter.decodeText() === 'DCTDecode'
          if (!isDCT) {
            try {
              // pdf-lib's runtime decoder accepts { dict, contents }; its .d.ts
              // types the argument as PDFRawStream, so cast only at this call.
              const decoded = decodePDFRawStream({ dict: obj.dict, contents: bytes } as unknown as Parameters<typeof decodePDFRawStream>[0])
              bytes = Buffer.from((decoded.getBytes as (length?: number, forceClamped?: boolean) => Uint8Array)())
            } catch (error) {
              if (options.requireComplete) throw error
              continue
            }
          }
        }

        if (bytes.length > MAX_PDF_OCR_IMAGE_BYTES) {
          recordSafetySkip(pageIndex + 1, pageImageIndex, `decoded image exceeds the ${MAX_PDF_OCR_IMAGE_BYTES / (1024 * 1024)} MiB per-image byte limit`)
          continue
        }
        if (totalImageBytes + bytes.length > MAX_PDF_OCR_TOTAL_IMAGE_BYTES) {
          recordSafetySkip(pageIndex + 1, pageImageIndex, `aggregate image-byte limit (${MAX_PDF_OCR_TOTAL_IMAGE_BYTES / (1024 * 1024)} MiB) reached`)
          continue
        }

        const isJpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
        const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        if (!isJpeg && !isPng) {
          if (options.requireComplete) throw new Error('PDF image format is unsupported for OCR')
          continue
        }
        totalImageBytes += bytes.length
        imageBuffers.push({ bytes, page: pageIndex + 1, image: pageImageIndex })
      }
    }
    if (imageBuffers.length) {
      // Load OCR runtime only after page traversal found a supported image.
      const Tesseract = (await import('tesseract.js')).default
      signal?.throwIfAborted()
      const deadline = Date.now() + totalOcrTimeLimitMs
      // The checked-in traineddata files are uncompressed; disable Tesseract's
      // default .gz lookup so OCR stays local and never fetches language data.
      // chi_sim's embedded config requests the optional chi_sim_vert model. It
      // is not bundled, so clear that sublanguage request to avoid a false
      // missing-data warning while retaining horizontal Chinese recognition.
      const workerPromise = Tesseract.createWorker(
        'chi_sim+eng',
        1,
        { langPath: TESSERACT_DATA_DIR, gzip: false },
        'tessedit_load_sublangs \n',
      )
      let worker: Awaited<typeof workerPromise> | undefined
      const imageTexts: string[] = []
      let completedImageCount = 0
      try {
        worker = await withTimeout(workerPromise, Math.max(0, deadline - Date.now()), 'total', signal)
        for (let i = 0; i < imageBuffers.length; i++) {
          signal?.throwIfAborted()
          const image = imageBuffers[i]
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) throw new PdfOcrTimeoutError('total')
          const imageLimitApplies = imageOcrTimeLimitMs < remainingMs
          const timeoutMs = Math.min(imageOcrTimeLimitMs, remainingMs)
          const { data } = await withTimeout(worker.recognize(image.bytes), timeoutMs, imageLimitApplies ? 'image' : 'total', signal)
          completedImageCount = i + 1
          if (data.text && data.text.trim()) {
            imageTexts.push(`[第${image.page}页 插图 ${image.image}]\n${data.text.trim()}`)
          }
        }
      } catch (error) {
        if (!worker && (error instanceof PdfOcrTimeoutError || signal?.aborted)) {
          void workerPromise.then((lateWorker) => lateWorker.terminate()).catch(() => {})
        }
        signal?.throwIfAborted()
        if (error instanceof PdfOcrTimeoutError) {
          const firstSkipped = imageBuffers[completedImageCount] ?? imageBuffers[imageBuffers.length - 1]
          const skippedCount = imageBuffers.length - completedImageCount
          const limitLabel = error.limit === 'image'
            ? `Per-image OCR time limit (${imageOcrTimeLimitMs} ms) reached`
            : `Total OCR time limit (${totalOcrTimeLimitMs} ms) reached`
          timeLimitDiagnostic = `${limitLabel}; skipped OCR for ${skippedCount} image(s)${firstSkipped ? ` starting at page ${firstSkipped.page} image ${firstSkipped.image}` : ''}.`
          if (options.requireComplete) throw error
        } else {
          throw error
        }
      } finally {
        if (worker) {
          await withTimeout(Promise.resolve(worker.terminate()), 1_000, 'total').catch(() => {})
        }
      }
      if (imageTexts.length) {
        mainText += '\n\n--- 以下为 PDF 内嵌插图中识别的内容（场景结构图等）---\n\n' + imageTexts.join('\n\n')
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (options.requireComplete) throw error
    // 内嵌图提取或 OCR 失败时仅保留正文
  }
  return appendDiagnostics()
}

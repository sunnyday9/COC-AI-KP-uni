// @vitest-environment node
/**
 * Migrated from original/ai-trpg-web/electron/rag/__tests__/storyParsers.spec.ts.
 * PDF parsing uses an in-memory pdf-lib fixture, and embedded-image OCR uses
 * a hermetic tesseract.js mock so tests need neither traineddata nor network.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { parseHtml, parseByExtension, parsePdfWithOcr } from '../storyParsers.js'
import { makePdfWithEmbeddedImages, makePdfWithText, makePdfWithTextAndEmbeddedImages } from '../../../test/helpers/pdfFixture.js'

const { mockTesseractModuleLoad, mockCreateWorker, mockRecognize, mockTerminate } = vi.hoisted(() => ({
  mockTesseractModuleLoad: vi.fn(),
  mockCreateWorker: vi.fn(),
  mockRecognize: vi.fn(),
  mockTerminate: vi.fn(),
}))

vi.mock('tesseract.js', () => ({
  default: (() => {
    mockTesseractModuleLoad()
    return { createWorker: mockCreateWorker }
  })(),
}))

beforeEach(() => {
  mockRecognize.mockReset().mockImplementation(async (image: Buffer) => {
    const marker = image.toString('latin1').match(/OCR_EVIDENCE_\d+/)?.[0] ?? 'OCR_EVIDENCE_MISSING'
    return { data: { text: marker } }
  })
  mockTerminate.mockReset().mockResolvedValue(undefined)
  mockCreateWorker.mockReset().mockResolvedValue({ recognize: mockRecognize, terminate: mockTerminate })
})

describe('rag/storyParsers', () => {
  describe('parseHtml', () => {
    it('strips HTML tags and returns plain text', () => {
      const html = '<html><body><h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></body></html>'
      const text = parseHtml(html)
      expect(text).toContain('Title')
      expect(text).toContain('Paragraph one')
      expect(text).toContain('Paragraph two')
      expect(text).not.toContain('<')
    })

    it('returns empty string for empty input', () => {
      expect(parseHtml('')).toBe('')
      expect(parseHtml(null as unknown as string)).toBe('')
    })
  })

  describe('parseByExtension', () => {
    it('returns null for unsupported extensions', async () => {
      expect(await parseByExtension('.txt', 'hello')).toBeNull()
      expect(await parseByExtension('.md', '# hi')).toBeNull()
      expect(await parseByExtension('.xyz', 'data')).toBeNull()
    })

    it('parses HTML content', async () => {
      const html = '<body><p>Story content here.</p></body>'
      const result = await parseByExtension('.html', html)
      expect(result).toContain('Story content here')
    })

    it('parses HTM extension', async () => {
      const html = '<p>HTM file content</p>'
      const result = await parseByExtension('.htm', html)
      expect(result).toContain('HTM file content')
    })
  })

  describe('parsePdfWithOcr', () => {
    it('returns text-layer content without loading Tesseract or creating a worker', async () => {
      const pdf = await makePdfWithText('Text layer stays on the fast path')

      const text = await parsePdfWithOcr(pdf)

      expect(text).toContain('Text layer stays on the fast path')
      expect(mockTesseractModuleLoad).not.toHaveBeenCalled()
      expect(mockCreateWorker).not.toHaveBeenCalled()
    })

    it('OCRs embedded images in page and image order, including image 9 and later', async () => {
      const pages = [['01', '02'], ['03', '04', '05'], ['06', '07', '08', '09', '10']]
      const pdf = await makePdfWithEmbeddedImages(pages)

      const text = await parsePdfWithOcr(pdf)

      expect(mockCreateWorker).toHaveBeenCalledTimes(1)
      const evidenceOrder = mockRecognize.mock.calls.map(([image]) =>
        (image as Buffer).toString('latin1').match(/OCR_EVIDENCE_\d+/)?.[0],
      )
      expect(evidenceOrder).toEqual(pages.flat().map((marker) => `OCR_EVIDENCE_${marker}`))
      expect(text).toContain('[第3页 插图 4]\nOCR_EVIDENCE_09')
      expect(text).toContain('[第3页 插图 5]\nOCR_EVIDENCE_10')
    })

    it('reports later images skipped at the image-count safety limit', async () => {
      const markers = Array.from({ length: 33 }, (_, index) => String(index + 1).padStart(2, '0'))
      const pdf = await makePdfWithEmbeddedImages([markers])

      const text = await parsePdfWithOcr(pdf)

      expect(mockRecognize).toHaveBeenCalledTimes(32)
      expect(text).toContain('Safety limits skipped OCR for 1 embedded image(s).')
      expect(text).toContain('Page 1 image 33: image-count limit (32) reached.')
    })

    it('reports an embedded image skipped at the per-image byte limit', async () => {
      const pdf = await makePdfWithEmbeddedImages([['01']], 5 * 1024 * 1024 + 1)

      const text = await parsePdfWithOcr(pdf)

      expect(mockRecognize).not.toHaveBeenCalled()
      expect(text).toContain('Safety limits skipped OCR for 1 embedded image(s).')
      expect(text).toContain('Page 1 image 1: image exceeds the 5 MiB per-image byte limit.')
    })

    it('reports work skipped when a per-image OCR deadline expires', async () => {
      const pdf = await makePdfWithEmbeddedImages([['01', '02']])
      mockRecognize.mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ data: { text: 'OCR_FINISHED_TOO_LATE' } }), 20)
      }))

      const text = await parsePdfWithOcr(pdf, { totalOcrTimeLimitMs: 1_000, imageOcrTimeLimitMs: 5 })

      expect(text).toContain('Per-image OCR time limit (5 ms) reached; skipped OCR for 2 image(s)')
      expect(text).not.toContain('OCR_FINISHED_TOO_LATE')
    })

    it('reports work skipped when the total OCR deadline expires during worker startup', async () => {
      const pdf = await makePdfWithEmbeddedImages([['01', '02']])
      mockCreateWorker.mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ recognize: mockRecognize, terminate: mockTerminate }), 20)
      }))

      const text = await parsePdfWithOcr(pdf, { totalOcrTimeLimitMs: 5, imageOcrTimeLimitMs: 1_000 })

      expect(text).toContain('Total OCR time limit (5 ms) reached; skipped OCR for 2 image(s)')
      expect(mockRecognize).not.toHaveBeenCalled()
    })

    it('keeps extracted text when OCR worker startup fails', async () => {
      const pdf = await makePdfWithTextAndEmbeddedImages('Text remains after OCR fails', [['01']])
      mockCreateWorker.mockRejectedValueOnce(new Error('worker startup failed'))

      const text = await parsePdfWithOcr(pdf)

      expect(text).toContain('Text remains after OCR fails')
      expect(mockCreateWorker).toHaveBeenCalledTimes(1)
    })

    it('extracts the text layer from a pdf-lib generated PDF (no OCR)', async () => {
      const pdf = await makePdfWithText('Hello COC PDF world 123')
      const text = await parsePdfWithOcr(pdf)
      expect(text).toContain('Hello COC PDF world')
      expect(text).toContain('123')
    })

    it('returns the main text even when the buffer exceeds the 50MB guard', async () => {
      const pdf = await makePdfWithText('small but oversized guard text')
      const padded = Buffer.concat([pdf, Buffer.alloc(50 * 1024 * 1024 + 1)])
      const text = await parsePdfWithOcr(padded)
      expect(text).toContain('oversized guard text')
      expect(text).toContain('Image OCR skipped: PDF exceeds the 50 MiB file-size limit.')
    })
  })
})

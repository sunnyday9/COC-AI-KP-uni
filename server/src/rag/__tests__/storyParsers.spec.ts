// @vitest-environment node
/**
 * Migrated from original/ai-trpg-web/electron/rag/__tests__/storyParsers.spec.ts.
 * Only html/extension dispatch is exercised (docx/epub/pdf would need real
 * fixture files — same scope as the original spec).
 *
 * ADDED (task-5-brief decision 8): parsePdfWithOcr text-path test using a
 * pdf-lib-generated in-memory PDF fixture (Task 4 review Minor). The OCR
 * path (embedded images + tesseract) is marked skip — it needs the real
 * chi_sim+eng traineddata in server/assets/tesseract and takes seconds; run
 * manually when required.
 */
import { describe, it, expect } from 'vitest'
import { parseHtml, parseByExtension, parsePdfWithOcr } from '../storyParsers.js'
import { makePdfWithText } from '../../../test/helpers/pdfFixture.js'

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
    })
  })
})

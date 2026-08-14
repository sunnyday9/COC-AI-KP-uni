// @vitest-environment node
/**
 * Migrated from original/ai-trpg-web/electron/rag/__tests__/storyParsers.spec.ts.
 * Only html/extension dispatch is exercised (docx/epub/pdf would need real
 * fixture files — same scope as the original spec).
 */
import { describe, it, expect } from 'vitest'
import { parseHtml, parseByExtension } from '../storyParsers.js'

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
})

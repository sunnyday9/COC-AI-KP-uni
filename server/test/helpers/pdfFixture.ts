/**
 * Test-only fixture helpers.
 *
 * makePdfWithText generates a tiny in-memory PDF with pdf-lib (an existing
 * server dependency, used by parsePdfWithOcr itself) so the pdf-parse text
 * path of parsePdfWithOcr / readStory can be exercised hermetically — no
 * external fixtures, no network, no model downloads.
 *
 * Note: pdf-lib's standard fonts are WinAnsi/Latin-1 only — use ASCII text.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'

export async function makePdfWithText(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([420, 300])
  page.drawText(text, { x: 50, y: 220, size: 14, font })
  const bytes = await doc.save()
  return Buffer.from(bytes)
}

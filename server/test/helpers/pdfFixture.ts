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

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
  'base64',
)

export async function makePdfWithText(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([420, 300])
  page.drawText(text, { x: 50, y: 220, size: 14, font })
  const bytes = await doc.save()
  return Buffer.from(bytes)
}

/** Build a hermetic PDF whose per-page JPEGs carry unique OCR test markers. */
export async function makePdfWithEmbeddedImages(pages: string[][], imagePaddingBytes = 0): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (const markers of pages) {
    const page = doc.addPage([420, 300])
    for (let i = 0; i < markers.length; i++) {
      const marker = Buffer.from(`OCR_EVIDENCE_${markers[i]}`, 'ascii')
      const comment = Buffer.concat([
        Buffer.from([0xff, 0xfe, (marker.length + 2) >> 8, (marker.length + 2) & 0xff]),
        marker,
      ])
      const jpegBytes = Buffer.concat([
        TINY_JPEG.subarray(0, 2),
        comment,
        TINY_JPEG.subarray(2),
        Buffer.alloc(imagePaddingBytes),
      ])
      const image = await doc.embedJpg(Uint8Array.from(jpegBytes))
      page.drawImage(image, { x: 24 + (i % 4) * 80, y: 24 + Math.floor(i / 4) * 80, width: 48, height: 48 })
    }
  }
  return Buffer.from(await doc.save())
}

/** Add a selectable text layer to an embedded-image PDF fixture. */
export async function makePdfWithTextAndEmbeddedImages(text: string, markers: string[][]): Promise<Buffer> {
  const pdf = await makePdfWithEmbeddedImages(markers)
  const doc = await PDFDocument.load(pdf)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.getPages()[0].drawText(text, { x: 50, y: 250, size: 14, font })
  return Buffer.from(await doc.save())
}

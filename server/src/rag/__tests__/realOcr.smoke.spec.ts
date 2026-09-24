/**
 * Gated integration smoke for the public PDF OCR path. The checked-in JPEG
 * fixture contains raster text; the test uses the repository's local
 * Tesseract language data and is excluded from ordinary unit runs.
 *
 * Run from the server workspace with REAL_OCR_SMOKE=1.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import { TESSERACT_DATA_DIR } from '../../config.js'
import { parsePdfWithOcr } from '../storyParsers.js'

const smoke = process.env.REAL_OCR_SMOKE === '1' ? it : it.skip
const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures')

async function makeFixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 220])
  const image = await doc.embedJpg(new Uint8Array(readFileSync(path.join(fixtureDir, 'ocr-readable.jpg'))))
  page.drawImage(image, { x: 36, y: 38, width: 540, height: 145 })
  return Buffer.from(await doc.save())
}

describe('real PDF OCR smoke', () => {
  smoke('recognizes text embedded as a raster image using checked-in language data', async () => {
    const missingLanguages = ['chi_sim', 'eng']
      .map((language) => path.join(TESSERACT_DATA_DIR, `${language}.traineddata`))
      .filter((file) => {
        try {
          return statSync(file).size === 0
        } catch {
          return true
        }
      })
    expect(
      missingLanguages,
      `OCR smoke requires checked-in Tesseract language files under ${TESSERACT_DATA_DIR}`,
    ).toEqual([])

    const stderr = vi.spyOn(process.stderr, 'write')
    let text: string
    let emittedStderr = ''
    try {
      text = await parsePdfWithOcr(await makeFixturePdf())
      emittedStderr = stderr.mock.calls
        .map(([chunk]) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        .join('')
    } finally {
      stderr.mockRestore()
    }

    expect(text.replace(/\s+/g, ' ')).toMatch(/OCR\s+FIXTURE\s+8317/i)
    expect(text.replace(/\s+/g, '')).toContain('中文识别')
    expect(emittedStderr).not.toMatch(/\b(?:warning|error|failed|could not)\b/i)
  }, 180_000)
})

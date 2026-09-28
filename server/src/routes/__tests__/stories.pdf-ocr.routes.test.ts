// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app.js'
import { makePdfWithEmbeddedImages, makePdfWithText } from '../../../test/helpers/pdfFixture.js'
import { TEST_PASSWORD } from '../../testHelpers.js'

const { mockTesseractModuleLoad, mockCreateWorker, mockRecognize, mockTerminate } = vi.hoisted(() => ({
  mockTesseractModuleLoad: vi.fn(),
  mockCreateWorker: vi.fn(),
  mockRecognize: vi.fn(),
  mockTerminate: vi.fn(),
}))

vi.mock('tesseract.js', () => {
  mockTesseractModuleLoad()
  return { default: { createWorker: mockCreateWorker } }
})

const PDF_ROUTE_TIMEOUT_MS = 90_000

beforeEach(() => {
  mockTesseractModuleLoad.mockReset()
  mockRecognize.mockReset().mockImplementation(async (image: Buffer) => {
    const marker = image.toString('latin1').match(/OCR_EVIDENCE_\d+/)?.[0] ?? 'OCR_EVIDENCE_MISSING'
    return { data: { text: marker } }
  })
  mockTerminate.mockReset().mockResolvedValue(undefined)
  mockCreateWorker.mockReset().mockResolvedValue({ recognize: mockRecognize, terminate: mockTerminate })
})

async function registerToken(username: string): Promise<string> {
  const result = await request(createApp())
    .post('/api/auth/register')
    .send({ username, password: TEST_PASSWORD })
  expect(result.status).toBe(200)
  return result.body.token as string
}

describe('PDF image OCR through stories routes', () => {
  it('serves text-layer PDFs without Tesseract and beats controlled OCR startup time', async () => {
    const token = await registerToken('pdf_text_fast_path')
    const app = createApp()
    const headers = { Authorization: `Bearer ${token}` }
    const textPdf = await makePdfWithText('Text layer route fast path')

    const textUpload = await request(app)
      .post('/api/stories/upload')
      .set(headers)
      .attach('file', textPdf, 'text-only.pdf')
    expect(textUpload.status).toBe(200)

    const warmup = await request(app).get('/api/stories/text-only.pdf/rag').set(headers)
    expect(warmup.status).toBe(200)
    expect(warmup.body.content).toContain('Text layer route fast path')
    expect(mockTesseractModuleLoad).not.toHaveBeenCalled()
    expect(mockCreateWorker).not.toHaveBeenCalled()

    const imagePdf = await makePdfWithEmbeddedImages([['01']])
    const imageUpload = await request(app)
      .post('/api/stories/upload')
      .set(headers)
      .attach('file', imagePdf, 'image.pdf')
    expect(imageUpload.status).toBe(200)

    mockCreateWorker.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      return { recognize: mockRecognize, terminate: mockTerminate }
    })

    const fastStart = performance.now()
    const fastRead = await request(app).get('/api/stories/text-only.pdf/rag').set(headers)
    const textOnlyMs = performance.now() - fastStart
    expect(fastRead.status).toBe(200)
    expect(fastRead.body.content).toContain('Text layer route fast path')
    expect(mockCreateWorker).not.toHaveBeenCalled()

    const ocrStart = performance.now()
    const ocrRead = await request(app).get('/api/stories/image.pdf/rag').set(headers)
    const imageOcrMs = performance.now() - ocrStart
    expect(ocrRead.status).toBe(200)
    expect(ocrRead.body.content).toContain('OCR_EVIDENCE_01')
    expect(mockTesseractModuleLoad).toHaveBeenCalledTimes(1)
    expect(mockCreateWorker).toHaveBeenCalledTimes(1)
    expect(textOnlyMs).toBeLessThan(imageOcrMs)
  }, PDF_ROUTE_TIMEOUT_MS)

  it('returns ninth and later embedded-image evidence from the PDF RAG route', async () => {
    const token = await registerToken('pdf_ocr_route')
    const app = createApp()
    const markers = [['01', '02'], ['03', '04', '05'], ['06', '07', '08', '09', '10']]
    const pdf = await makePdfWithEmbeddedImages(markers)

    const upload = await request(app)
      .post('/api/stories/upload')
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', pdf, 'evidence.pdf')
    expect(upload.status).toBe(200)
    expect(upload.body).toMatchObject({ ok: true, id: 'evidence.pdf' })

    const result = await request(app)
      .get('/api/stories/evidence.pdf/rag')
      .set({ Authorization: `Bearer ${token}` })

    expect(result.status).toBe(200)
    expect(result.body.content).toContain('[第3页 插图 4]\nOCR_EVIDENCE_09')
    expect(result.body.content).toContain('[第3页 插图 5]\nOCR_EVIDENCE_10')
  }, PDF_ROUTE_TIMEOUT_MS)
})

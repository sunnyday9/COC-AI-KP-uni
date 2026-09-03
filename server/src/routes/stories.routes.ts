import { Router } from 'express'
import multer from 'multer'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import { assertId, sanitizeFilename, repairMojibakeFilename } from '../utils/fileNames.js'
import { MAX_UPLOAD_BYTES } from '../config.js'
import * as storyService from '../services/storyService.js'

/**
 * Story/file routes (api-contract §5) — migrated from fileHandlers.cjs.
 *
 * Upload (POST /upload, multipart field `file`) is served via multer
 * memoryStorage (bounded by MAX_UPLOAD_BYTES = 50MB per §10; the original
 * dialog had no size cap but parsePdfWithOcr defends at 50MB too). The
 * multer-level rejections (oversized / malformed multipart) return HTTP
 * error statuses; service-level business failures mirror the original IPC
 * shape `{ ok: false, error }` with 200 (importStory returned that object
 * rather than rejecting).
 */
const router = Router()

router.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  // busboy decodes multipart header params (incl. filename) as latin1 by
  // default → CJK filenames arrive mojibake'd. Request utf-8 so multer
  // normalizes the header; importStory additionally repairs any bytes that
  // were already latin1-decoded by an older proxy/browser.
  defParamCharset: 'utf-8',
})

/** GET /api/stories — file:listStories → [{ name, id }]. */
router.get('/', (req: AuthRequest, res) => {
  void storyService
    .listStories(req.userId as number)
    .then((stories) => res.json(stories))
    .catch((err) => sendError(res, err))
})

/** POST /api/stories/upload — file:importStory (multipart field: file). */
router.post('/upload', (req: AuthRequest, res) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` })
          return
        }
        res.status(400).json({ error: `upload rejected: ${err.code}` })
        return
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'upload failed' })
      return
    }
    void storyService
      .importStory(req.userId as number, req.file)
      .then((result) => {
        // UTF-8 named file uploads can arrive latin1-mangled (header charset
        // negotiation) — repair the *display* name while the storage id keeps
        // its sanitized (safe-ascii) form.
        if (result && result.ok && typeof result.name === 'string' && typeof result.id === 'string') {
          const repaired = repairMojibakeFilename(result.name)
          if (repaired !== result.name) {
            return res.json({ ...result, name: repaired })
          }
        }
        return res.json(result)
      })
      .catch((e) => sendError(res, e))
  })
})

/** GET /api/stories/:id/rag — file:readStoryForRag → { name, content }. */
router.get('/:id/rag', (req: AuthRequest, res) => {
  let id: string
  try {
    id = assertId(req.params.id as string, 'story id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void storyService
    .readStoryForRag(req.userId as number, id)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** GET /api/stories/:id — file:readStory → { name, content }. */
router.get('/:id', (req: AuthRequest, res) => {
  let id: string
  try {
    id = assertId(req.params.id as string, 'story id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void storyService
    .readStory(req.userId as number, id)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** DELETE /api/stories/:id — file:deleteStory (file only; no RAG linkage). */
router.delete('/:id', (req: AuthRequest, res) => {
  let id: string
  try {
    id = assertId(req.params.id as string, 'story id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void storyService
    .deleteStory(req.userId as number, id)
    .then(() => res.json({ ok: true }))
    .catch((err) => sendError(res, err))
})

export default router

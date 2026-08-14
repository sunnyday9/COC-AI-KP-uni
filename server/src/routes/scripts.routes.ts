import { Router } from 'express'
import multer from 'multer'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import { MAX_UPLOAD_BYTES } from '../config.js'
import * as scriptService from '../services/scriptService.js'

/**
 * Script library routes (api-contract §6) — migrated from fileHandlers.cjs
 * (file:listScripts / readScript / saveScript / saveScriptToLibrary /
 * deleteScript / importScript). PUT /api/scripts/:id is an upsert covering
 * both saveScript (update) and saveScriptToLibrary (create).
 */
const router = Router()

router.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

/** GET /api/scripts — file:listScripts → [{ name, id }]. */
router.get('/', (req: AuthRequest, res) => {
  void scriptService
    .listScripts(req.userId as number)
    .then((scripts) => res.json(scripts))
    .catch((err) => sendError(res, err))
})

/** GET /api/scripts/:id — file:readScript → { name, content }. */
router.get('/:id', (req: AuthRequest, res) => {
  void scriptService
    .readScript(req.userId as number, req.params.id as string)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** PUT /api/scripts/:id — file:saveScript / file:saveScriptToLibrary (upsert). */
router.put('/:id', (req: AuthRequest, res) => {
  const content = (req.body as { content?: unknown } | undefined)?.content
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' })
    return
  }
  void scriptService
    .saveScript(req.userId as number, req.params.id as string, content)
    .then(() => res.json({ ok: true }))
    .catch((err) => sendError(res, err))
})

/** POST /api/scripts/upload — file:importScript (multipart field: file). */
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
    void scriptService
      .importScript(req.userId as number, req.file)
      .then((result) => res.json(result))
      .catch((e) => sendError(res, e))
  })
})

/** DELETE /api/scripts/:id — file:deleteScript. */
router.delete('/:id', (req: AuthRequest, res) => {
  void scriptService
    .deleteScript(req.userId as number, req.params.id as string)
    .then(() => res.json({ ok: true }))
    .catch((err) => sendError(res, err))
})

export default router

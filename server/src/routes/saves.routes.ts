import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import * as saveService from '../services/saveService.js'

/**
 * Save routes (api-contract §7) — migrated from saveHandlers.cjs
 * (save:list / save:read / save:write) with DB storage (Task 1 `saves`
 * table) and the contract's DELETE endpoint (no original handler).
 */
const router = Router()

router.use(requireAuth)

/** GET /api/saves — save:list → string[] (saveIds). */
router.get('/', (req: AuthRequest, res) => {
  try {
    res.json(saveService.listSaves(req.userId as number))
  } catch (err) {
    sendError(res, err)
  }
})

/** GET /api/saves/:id — save:read → GameSaveSnapshot. */
router.get('/:id', (req: AuthRequest, res) => {
  try {
    res.json(saveService.readSave(req.userId as number, req.params.id as string))
  } catch (err) {
    sendError(res, err)
  }
})

/** PUT /api/saves/:id — save:write (body: GameSaveSnapshot). */
router.put('/:id', (req: AuthRequest, res) => {
  try {
    saveService.writeSave(req.userId as number, req.params.id as string, req.body)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

/** DELETE /api/saves/:id — new per api-contract §7. */
router.delete('/:id', (req: AuthRequest, res) => {
  try {
    saveService.deleteSave(req.userId as number, req.params.id as string)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

export default router

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import * as settingsService from '../services/settingsService.js'
import { sendError } from '../utils/errors.js'

/**
 * Settings routes (api-contract §2) — 替代 electron-store:
 *   GET /api/settings  → AppSettings (apiKey omitted)
 *   PUT /api/settings  → { ok: true } (400 on validation failure)
 */
const router = Router()

router.get('/', requireAuth, (req: AuthRequest, res) => {
  res.json(settingsService.getSettings(req.userId as number))
})

router.put('/', requireAuth, (req: AuthRequest, res) => {
  try {
    settingsService.saveSettings(req.userId as number, req.body)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

export default router

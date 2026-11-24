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

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    res.json(await settingsService.getGatewaySettings(req.userId as number))
  } catch (err) {
    sendError(res, err)
  }
})

router.put('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    await settingsService.saveGatewaySettings(req.userId as number, req.body)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

export default router

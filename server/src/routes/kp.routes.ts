import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { invokeKp } from '../services/kpAgentService.js'
import type { KpMessage } from '../agent/kpGraph.js'
import { sendError } from '../utils/errors.js'

/**
 * KP Agent routes (api-contract §4):
 *   POST /api/kp/invoke  { messages: { role, content }[] }
 *                        → { content?: string, toolCalls?: { id, name, arguments }[] }
 *
 * Single-shot, non-streamed graph run; config (provider/baseUrl/model/apiKey)
 * is read server-side from the user's settings. Graph failures map to 502
 * `{ error }` (sendError), timeout guarded by the service (120s).
 */
const router = Router()

router.post('/invoke', requireAuth, async (req: AuthRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await invokeKp(req.userId as number, {
      messages: body.messages as KpMessage[],
    })
    res.json(result)
  } catch (err) {
    sendError(res, err)
  }
})

export default router

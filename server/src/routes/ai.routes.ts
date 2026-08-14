import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import * as aiService from '../services/aiService.js'
import { sendError } from '../utils/errors.js'

/**
 * AI routes (api-contract §3):
 *   POST /api/ai/chat  { messages, temperature?, maxTokens?, stream? }
 *                      → { stream: boolean, content?, chunks? }
 *   GET  /api/ai/models?purpose=chat|embeddings → { value, label }[]
 *
 * AI config (provider/baseUrl/model/apiKey) is read server-side from the
 * user's settings — the request body carries none.
 */
const router = Router()

router.post('/chat', requireAuth, async (req: AuthRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await aiService.chat(req.userId as number, {
      messages: body.messages as { role: string; content: string }[],
      temperature: body.temperature as number | undefined,
      maxTokens: body.maxTokens as number | undefined,
      stream: body.stream as boolean | undefined,
    })
    res.json(result)
  } catch (err) {
    sendError(res, err)
  }
})

router.get('/models', requireAuth, async (req: AuthRequest, res) => {
  try {
    const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : 'chat'
    const list = await aiService.listModels(req.userId as number, purpose)
    res.json(list)
  } catch (err) {
    sendError(res, err)
  }
})

export default router

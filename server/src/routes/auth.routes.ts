import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import * as authService from '../services/authService.js'
import { sendError } from '../utils/errors.js'

/**
 * Auth routes (api-contract §1):
 *   POST /api/auth/register  { username, password } → { token, user }
 *   POST /api/auth/login     { username, password } → { token, user }
 *   GET  /api/auth/me        (requireAuth) → { user }
 */
const router = Router()

router.post('/register', async (req, res) => {
  try {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown }
    const result = await authService.register(username, password)
    res.json(result)
  } catch (err) {
    sendError(res, err)
  }
})

router.post('/login', async (req, res) => {
  try {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown }
    const result = await authService.login(username, password)
    res.json(result)
  } catch (err) {
    sendError(res, err)
  }
})

router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const user = authService.getUserById(req.userId as number)
  if (!user) {
    res.status(401).json({ error: 'user not found' })
    return
  }
  res.json({ user })
})

export default router

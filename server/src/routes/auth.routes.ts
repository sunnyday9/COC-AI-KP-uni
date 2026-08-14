import { Router } from 'express'
import { notImplemented } from './notImplemented.js'

/**
 * Auth routes (Task 2): POST /api/auth/register, POST /api/auth/login, GET /api/auth/me.
 * Mounted now as placeholders; real implementation lands in Task 2.
 */
const router = Router()

router.all('*', notImplemented)

export default router

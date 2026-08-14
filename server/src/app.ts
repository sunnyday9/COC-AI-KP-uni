import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { PORT } from './config.js'
import { logger } from './utils/logging.js'
import { createWsServer } from './ws/index.js'
import authRoutes from './routes/auth.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import aiRoutes from './routes/ai.routes.js'
import kpRoutes from './routes/kp.routes.js'
import storiesRoutes from './routes/stories.routes.js'
import scriptsRoutes from './routes/scripts.routes.js'
import savesRoutes from './routes/saves.routes.js'
import ragRoutes from './routes/rag.routes.js'

/**
 * Express application factory.
 *
 * Route mounting per api-contract: /api/auth, /api/settings, /api/ai, /api/kp,
 * /api/stories, /api/scripts, /api/saves, /api/rag.
 * All business routes are 501 placeholders in this phase (Task 1 scaffold only).
 */
export function createApp(): Express {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.use('/api/auth', authRoutes)
  app.use('/api/settings', settingsRoutes)
  app.use('/api/ai', aiRoutes)
  app.use('/api/kp', kpRoutes)
  app.use('/api/stories', storiesRoutes)
  app.use('/api/scripts', scriptsRoutes)
  app.use('/api/saves', savesRoutes)
  app.use('/api/rag', ragRoutes)

  // 404 — unified JSON error shape { error }
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  // Unified error handler — { error } + status code
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled error', { error: String(err) })
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}

// ── Direct-run bootstrap: `tsx watch src/app.ts` ────────────────────────────
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const httpServer = createApp().listen(PORT, () => {
    logger.info(`COC AI KP server listening on http://localhost:${PORT}`)
  })
  createWsServer(httpServer)
}

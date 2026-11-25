import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { DEPLOYMENT_MODE, ROOM_RUNTIME, ROOM_WORKER_FAILOVER_ENABLED, SHARED_ROOMS_ENABLED, SHARED_ROOM_CATALOG_ENABLED, PORT, assertRuntimeConfig, isMockAiMode } from './config.js'
import { logger } from './utils/logging.js'
import { CapacityError, sendError } from './utils/errors.js'
import { getDb } from './db/index.js'
import { getPostgresPool, initializePostgres } from './db/postgres.js'
import { initializePostgresRooms } from './db/postgresRoomsSchema.js'
import { startRoomReaper } from './services/roomService.js'
import { roomWorkerId } from './services/roomStorage.js'
import { executeRoomCommand } from './services/roomCommands.js'
import { initializeRoomMailbox, runRoomMailbox } from './services/roomMailbox.js'
import { initializeRoomPresence } from './services/roomPresence.js'
import { markGatewayDraining, runGatewayPresence, waitForGatewayPresenceCleanup } from './ws/gatewayPresence.js'
import { markTransportReset } from './ws/sendFrame.js'
import { runGatewayRoomFanout } from './ws/gatewayRooms.js'
import { createWsServer } from './ws/index.js'
import { hasSubscribers } from './ws/roomLedger.js'
import authRoutes from './routes/auth.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import aiRoutes from './routes/ai.routes.js'
import storiesRoutes from './routes/stories.routes.js'
import { createSharedStoriesRouter } from './routes/sharedStories.routes.js'
import { createSharedPreparedStoriesRouter, createSharedStoryPreparationRouter } from './routes/sharedStoryPreparation.routes.js'
import { STORY_PREPARATION_ENABLED } from './services/sharedStoryPreparation.js'
import { createSharedStoryCatalog } from './services/sharedStoryCatalog.js'
import { getStoryObjectStore } from './services/storyObjectStorage.js'
import ragRoutes from './routes/rag.routes.js'
import dossierRoutes from './routes/dossier.routes.js'
import roomsRoutes from './routes/rooms.routes.js'
import roomSettingsRoutes from './routes/roomSettings.routes.js'
import charactersRoutes from './routes/characters.routes.js'

const sharedAccounts = DEPLOYMENT_MODE === 'shared-accounts'

/**
 * Express application factory.
 *
 * Route mounting: /api/auth, /api/settings, /api/ai, /api/stories,
 * /api/rag, /api/rooms, /api/characters.
 * KP 回合只走房间协议（ADR-0002），无独立 kp 路由；/api/scripts 已随 #97 退役。
 */
export function createApp(): Express {
  assertRuntimeConfig()

  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.get('/health/ready', async (_req, res) => {
    try {
      if (sharedAccounts) await getPostgresPool().query('SELECT 1')
      else getDb().prepare('SELECT 1').get()
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'unavailable' })
    }
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/settings', settingsRoutes)
  const storyStorage = sharedAccounts ? getStoryObjectStore() : undefined
  if (storyStorage) {
    if (STORY_PREPARATION_ENABLED) {
      app.use('/api/stories', createSharedStoryPreparationRouter())
      app.use('/api/rag', createSharedPreparedStoriesRouter())
    }
    app.use('/api/stories', createSharedStoriesRouter(createSharedStoryCatalog(storyStorage)))
  }
  if (!sharedAccounts) {
    app.use('/api/ai', aiRoutes)
    app.use('/api/stories', storiesRoutes)
    app.use('/api/rag', ragRoutes)
    app.use('/api/dossier', dossierRoutes) // 实验分支：剧本档案 workflow（与 rag 并行）
  }
  if (!sharedAccounts || SHARED_ROOMS_ENABLED) {
    app.use('/api/rooms', roomsRoutes)
    app.use('/api/rooms', roomSettingsRoutes)
    app.use('/api/characters', charactersRoutes)
  }

  // 404 — unified JSON error shape { error }
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  // Unified error handler — { error } + status code.
  // Body-parser (malformed JSON / payload too large) and other 4xx errors
  // keep their status; everything else is a generic 500 (no stack traces).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof CapacityError) {
      if (!res.destroyed) sendError(res, err)
      return
    }
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 0
    if (status >= 400 && status < 500) {
      const type = (err as { type?: unknown }).type
      const message =
        typeof type === 'string' && (type.startsWith('entity.parse') || type === 'entity.too.large')
          ? 'invalid request body'
          : 'bad request'
      res.status(status).json({ error: message })
      return
    }
    logger.error('unhandled error', { error: String(err) })
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}

// ── Direct-run bootstrap: `tsx watch src/app.ts` ────────────────────────────
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

async function startServer(): Promise<void> {
  assertRuntimeConfig()
  // Apply the configured storage schema before accepting traffic. A failed or
  // unsupported migration must abort startup rather than fail on first use.
  if (sharedAccounts) {
    const enableStories = Boolean(getStoryObjectStore())
    if (STORY_PREPARATION_ENABLED && !enableStories) throw new Error('Story preparation requires story object storage')
    await initializePostgres(enableStories, STORY_PREPARATION_ENABLED)
    if (SHARED_ROOM_CATALOG_ENABLED && !STORY_PREPARATION_ENABLED) {
      throw new Error('Shared catalog gameplay requires STORY_PREPARATION_ENABLED=1')
    }
    if (SHARED_ROOMS_ENABLED) await initializePostgresRooms(ROOM_WORKER_FAILOVER_ENABLED, SHARED_ROOM_CATALOG_ENABLED)
  } else getDb()
  if (ROOM_RUNTIME !== 'direct') {
    await initializeRoomMailbox()
    await initializeRoomPresence()
  }
  if (ROOM_RUNTIME === 'worker') {
    startRoomReaper()
    logger.info('Room worker ready')
    await runRoomMailbox(roomWorkerId, executeRoomCommand)
    return
  }
  const httpServer = createApp().listen(PORT, () => {
    logger.info(`COC AI KP server listening on http://localhost:${PORT}`)
    if (isMockAiMode()) {
      logger.info('MOCK_AI mode enabled — all AI/LLM calls return deterministic mock responses (no API key / no outbound requests)')
    }
  })
  if (sharedAccounts && !SHARED_ROOMS_ENABLED) return
  const sockets = createWsServer(httpServer)
  if (ROOM_RUNTIME === 'gateway') {
    const lifetime = new AbortController()
    const drain = () => {
      markGatewayDraining()
      lifetime.abort()
      for (const socket of sockets.clients) markTransportReset(socket)
      const closed = Promise.all([
        new Promise<void>((resolve) => sockets.close(() => resolve())),
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
      ])
      for (const socket of sockets.clients) socket.terminate()
      void closed.then(waitForGatewayPresenceCleanup).then(() => process.exit(0))
      setTimeout(() => process.exit(0), 5_000).unref()
    }
    process.once('SIGTERM', drain)
    process.once('SIGINT', drain)
    httpServer.once('close', () => {
      lifetime.abort()
      process.off('SIGTERM', drain)
      process.off('SIGINT', drain)
    })
    void runGatewayRoomFanout(lifetime.signal)
    void runGatewayPresence(lifetime.signal)
    return
  }
  // 房间 TTL 回收（#86）：CONTEXT.md「活跃实例·TTL 回收」与 roomService 头注释
  // 声明的运行时行为在此装配——定期扫描 roomRegistry，把空闲超过 ROOM_TTL_MS
  // 的实例落库逐出（不删 DB 行，重进经 getOrCreateRoom 重物化）。只在真实进程
  // 入口启动：createApp() 是 supertest/测试复用入口，不背运行时定时器。
  // 返回句柄已 unref（roomService.startRoomReaper），不阻碍进程退出。
  startRoomReaper(60_000, (roomId) => !hasSubscribers(roomId))
}

if (isMain) await startServer()

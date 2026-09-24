import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import * as ragService from '../services/ragService.js'
import { runIdempotently, validOperationId } from '../services/operationIdempotency.js'
import { pushRagProgress } from '../ws/progress.js'

/**
 * RAG routes (api-contract §8) — migrated from the IPC handlers in
 * original/ai-trpg-web/electron/ipc/ragHandlers.cjs (one handler per route).
 * Every endpoint requires auth; data is isolated per userId + storyId.
 */
const router = Router()

router.use(requireAuth)

/** GET /api/rag/health — rag:health. */
router.get('/health', (req: AuthRequest, res) => {
  try {
    res.json(ragService.health(req.userId as number))
  } catch (err) {
    sendError(res, err)
  }
})

/** POST /api/rag/test-embedding — rag:testEmbedding. */
router.post('/test-embedding', (req: AuthRequest, res) => {
  void ragService
    .testEmbedding(req.userId as number)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** POST /api/rag/index — rag:index. */
router.post('/index', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const body = (req.body ?? {}) as { scriptId?: unknown; operationId?: unknown }
  const scriptId = typeof body.scriptId === 'string' ? body.scriptId : ''
  const operationId = validOperationId(body.operationId) ? body.operationId : undefined
  const run = () => ragService.index(userId, req.body, operationId
    ? (progress) => pushRagProgress(userId, { ...progress, operation: 'index', operationId, scriptId, state: 'running' })
    : undefined)
  const task = operationId
    ? runIdempotently(`index:${userId}:${scriptId}:${operationId}`, run, `index:${userId}:${scriptId}`)
    : run()

  void task
    .then((result) => {
      if (operationId) {
        pushRagProgress(userId, {
          operation: 'index', operationId, scriptId,
          stage: result.ok ? 'complete' : 'failed',
          percent: result.ok ? 100 : undefined,
          state: result.ok ? 'complete' : 'failed',
          message: result.ok ? result.warning || '索引完成' : result.error || '索引失败',
          ...(result.warning ? { warning: result.warning } : {}),
        })
      }
      res.json(result)
    })
    .catch((err) => {
      if (operationId) pushRagProgress(userId, { operation: 'index', operationId, scriptId, stage: 'failed', state: 'failed', message: err instanceof Error ? err.message : '索引失败' })
      sendError(res, err)
    })
})

/** DELETE /api/rag/index/:scriptId — rag:delete. */
router.delete('/index/:scriptId', (req: AuthRequest, res) => {
  try {
    res.json(ragService.deleteIndex(req.userId as number, req.params.scriptId as string))
  } catch (err) {
    sendError(res, err)
  }
})

/** POST /api/rag/query — rag:query. */
router.post('/query', (req: AuthRequest, res) => {
  void ragService
    .query(req.userId as number, req.body)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** POST /api/rag/context — rag:context. */
router.post('/context', (req: AuthRequest, res) => {
  void ragService
    .context(req.userId as number, req.body)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** GET /api/rag/stories — rag:listStories. */
router.get('/stories', (req: AuthRequest, res) => {
  try {
    res.json(ragService.listStories(req.userId as number))
  } catch (err) {
    sendError(res, err)
  }
})

/** GET /api/rag/index/:scriptId — rag:getIndex. */
router.get('/index/:scriptId', (req: AuthRequest, res) => {
  try {
    res.json(ragService.getIndex(req.userId as number, req.params.scriptId as string))
  } catch (err) {
    sendError(res, err)
  }
})


export default router

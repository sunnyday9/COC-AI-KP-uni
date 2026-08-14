import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import * as ragService from '../services/ragService.js'

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

/** POST /api/rag/test-graphrag-extract — rag:testGraphRagExtract. */
router.post('/test-graphrag-extract', (req: AuthRequest, res) => {
  void ragService
    .testGraphRagExtract(req.userId as number, req.body)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** POST /api/rag/index — rag:index. */
router.post('/index', (req: AuthRequest, res) => {
  void ragService
    .index(req.userId as number, req.body)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
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

/** POST /api/rag/story-overview — rag:storyOverview. */
router.post('/story-overview', (req: AuthRequest, res) => {
  try {
    res.json(ragService.storyOverview(req.userId as number, req.body))
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

/** GET /api/rag/graph/:scriptId — rag:getGraph. */
router.get('/graph/:scriptId', (req: AuthRequest, res) => {
  try {
    res.json(ragService.getGraph(req.userId as number, req.params.scriptId as string))
  } catch (err) {
    sendError(res, err)
  }
})

/** POST /api/rag/user-graph/event — rag:userGraphAdd. */
router.post('/user-graph/event', (req: AuthRequest, res) => {
  try {
    ragService.userGraphAdd(req.userId as number, req.body)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

/** POST /api/rag/user-graph/sync — rag:userGraphSync. */
router.post('/user-graph/sync', (req: AuthRequest, res) => {
  try {
    ragService.userGraphSync(req.userId as number, req.body)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

/** POST /api/rag/user-graph/summary — rag:userGraphSummary. */
router.post('/user-graph/summary', (req: AuthRequest, res) => {
  try {
    res.json({ summary: ragService.userGraphSummary(req.userId as number, req.body) })
  } catch (err) {
    sendError(res, err)
  }
})

export default router

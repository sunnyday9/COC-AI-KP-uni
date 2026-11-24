import { Router } from 'express'
import { listPreparedStories } from '../services/preparedStoryStorage.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { cancelStoryPreparation, readStoryPreparation, requestStoryPreparation } from '../services/sharedStoryPreparation.js'
import { validOperationId } from '../services/operationIdempotency.js'
import { BadRequestError, sendError } from '../utils/errors.js'
import { assertId } from '../utils/fileNames.js'

export function createSharedPreparedStoriesRouter() {
  const router = Router()
  router.get('/stories', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      res.json(await listPreparedStories(req.userId!, req.query.limit, req.query.cursor))
    } catch (error) {
      sendError(res, error)
    }
  })
  return router
}

function preparationJobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestError('无效的准备任务标识。')
  }
  return value.toLowerCase()
}

export function createSharedStoryPreparationRouter() {
  const router = Router()
  router.get('/:id/preparation', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      res.json(await readStoryPreparation(req.userId!, assertId(req.params.id as string, 'story id')))
    } catch (error) {
      sendError(res, error)
    }
  })
  router.post('/:id/preparation', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      const operationId: unknown = req.body?.operationId
      if (operationId !== undefined && !validOperationId(operationId)) throw new BadRequestError('无效的准备操作标识。')
      res.status(202).json(await requestStoryPreparation(req.userId!, assertId(req.params.id as string, 'story id'), operationId))
    } catch (error) {
      sendError(res, error)
    }
  })
  router.post('/:id/preparation/:jobId/retry', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      const operationId: unknown = req.body?.operationId
      if (!validOperationId(operationId)) throw new BadRequestError('重试需要有效的准备操作标识。')
      res.status(202).json(await requestStoryPreparation(
        req.userId!, assertId(req.params.id as string, 'story id'), operationId, preparationJobId(req.params.jobId),
      ))
    } catch (error) {
      sendError(res, error)
    }
  })
  router.post('/:id/preparation/:jobId/cancel', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      res.json(await cancelStoryPreparation(
        req.userId!, assertId(req.params.id as string, 'story id'), preparationJobId(req.params.jobId),
      ))
    } catch (error) {
      sendError(res, error)
    }
  })
  return router
}

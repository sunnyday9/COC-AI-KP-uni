import { Router } from 'express'
import { listPreparedStories } from '../services/preparedStoryStorage.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { readStoryPreparation, requestStoryPreparation } from '../services/sharedStoryPreparation.js'
import { sendError } from '../utils/errors.js'
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
      res.status(202).json(await requestStoryPreparation(req.userId!, assertId(req.params.id as string, 'story id')))
    } catch (error) {
      sendError(res, error)
    }
  })
  return router
}

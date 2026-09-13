import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import { assertId } from '../utils/fileNames.js'
import * as scriptService from '../services/scriptService.js'

/**
 * Script library routes (api-contract §6) — migrated from fileHandlers.cjs
 * (file:readScript / saveScript / saveScriptToLibrary / deleteScript). PUT
 * /api/scripts/:id is an upsert covering both saveScript (update) and
 * saveScriptToLibrary (create).
 *
 * GET /api/scripts（列表）与 POST /api/scripts/upload 已于 2026-09-13 退役
 * （#91 C 桶「全链退役」拍板，#94）：客户端 bridge 包装（listScripts/
 * importScript）零页面调用方，端点全仓零直接消费方（e2e uploadScript 帮助
 * 函数与剧本页上传实际走 /api/stories/upload）。
 */
const router = Router()

router.use(requireAuth)

/** GET /api/scripts/:id — file:readScript → { name, content }. */
router.get('/:id', (req: AuthRequest, res) => {
  let id: string
  try {
    id = assertId(req.params.id as string, 'script id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void scriptService
    .readScript(req.userId as number, id)
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** PUT /api/scripts/:id — file:saveScript / file:saveScriptToLibrary (upsert). */
router.put('/:id', (req: AuthRequest, res) => {
  const content = (req.body as { content?: unknown } | undefined)?.content
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' })
    return
  }
  let id: string
  try {
    id = assertId(req.params.id as string, 'script id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void scriptService
    .saveScript(req.userId as number, id, content)
    .then(() => res.json({ ok: true }))
    .catch((err) => sendError(res, err))
})

/** DELETE /api/scripts/:id — file:deleteScript. */
router.delete('/:id', (req: AuthRequest, res) => {
  let id: string
  try {
    id = assertId(req.params.id as string, 'script id')
  } catch (err) {
    sendError(res, err)
    return
  }
  void scriptService
    .deleteScript(req.userId as number, id)
    .then(() => res.json({ ok: true }))
    .catch((err) => sendError(res, err))
})

export default router

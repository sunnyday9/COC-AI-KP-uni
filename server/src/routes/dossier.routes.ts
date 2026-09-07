/**
 * Dossier routes (experiment branch feature/kp-dossier-workflow) — 剧本档案
 * 工作流的 REST 面，与 rag.routes 完全独立（rag workflow 的索引/检索代码路径
 * 保持原样 = A/B 对照基准）。
 *
 *  - POST /api/dossier/:scriptId/generate   生成剧本档案（LLM 抽取）
 *  - GET  /api/dossier                      档案清单（房主选剧本/门闩用）
 *
 * 档案内容读取不设 REST 端点（测试/harness 直连服务层或读落盘 JSON——读取非
 * 游戏路径；开局门闩只依赖清单）。
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../utils/errors.js'
import { assertSafeId } from '../utils/pathSafety.js'
import * as dossierService from '../rag/dossier/storyDossierService.js'

const router = Router()

router.use(requireAuth)

/** POST /api/dossier/:scriptId/generate — 生成剧本档案。body: { model? }。
 *  scriptId 保留原始 story id（读 story 原文）；assertSafeId 只校验不净化，
 *  服务层 generateDossier 内部白名单 sanitize 后落盘。 */
router.post('/:scriptId/generate', (req: AuthRequest, res) => {
  const userId = req.userId as number
  let scriptId: string
  try {
    scriptId = assertSafeId(String(req.params.scriptId ?? ''), 'scriptId')
  } catch (err) {
    sendError(res, err)
    return
  }
  const body = (req.body ?? {}) as { model?: unknown }
  void dossierService
    .generateDossier(userId, scriptId, { model: typeof body.model === 'string' ? body.model : undefined })
    .then((result) => res.json(result))
    .catch((err) => sendError(res, err))
})

/** GET /api/dossier — 档案清单（房主选剧本/门闩用）。 */
router.get('/', (req: AuthRequest, res) => {
  const userId = req.userId as number
  void dossierService
    .listDossiers(userId)
    .then((list) => res.json(list))
    .catch((err) => sendError(res, err))
})

export default router

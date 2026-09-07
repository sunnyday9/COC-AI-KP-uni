/**
 * Dossier routes (experiment branch feature/kp-dossier-workflow) — 剧本档案
 * 工作流的 REST 面，与 rag.routes 完全独立（rag workflow 的索引/检索代码路径
 * 保持原样 = A/B 对照基准）。
 *
 *  - POST   /api/dossier/:scriptId/generate   生成剧本档案（LLM 抽取）
 *  - GET    /api/dossier/:scriptId            读档案（结构化 JSON）
 *  - DELETE /api/dossier/:scriptId            删档案
 *  - GET    /api/dossier                      档案清单（房主选剧本用）
 * Every endpoint requires auth; data is isolated per userId.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, BadRequestError } from '../utils/errors.js'
import { assertSafeId } from '../utils/pathSafety.js'
import * as dossierService from '../rag/dossier/storyDossierService.js'

const router = Router()

router.use(requireAuth)

/** scriptId 入口净化：白名单过滤到安全字符集（与 vectorStore.indexPath 同款规则，
 * 文件名只含 [a-zA-Z0-9_-\u4e00-\u9fff]，穿越字符/分隔符被替换——sanitize 幂等）。 */
function parseScriptId(raw: unknown): string {
  const scriptId = String(raw ?? '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
  if (!scriptId) throw new BadRequestError('invalid scriptId')
  return scriptId
}

/** POST /api/dossier/:scriptId/generate — 生成剧本档案。body: { model? }。
 *  scriptId 必须保留原始 story id（读 story 原文）；assertSafeId 只校验不净化
 *  （拒绝穿越/危险字符），服务层 generateDossier 内部白名单 sanitize 后落盘。 */
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

/** GET /api/dossier/:scriptId — 读档案（结构化）。404 语义：无档案返回 null。 */
router.get('/:scriptId', (req: AuthRequest, res) => {
  const userId = req.userId as number
  let scriptId: string
  try {
    scriptId = parseScriptId(req.params.scriptId)
  } catch (err) {
    sendError(res, err)
    return
  }
  void dossierService
    .loadDossier(userId, scriptId)
    .then((dossier) => {
      if (!dossier) {
        res.json(null)
        return
      }
      res.json({
        scriptId: dossier.scriptId,
        storyName: dossier.storyName,
        generatedAt: dossier.generatedAt,
        generatedByModel: dossier.generatedByModel ?? null,
        scenes: dossier.scenes.map((s) => ({ id: s.id, name: s.name, description: s.description ?? null })),
        clueCount: dossier.clues.length,
        npcCount: dossier.npcs.length,
      })
    })
    .catch((err) => sendError(res, err))
})

/** DELETE /api/dossier/:scriptId — 删档案。 */
router.delete('/:scriptId', (req: AuthRequest, res) => {
  const userId = req.userId as number
  let scriptId: string
  try {
    scriptId = parseScriptId(req.params.scriptId)
  } catch (err) {
    sendError(res, err)
    return
  }
  void dossierService
    .deleteDossier(userId, scriptId)
    .then((deleted) => res.json({ ok: deleted }))
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

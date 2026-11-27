/**
 * Character routes (Phase B4, 架构方案 v2.0 D9) — 角色卡持久化。
 *  - POST   /api/characters       创建角色卡（sheet = COCCharacterSheet JSON）
 *  - GET    /api/characters       我的角色卡列表
 *  - POST   /api/rooms/:roomId/character  绑定角色卡到房间（一人一卡）
 *
 * GET/DELETE /api/characters/:id 已于 2026-09-13 退役（#91 C 桶「全链退役」拍板，#94）：
 * 客户端 bridge 包装（characterDetail/characterDelete）零页面调用方已于 #94 删除，
 * 端点全仓零直接消费方（仅路由自测）。
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, BadRequestError } from '../utils/errors.js'
import { createCharacter, listCharactersForUser } from '../services/roomService.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'

const router = Router()

router.use(requireAuth)

/** POST /api/characters — 创建角色卡。 */
router.post('/', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  const body = (req.body ?? {}) as { name?: unknown; sheet?: unknown }
  const name = String(body.name ?? '').trim()
  const sheet = body.sheet as COCCharacterSheet | undefined
  if (!name) {
    sendError(res, new BadRequestError('name required'))
    return
  }
  if (!sheet || typeof sheet !== 'object' || !sheet.derived) {
    sendError(res, new BadRequestError('sheet required (COCCharacterSheet)'))
    return
  }
  const character = await createCharacter(userId, name, sheet)
  res.json({ ok: true, ...character })
})

/** GET /api/characters — 我的角色卡列表。 */
router.get('/', async (req: AuthRequest, res) => {
  const userId = req.userId as number
  res.json(await listCharactersForUser(userId))
})

export default router

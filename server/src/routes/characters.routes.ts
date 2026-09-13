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
import crypto from 'node:crypto'
import type { AuthRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError, BadRequestError } from '../utils/errors.js'
import { getDb } from '../db/index.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'

const router = Router()

router.use(requireAuth)

interface CharacterRow {
  id: string
  user_id: number
  name: string
  sheet: string
  updated_at: number
}

function toCharacter(row: CharacterRow): { id: string; name: string; sheet: COCCharacterSheet; updatedAt: number } {
  let sheet: COCCharacterSheet
  try {
    sheet = JSON.parse(row.sheet) as COCCharacterSheet
  } catch {
    sheet = {} as COCCharacterSheet
  }
  return { id: row.id, name: row.name, sheet, updatedAt: row.updated_at }
}

/** POST /api/characters — 创建角色卡。 */
router.post('/', (req: AuthRequest, res) => {
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
  const id = `char_${crypto.randomUUID().slice(0, 8)}`
  const db = getDb()
  db.prepare(`INSERT INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, userId, name, JSON.stringify(sheet), Date.now())
  res.json({ ok: true, id, name })
})

/** GET /api/characters — 我的角色卡列表。 */
router.get('/', (req: AuthRequest, res) => {
  const userId = req.userId as number
  const rows = getDb()
    .prepare(`SELECT id, user_id, name, sheet, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as unknown as CharacterRow[]
  res.json(rows.map(toCharacter))
})

export default router

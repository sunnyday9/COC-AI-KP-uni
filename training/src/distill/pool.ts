/**
 * 调查员池与 rollout 调度（T4）。
 *
 * 角色卡从 server DB（rooms.state.characters / saves.characterSheet）只读装载——
 * DB 路径为模块常量（D-09 外部输入不进 fs 路径），SELECT 全参数绑定。
 * rollout = （剧本 × 调查员小队 × 回合类型序列）的一场合成对局：状态（场景/线索/
 * 记忆/角色卡）跨回合演化，产出与真实对局同构的连续情境。
 *
 * 随机数用种子化 mulberry32（--seed），同一计划可复现（成本审计/回归友好）。
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { TurnType } from './types.js'
import { TURN_TYPE_WEIGHTS } from './turnTypes.js'

export interface SheetEntry {
  characterId: string
  sheet: COCCharacterSheet
  provenance: string
}

/** 形状校验：缺属性/技能/derived 的坏卡不进池（避免工具上下文运行时缺字段）。 */
function isUsableSheet(sheet: unknown): sheet is COCCharacterSheet {
  const s = sheet as COCCharacterSheet | null
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.playerName === 'string' &&
    !!s.attributes &&
    !!s.skills &&
    !!s.derived &&
    typeof s.derived.hp === 'number' &&
    typeof s.derived.san === 'number'
  )
}

/** 从 DB 只读装载调查员卡池（rooms + saves；同名调查员去重取首张）。 */
export function loadSheetPool(dbPath: string): { entries: SheetEntry[]; warnings: string[] } {
  if (!fs.existsSync(dbPath)) throw new Error(`DB 文件不存在: ${dbPath}（与 #38 导出器同一数据源）`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const warnings: string[] = []
  const entries: SheetEntry[] = []
  const seen = new Set<string>()

  const push = (characterId: string, sheet: unknown, provenance: string): void => {
    if (!isUsableSheet(sheet)) {
      warnings.push(`角色卡不可用已跳过: ${provenance}/${characterId}`)
      return
    }
    if (seen.has(sheet.playerName)) return
    seen.add(sheet.playerName)
    entries.push({ characterId, sheet, provenance })
  }

  const roomRows = db.prepare(`SELECT room_id, state FROM rooms ORDER BY room_id ASC`).all() as unknown as {
    room_id: string
    state: string
  }[]
  for (const row of roomRows) {
    try {
      const state = JSON.parse(row.state) as { characters?: Record<string, unknown> | unknown[] }
      const chars = state.characters ?? {}
      if (Array.isArray(chars)) {
        chars.forEach((c, i) => push(`char_${i}`, c, `room:${row.room_id}`))
      } else {
        for (const [id, c] of Object.entries(chars)) push(id, c, `room:${row.room_id}`)
      }
    } catch (err) {
      warnings.push(`room ${row.room_id}: state 解析失败已跳过（${err instanceof Error ? err.message : String(err)}）`)
    }
  }

  const saveRows = db.prepare(`SELECT save_id, data FROM saves ORDER BY save_id ASC`).all() as unknown as {
    save_id: string
    data: string
  }[]
  for (const row of saveRows) {
    try {
      const data = JSON.parse(row.data) as { characterSheet?: unknown }
      if (data.characterSheet) push('char_0', data.characterSheet, `save:${row.save_id}`)
    } catch (err) {
      warnings.push(`save ${row.save_id}: data 解析失败已跳过（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  db.close()
  return { entries, warnings }
}

/** 种子化 RNG（mulberry32）：[0,1) 均匀分布。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 权重抽样（weights 不含 opening——opening 由 rollout 固定首回合产生）。 */
export function pickTurnType(rng: () => number): TurnType {
  const total = TURN_TYPE_WEIGHTS.reduce((acc, [, w]) => acc + w, 0)
  let roll = rng() * total
  for (const [type, w] of TURN_TYPE_WEIGHTS) {
    roll -= w
    if (roll < 0) return type
  }
  return 'investigate_check'
}

export interface RolloutPlan {
  rolloutId: string
  storyName: string
  party: SheetEntry[]
  /** 回合类型序列（不含 opening；rollout 长度 = 1 + turns）。 */
  turns: TurnType[]
}

/**
 * 生成 rollout 计划：小队 1-4 人（权重偏小队，多人合并行动由 multi_player_mixed
 * 类型驱动）；长度 5-9 回合（含 opening——≤9 保证 longTermSummary 恒空，与线上
 * 前期对局分布一致：roomService 每 10 回合才刷新长期摘要）。
 */
export function planRollouts(options: {
  storyNames: string[]
  sheetPool: SheetEntry[]
  count: number
  seed: number
}): { plans: RolloutPlan[]; warnings: string[] } {
  const { storyNames, sheetPool, count, seed } = options
  if (sheetPool.length === 0) throw new Error('调查员卡池为空：DB 无可用角色卡')
  if (storyNames.length === 0) throw new Error('剧本语料为空：无法生成 rollout')
  const warnings: string[] = []
  const rng = makeRng(seed)
  const plans: RolloutPlan[] = []
  for (let i = 0; i < count; i++) {
    const storyName = storyNames[Math.floor(rng() * storyNames.length)]!
    const partySize = 1 + Math.floor(rng() * rng() * 4) // 1-4，偏小队
    const party: SheetEntry[] = []
    const used = new Set<string>()
    for (let p = 0; p < partySize && party.length < sheetPool.length; p++) {
      const entry = sheetPool[Math.floor(rng() * sheetPool.length)]!
      if (used.has(entry.characterId)) continue
      used.add(entry.characterId)
      party.push(entry)
    }
    const turnCount = 5 + Math.floor(rng() * 5) // 5-9 个非 opening 回合
    const turns: TurnType[] = Array.from({ length: turnCount }, () => pickTurnType(rng))
    if (party.length < partySize) warnings.push(`rollout roll_${i}: 卡池不足 ${partySize} 人，实际 ${party.length} 人`)
    plans.push({ rolloutId: `roll_${i}`, storyName, party, turns })
  }
  return { plans, warnings }
}

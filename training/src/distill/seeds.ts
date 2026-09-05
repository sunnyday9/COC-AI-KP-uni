/**
 * seed 路径（T4）：#38 导出器同源的 DB 只读切片 → 真实骨架 DistillSkeleton。
 *
 * 真实骨架的价值 = 真实玩家行动批次分布（spec #36「保玩家行动分布」）。切片与
 * 重建直接复用 exporter 的 extractStreamTurns / 重建输入组装（刚导出的单源），
 * 不复制流切片逻辑。seed 回合类型恒为 seed_organic（required=null——真实批次的
 * 回合意图不可靠重推，过滤器只跑机械检查）。
 *
 * RAG：rebuilt 离线不可得（与 #38 同一 caveat），seed 骨架 ragContext 恒空。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { Message } from '../../../shared/types/game.js'
import { extractStreamTurns, type StreamTurn } from '../exporter.js'
import type { DistillSkeleton } from './types.js'

const CAVEAT_RAG = 'rag_context_unavailable_offline'
const CAVEAT_FINAL_STATE = 'state_blocks_from_final_snapshot'

interface RoomRow {
  room_id: string
  owner_id: number
  story_id: string | null
  state: string
}

interface SaveRow {
  user_id: number
  save_id: string
  data: string
}

interface SeedSource {
  userId: number
  originId: string
  storyId: string | null
  storyName: string
  scene: string | null
  clues: { id: string; description: string }[]
  characters: Record<string, COCCharacterSheet>
  kpMemory: string[]
  longTermSummary: string
  messages: Message[]
  provenance: 'room' | 'save'
}

function seedSkeleton(src: SeedSource, turn: StreamTurn): DistillSkeleton {
  const kind = turn.kind
  return {
    id: `seed:${src.originId}#${turn.turnIndex}`,
    source: 'seed',
    kind,
    turnType: 'seed_organic',
    storyName: src.storyName,
    originId: src.originId,
    batchContent: turn.batchContent,
    batchPlayers: turn.batch.map((m) => m.playerName),
    characters: src.characters,
    activeCharacterId: Object.keys(src.characters)[0] ?? null,
    promptInput: {
      scene: kind === 'opening' ? null : src.scene,
      clues: kind === 'opening' ? [] : src.clues,
      history: kind === 'opening' ? [] : turn.history,
      kpMemory: src.kpMemory,
      longTermSummary: kind === 'opening' ? '' : src.longTermSummary,
    },
    ragContext: '',
    caveats: kind === 'opening' ? [CAVEAT_RAG] : [CAVEAT_RAG, CAVEAT_FINAL_STATE],
  }
}

/** rooms + saves 全量切片成 seed 骨架（与 #38 导出器同一数据面；wire 优先逻辑不在
 *  本票范围——本地 DB 当前 wire 采样为 0，导出器全 rebuilt）。 */
export function buildSeedSkeletons(dbPath: string): { skeletons: DistillSkeleton[]; warnings: string[] } {
  if (!fs.existsSync(dbPath)) throw new Error(`DB 文件不存在: ${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const warnings: string[] = []
  const skeletons: DistillSkeleton[] = []

  const storyNames = new Map<string, string>()
  for (const row of db.prepare(`SELECT user_id, story_id, name FROM stories`).all() as unknown as {
    user_id: number
    story_id: string
    name: string
  }[]) {
    storyNames.set(`${row.user_id}:${row.story_id}`, row.name)
  }

  const roomRows = db.prepare(`SELECT room_id, owner_id, story_id, state FROM rooms ORDER BY room_id ASC`).all() as unknown as RoomRow[]
  for (const room of roomRows) {
    try {
      const state = JSON.parse(room.state) as {
        messages?: Message[]
        scene?: string | null
        clues?: { id: string; description: string }[]
        characters?: Record<string, COCCharacterSheet> | COCCharacterSheet[]
        kpMemory?: string[]
        longTermSummary?: string
      }
      const chars = state.characters ?? {}
      const characters = Array.isArray(chars)
        ? Object.fromEntries(chars.map((c, i) => [`char_${i}`, c]))
        : chars
      const src: SeedSource = {
        userId: room.owner_id,
        originId: room.room_id,
        storyId: room.story_id,
        storyName: (room.story_id && storyNames.get(`${room.owner_id}:${room.story_id}`)) || '',
        scene: state.scene ?? null,
        clues: state.clues ?? [],
        characters,
        kpMemory: state.kpMemory ?? [],
        longTermSummary: state.longTermSummary ?? '',
        messages: state.messages ?? [],
        provenance: 'room',
      }
      for (const turn of extractStreamTurns(src.messages)) {
        skeletons.push(seedSkeleton(src, turn))
      }
    } catch (err) {
      warnings.push(`room ${room.room_id}: state 解析失败已跳过（${err instanceof Error ? err.message : String(err)}）`)
    }
  }

  const saveRows = db.prepare(`SELECT user_id, save_id, data FROM saves ORDER BY user_id, save_id ASC`).all() as unknown as SaveRow[]
  for (const save of saveRows) {
    try {
      const data = JSON.parse(save.data) as Record<string, unknown>
      const sheet = data.characterSheet as COCCharacterSheet | null
      const src: SeedSource = {
        userId: save.user_id,
        originId: save.save_id,
        storyId: (data.storyId as string | null) ?? null,
        storyName: (data.storyName as string) || '',
        scene: (data.currentScene as string) || null,
        clues: (data.cluesObtained as { id: string; description: string }[]) ?? [],
        characters: sheet ? { char_0: sheet } : {},
        kpMemory: (data.kpMemory as string[]) ?? [],
        longTermSummary: (data.longTermSummary as string) ?? '',
        messages: (data.messages as Message[]) ?? [],
        provenance: 'save',
      }
      for (const turn of extractStreamTurns(src.messages)) {
        skeletons.push(seedSkeleton(src, turn))
      }
    } catch (err) {
      warnings.push(`save ${save.save_id}: data 解析失败已跳过（${err instanceof Error ? err.message : String(err)}）`)
    }
  }

  db.close()
  return { skeletons, warnings }
}

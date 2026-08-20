/**
 * 存档迁移工具（Phase C3/A5）— 旧存档归一化 + 房间快照 ↔ 存档互转。
 *
 * - migrateSaveSnapshot：旧版快照（无 version / clues 为字符串数组 / 缺字段）
 *   归一化到当前 GameSaveSnapshot 结构（SAVE_VERSION=1）。
 * - roomSnapshotToSave：多人房间快照 → 单机存档（C3 房间导出：房间结束/中途
 *   可导出为单人续玩的存档）。
 * - saveToRoomSnapshot：单机存档 → 房间快照（C3 导入：把旧存档带进房间）。
 *
 * 纯函数（无 DB/IO），便于单测与复用。
 */
import type { COCCharacterSheet } from '../../../shared/types/character.js'

/** 与 client/src/services/saveService.ts 的 SAVE_VERSION 保持一致。 */
export const SAVE_VERSION = 1

export interface SaveSnapshot {
  version: number
  name?: string
  storyId: string | null
  storyName: string
  storyOverview: string
  currentScene: string
  cluesObtained: { id: string; description: string }[]
  messages: { id: string; timestamp: number; role: string; playerName?: string; content: string; isStreaming?: boolean }[]
  kpMemory: string[]
  longTermSummary: string
  longTermFacts: string[]
  playerTurnCount: number
  gamePhase: string
  characterSheet: COCCharacterSheet | null
  playerName: string
  selectedOccupationId: string | null
  selectedOccupationName: string
  sessionId: string | null
  endingState?: unknown
  scenesVisited?: string[]
}

export interface RoomSnapshotLike {
  seq?: number
  phase?: string
  storyId?: string | null
  messages?: { id: string; timestamp: number; role: string; playerName?: string; content: string; isStreaming?: boolean }[]
  characters?: Record<string, unknown>
  clues?: { id: string; description: string }[]
  scene?: string | null
  ending?: unknown | null
  turnWindowMs?: number
  updatedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归一化线索：legacy 字符串数组 → 结构化 { id, description }。 */
function normalizeClues(raw: unknown): { id: string; description: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.map((c) => {
    if (typeof c === 'string') return { id: '', description: c }
    if (isRecord(c) && typeof c.description === 'string') {
      return { id: typeof c.id === 'string' ? c.id : '', description: c.description }
    }
    return { id: '', description: String(c) }
  })
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * 旧存档归一化：补 version、归一化 clues、补齐缺省字段。
 * 返回 null 表示完全不可解析（非对象）。
 */
export function migrateSaveSnapshot(data: unknown): SaveSnapshot | null {
  if (!isRecord(data)) return null
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m): m is SaveSnapshot['messages'][number] =>
        isRecord(m) && typeof m.role === 'string' && typeof m.content === 'string',
      )
    : []
  const characterSheet = isRecord(data.characterSheet) ? (data.characterSheet as unknown as COCCharacterSheet) : null
  const rawName = data.name
  return {
    version: SAVE_VERSION,
    name: typeof rawName === 'string' && rawName ? rawName : undefined,
    storyId: nullableStr(data.storyId),
    storyName: str(data.storyName),
    storyOverview: str(data.storyOverview),
    currentScene: str(data.currentScene),
    cluesObtained: normalizeClues(data.cluesObtained),
    messages,
    kpMemory: Array.isArray(data.kpMemory) ? data.kpMemory.map((m) => String(m)) : [],
    longTermSummary: str(data.longTermSummary),
    longTermFacts: Array.isArray(data.longTermFacts) ? data.longTermFacts.map((f) => String(f)) : [],
    playerTurnCount: num(data.playerTurnCount),
    gamePhase: str(data.gamePhase, 'playing'),
    characterSheet,
    playerName: str(data.playerName, '调查员'),
    selectedOccupationId: nullableStr(data.selectedOccupationId),
    selectedOccupationName: str(data.selectedOccupationName),
    sessionId: nullableStr(data.sessionId),
    endingState: data.endingState ?? null,
    scenesVisited: Array.isArray(data.scenesVisited) ? data.scenesVisited.map((s) => String(s)) : [],
  }
}

/** 房间快照 → 单机存档（C3 房间导出）。 */
export function roomSnapshotToSave(room: RoomSnapshotLike): SaveSnapshot {
  const firstChar = isRecord(room.characters) ? (Object.values(room.characters)[0] as COCCharacterSheet | undefined) ?? null : null
  return {
    version: SAVE_VERSION,
    name: `room_${room.storyId ?? 'export'}`,
    storyId: nullableStr(room.storyId),
    storyName: str(room.storyId),
    storyOverview: '',
    currentScene: str(room.scene),
    cluesObtained: Array.isArray(room.clues) ? room.clues.map((c) => ({ id: c.id, description: c.description })) : [],
    messages: Array.isArray(room.messages) ? room.messages : [],
    kpMemory: [],
    longTermSummary: '',
    longTermFacts: [],
    playerTurnCount: Array.isArray(room.messages) ? room.messages.filter((m) => m.role === 'player').length : 0,
    gamePhase: room.phase === 'ended' ? 'ended' : 'playing',
    characterSheet: firstChar,
    playerName: firstChar?.playerName || '调查员',
    selectedOccupationId: firstChar?.occupationId ?? null,
    selectedOccupationName: firstChar?.occupationName || '',
    sessionId: null,
    endingState: room.ending ?? null,
  }
}

/** 单机存档 → 房间快照（C3 导入）。 */
export function saveToRoomSnapshot(save: SaveSnapshot): RoomSnapshotLike {
  const characters: Record<string, unknown> = {}
  if (save.characterSheet) {
    characters.char_import = save.characterSheet
  }
  return {
    seq: 0,
    phase: save.gamePhase === 'ended' ? 'ended' : 'playing',
    storyId: save.storyId,
    messages: save.messages,
    characters,
    clues: save.cluesObtained,
    scene: save.currentScene || null,
    ending: save.endingState ?? null,
  }
}

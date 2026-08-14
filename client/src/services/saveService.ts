import { toRaw } from 'vue'
import type { Message } from '../types/game'
import type { GamePhase, COCCharacterSheet } from '../types/character'
import type { EndingState } from '../types/ending'
import { getBridge } from '../platform'

export const SAVE_VERSION = 1

export interface GameSaveSnapshot {
  version: number
  name: string
  storyId: string | null
  storyName: string
  storyOverview: string
  currentScene: string
  cluesObtained: string[]
  messages: Message[]
  kpMemory: string[]
  longTermSummary: string
  longTermFacts: string[]
  playerTurnCount: number
  gamePhase: GamePhase
  characterSheet: COCCharacterSheet | null
  playerName: string
  selectedOccupationId: string | null
  selectedOccupationName: string
  sessionId: string | null
  endingState?: EndingState | null
  scenesVisited?: string[]
}

export async function writeSaveSnapshot(saveId: string, displayName: string | undefined, snapshot: Omit<GameSaveSnapshot, 'version' | 'name'>): Promise<void> {
  const payload: GameSaveSnapshot = {
    version: SAVE_VERSION,
    name: displayName ?? saveId,
    ...snapshot,
  }
  const serializable = JSON.parse(JSON.stringify({
    ...payload,
    cluesObtained: toRaw(payload.cluesObtained),
    messages: toRaw(payload.messages),
    kpMemory: toRaw(payload.kpMemory),
    longTermFacts: toRaw(payload.longTermFacts),
    characterSheet: payload.characterSheet ? toRaw(payload.characterSheet) : null,
  })) as GameSaveSnapshot
  await getBridge().writeSave(saveId, serializable)
}

export async function readSaveSnapshot(saveId: string): Promise<Record<string, unknown>> {
  const data = await getBridge().readSave(saveId) as Record<string, unknown>
  if (!data || typeof data !== 'object') throw new Error('Invalid save data')
  return data
}

export async function listSaveIds(): Promise<string[]> {
  return await getBridge().listSaves()
}

export async function readSaveMeta(saveId: string): Promise<{ name?: string; storyName?: string } | null> {
  try {
    const data = await getBridge().readSave(saveId) as Record<string, unknown>
    if (!data || typeof data !== 'object') return null
    return {
      name: typeof data.name === 'string' ? data.name : saveId,
      storyName: typeof data.storyName === 'string' ? data.storyName : undefined,
    }
  } catch {
    return null
  }
}

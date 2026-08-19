export type GameOutcome = 'victory' | 'defeat' | 'partial' | 'survival' | 'unknown'

export interface EndingState {
  outcome: GameOutcome
  title: string
  summary: string
  epilogueOptions: string[]
  keyFacts: string[]
  keyTurnIds: string[]
  endedAt: number
  /** For export / review */
  finalSnapshot?: {
    hp?: number
    hpMax?: number
    san?: number
    sanMax?: number
    mp?: number
    mpMax?: number
    luck?: number
    insanityState?: string
    dailySanLoss?: number
  }
  /** Clues obtained at the end: structured { id, description } (legacy strings normalized on load). */
  cluesObtained: { id: string; description: string }[]
  scenesVisited: string[]
  storyId?: string
  storyName?: string
  sessionId?: string
}


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
  cluesObtained: string[]
  scenesVisited: string[]
  storyId?: string
  storyName?: string
  sessionId?: string
}


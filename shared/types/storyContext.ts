/**
 * Structured story context sent to the KP LangGraph (Electron).
 * Used by narrative/sanity plan and generate nodes. Populated from game state.
 * @see docs/COC-KP-GAP-ANALYSIS.md §4.2
 */
export interface StoryContextSanity {
  currentSan?: number
  dailySanLoss?: number
  potentialLoss?: number
  /** If true, this turn should force a SAN check even under narrative intent. */
  autoCheck?: boolean
  /** Optional: brief reason for autoCheck (for tracing / prompt). */
  autoReason?: string
}

export interface StoryContextNPC {
  name?: string
  role?: string
}

export interface StoryContext {
  sceneId?: string
  sceneName?: string
  sceneType?: string
  act?: string
  openClues?: string[]
  activeNPCs?: StoryContextNPC[]
  sanity?: StoryContextSanity
  /** If true, narrative agent should force a scene transition (anti-stall). */
  forceTransitionScene?: boolean
}

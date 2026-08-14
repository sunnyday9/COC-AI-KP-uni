/**
 * Multi-layer tool-calling: types and handler contract.
 * Used by the orchestrator and domain handlers.
 */
import type { Message } from '../types/game'
import type { COCCharacterSheet } from '../types/character'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolHandlerResult {
  content: string
  displayMessages: Message[]
}

// Structured result types for common tools (handler JSON content).

export interface MeleeAttackResult {
  winner: 'A' | 'B' | 'tie'
  winnerName: string | null
  damageDealt: number
  investigatorTookDamage: boolean
}

export interface RangedAttackResult {
  roll: number
  threshold: number
  hit: boolean
  result: string
  damageDealt: number
  targetIsInvestigator: boolean
}

export interface MajorWoundResult {
  instantDeath: boolean
  hasMajorWound: boolean
  isDying: boolean
  unconscious: boolean
}

export interface FirstAidResult {
  healed: number
  stabilized: boolean
}

export interface MedicineResult {
  healed: number
}

export interface SanCheckResult {
  roll: number
  currentSan: number
  passed: boolean
  isFumble: boolean
  sanLost: number
  lossExpression: string
}

export interface InsanityResult {
  insanityState: 'normal' | 'temporary' | 'indefinite' | 'permanent'
  boutRoll?: number
  boutText: string
  phobiaAdded?: string
  maniaAdded?: string
}

/** Resolve skill check result and threshold for a single roll. */
export type ResolveSkillCheckFn = (
  roll: number,
  skillValue: number,
  difficulty: string
) => { threshold: number; result: string }

/** Context passed to every handler: read refs, dice helpers, character updaters, session, UI. */
export interface ToolHandlerContext {
  /** Current character sheet (read-only snapshot). */
  characterSheet: COCCharacterSheet | null
  /** Get display name for skill id. */
  getSkillName: (skillId: string) => string
  /** Roll n-sided die. */
  rollD: (sides: number) => number
  /** Parse dice expression e.g. "1d6", "2d10", return total. */
  parseDiceExpr: (expr: string) => number
  /** Roll d100 with bonus/penalty dice (0-2 each). */
  rollD100WithModifiers: (bonusDice: number, penaltyDice: number) => number
  /** Roll COC damage bonus e.g. "+1D4", "-1". */
  rollDamageBonus: (db: string) => number
  /** Resolve d100 roll to success level and threshold. */
  resolveSkillCheck: ResolveSkillCheckFn
  /** Success level rank for opposed comparison (higher = better). */
  SUCCESS_LEVEL_RANK: Record<string, number>
  /** Human-readable labels for success levels. */
  SKILL_CHECK_RESULT_TEXT: Record<string, string>
  /** Character updaters. */
  updateCharacterHP: (delta: number) => void
  updateCharacterMP: (delta: number) => void
  updateCharacterSAN: (delta: number) => void
  updateCharacterLuck: (delta: number) => void
  addCharacterDailySanLoss: (amount: number) => void
  resetCharacterDailySanLoss: () => void
  updateCharacterInsanityState: (
    state: 'normal' | 'temporary' | 'indefinite' | 'permanent',
    phobias?: string[],
    manias?: string[]
  ) => void
  setCharacterMajorWound: (hasMajorWound: boolean) => void
  setCharacterDying: (isDying: boolean) => void
  /** Session / world. */
  transitionToScene: (sceneName: string) => void
  addClue: (description: string) => void
  /** End game and enter ending UI. */
  endGame: (ending: {
    outcome: string
    title: string
    summary: string
    epilogueOptions?: string[]
    keyFacts?: string[]
    keyTurnIds?: string[]
  }) => void
  /** UI: generate unique id for messages. */
  generateId: () => string
}

export interface ToolHandler {
  toolNames: string[]
  handle(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolHandlerContext
  ): ToolHandlerResult
}

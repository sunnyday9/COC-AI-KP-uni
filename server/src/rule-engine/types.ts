/**
 * Multi-layer tool-calling: types and handler contract.
 * 迁自 client/src/toolCalling/types.ts（Phase A1 规则引擎下沉）。
 * 服务端规则引擎（server/src/rule-engine）与客户端视图层共用此契约；
 * 类型来源统一为 shared 包（Message / COCCharacterSheet）。
 */
import type { Message } from '../../../shared/types/game.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'

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
  /** Which symptom table was used: immediate (表Ⅶ, 1D10 轮) vs summary (表Ⅷ, 1D10 小时). */
  boutStyle?: 'immediate' | 'summary'
  /** The resolved symptom from the table (name + description). */
  symptom?: { name: string; description: string }
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
  /** 幕间成长：技能值可超过 100%（规则书 5739-5742）。 */
  growCharacterSkill: (skillId: string, newValue: number) => void
  /** 克苏鲁神话技能增长（书籍/遭遇），触发最大理智下调。 */
  increaseCthulhuMythos: (gain: number) => void
  /** Session / world. */
  transitionToScene: (sceneName: string) => void
  addClue: (description: string, clueId?: string) => void
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

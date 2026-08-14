import type { ToolHandlerContext } from '../toolCalling'
import type { COCCharacterSheet } from '../types/character'
import { rollD } from './diceService'
import { getSkillName } from '../data/coc7'
import {
  resolveSkillCheck as resolveSkillCheckRule,
  SUCCESS_LEVEL_RANK as SUCCESS_LEVEL_RANK_RULE,
  SKILL_CHECK_RESULT_TEXT as SKILL_CHECK_RESULT_TEXT_RULE,
} from '../logic/coc7Rules'

export interface ToolContextDeps {
  characterSheet: COCCharacterSheet | null
  updateCharacterHP(delta: number): void
  updateCharacterMP(delta: number): void
  updateCharacterSAN(delta: number): void
  updateCharacterLuck(delta: number): void
  addCharacterDailySanLoss(amount: number): void
  resetCharacterDailySanLoss(): void
  updateCharacterInsanityState(
    state: 'normal' | 'temporary' | 'indefinite' | 'permanent',
    phobias?: string[],
    manias?: string[],
  ): void
  setCharacterMajorWound(hasMajorWound: boolean): void
  setCharacterDying(isDying: boolean): void
  transitionToScene(sceneName: string): void
  addClue(description: string): void
  endGame(ending: { outcome: string; title: string; summary: string; epilogueOptions?: string[]; keyFacts?: string[]; keyTurnIds?: string[] }): void
  generateId(): string
}

function parseDiceExpr(expr: string): number {
  const s = String(expr).trim().toLowerCase()
  const match = s.match(/^(\d+)?d(\d+)$/)
  if (match) {
    const count = Math.max(1, Math.min(10, parseInt(match[1] || '1', 10)))
    const sides = Math.max(1, Math.min(100, parseInt(match[2]!, 10)))
    let total = 0
    for (let i = 0; i < count; i++) total += rollD(sides)
    return total
  }
  return Math.max(0, Math.floor(Number(s)) || 0)
}

function rollDamageBonus(db: string): number {
  const s = String(db ?? '0').trim().toUpperCase()
  if (s === '' || s === '0') return 0
  const neg = s.match(/^-(\d+)$/)
  if (neg) return -Math.min(2, parseInt(neg[1]!, 10))
  const plus = s.match(/^\+(\d+)?D(\d+)$/)
  if (plus) return parseDiceExpr((plus[1] || '1') + 'd' + plus[2])
  return 0
}

function rollD100WithModifiers(bonusDice: number, penaltyDice: number): number {
  const base = rollD(100)
  const net = Math.max(-2, Math.min(2, (bonusDice || 0) - (penaltyDice || 0)))
  if (net === 0) return base
  const tens = base === 100 ? 0 : Math.floor(base / 10)
  const ones = base === 100 ? 0 : base % 10
  if (net > 0) {
    let bestTens = tens
    for (let i = 0; i < net; i++) {
      const r = rollD(10)
      const t = r === 10 ? 0 : r
      if (t < bestTens) bestTens = t
    }
    return bestTens === 0 && ones === 0 ? 100 : bestTens * 10 + ones
  } else {
    let worstTens = tens
    for (let i = 0; i < -net; i++) {
      const r = rollD(10)
      const t = r === 10 ? 0 : r
      if (t > worstTens) worstTens = t
    }
    return worstTens === 0 && ones === 0 ? 100 : worstTens * 10 + ones
  }
}

export function buildToolContext(deps: ToolContextDeps): ToolHandlerContext {
  const resolveSkillCheck = resolveSkillCheckRule
  const SUCCESS_LEVEL_RANK = SUCCESS_LEVEL_RANK_RULE
  const SKILL_CHECK_RESULT_TEXT = SKILL_CHECK_RESULT_TEXT_RULE

  return {
    characterSheet: deps.characterSheet,
    getSkillName,
    rollD,
    parseDiceExpr,
    rollD100WithModifiers,
    rollDamageBonus,
    resolveSkillCheck,
    SUCCESS_LEVEL_RANK,
    SKILL_CHECK_RESULT_TEXT,
    updateCharacterHP: deps.updateCharacterHP,
    updateCharacterMP: deps.updateCharacterMP,
    updateCharacterSAN: deps.updateCharacterSAN,
    updateCharacterLuck: deps.updateCharacterLuck,
    addCharacterDailySanLoss: deps.addCharacterDailySanLoss,
    resetCharacterDailySanLoss: deps.resetCharacterDailySanLoss,
    updateCharacterInsanityState: deps.updateCharacterInsanityState,
    setCharacterMajorWound: deps.setCharacterMajorWound,
    setCharacterDying: deps.setCharacterDying,
    transitionToScene: deps.transitionToScene,
    addClue: deps.addClue,
    endGame: deps.endGame,
    generateId: deps.generateId,
  }
}

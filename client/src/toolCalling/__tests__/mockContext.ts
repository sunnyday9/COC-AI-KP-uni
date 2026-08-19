/**
 * 最小 ToolHandlerContext mock，用于 handler 单元测试。
 */
import type { ToolHandlerContext } from '../types'
import type { COCCharacterSheet } from '../../types/character'
import { resolveSkillCheck, SUCCESS_LEVEL_RANK, SKILL_CHECK_RESULT_TEXT } from '../../logic/coc7Rules'

let idCounter = 0
function generateId() {
  return 'test_id_' + ++idCounter
}

function parseDiceExpr(expr: string): number {
  const s = String(expr).trim().toLowerCase()
  const match = s.match(/^(\d+)?d(\d+)$/)
  if (match) {
    const count = parseInt(match[1] || '1', 10)
    const sides = parseInt(match[2]!, 10)
    return count * Math.ceil(sides / 2)
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

export interface MockContextOptions {
  /** 依次返回的 rollD 值（用于确定性测试） */
  rollSequence?: number[]
  characterSheet?: COCCharacterSheet | null
  /** 是否追踪 updateCharacterHP 等调用 */
  onUpdateHP?: (delta: number) => void
  onUpdateSAN?: (delta: number) => void
  onUpdateMP?: (delta: number) => void
  onUpdateLuck?: (delta: number) => void
  onAddDailySanLoss?: (amount: number) => void
  onResetDailySanLoss?: () => void
  onInsanityState?: (state: 'normal' | 'temporary' | 'indefinite' | 'permanent', phobias?: string[], manias?: string[]) => void
  onSetMajorWound?: (v: boolean) => void
  onSetDying?: (v: boolean) => void
  onGrowCharacterSkill?: (skillId: string, newValue: number) => void
  onIncreaseCthulhuMythos?: (gain: number) => void
  onTransitionScene?: (name: string) => void
  onAddClue?: (desc: string) => void
  onEndGame?: (ending: {
    outcome: string
    title: string
    summary: string
    epilogueOptions?: string[]
    keyFacts?: string[]
    keyTurnIds?: string[]
  }) => void
}

export function createMockContext(options: MockContextOptions = {}): ToolHandlerContext {
  const rollSequence = options.rollSequence ?? [50]
  let rollIndex = 0
  const rollD = (sides: number) => {
    const v = rollSequence[rollIndex % rollSequence.length]
    rollIndex++
    return typeof v === 'number' ? Math.max(1, Math.min(sides, v)) : Math.floor(Math.random() * sides) + 1
  }
  const rollD100WithModifiers = (_bonus: number, _penalty: number) => rollD(100)

  return {
    characterSheet: options.characterSheet ?? null,
    getSkillName: (id: string) => id,
    rollD,
    parseDiceExpr,
    rollD100WithModifiers,
    rollDamageBonus,
    resolveSkillCheck,
    SUCCESS_LEVEL_RANK,
    SKILL_CHECK_RESULT_TEXT,
    updateCharacterHP: (delta) => options.onUpdateHP?.(delta),
    updateCharacterMP: (delta) => options.onUpdateMP?.(delta),
    updateCharacterSAN: (delta) => options.onUpdateSAN?.(delta),
    updateCharacterLuck: (delta) => options.onUpdateLuck?.(delta),
    addCharacterDailySanLoss: (amount) => options.onAddDailySanLoss?.(amount),
    resetCharacterDailySanLoss: () => options.onResetDailySanLoss?.(),
    updateCharacterInsanityState: (state, phobias?, manias?) =>
      options.onInsanityState?.(state, phobias, manias),
    setCharacterMajorWound: (v) => options.onSetMajorWound?.(v),
    setCharacterDying: (v) => options.onSetDying?.(v),
    growCharacterSkill: (id, v) => options.onGrowCharacterSkill?.(id, v),
    increaseCthulhuMythos: (gain) => options.onIncreaseCthulhuMythos?.(gain),
    transitionToScene: (name) => options.onTransitionScene?.(name),
    addClue: (desc) => options.onAddClue?.(desc),
    endGame: (ending) => options.onEndGame?.(ending),
    generateId,
  }
}

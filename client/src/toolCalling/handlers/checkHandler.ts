import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from '../types'

const TOOL_NAMES = ['skill_check', 'opposed_check', 'roll_dice'] as const

function handleSkillCheck(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const skillName = String(args.skillName ?? '未知')
  const skillValue = Math.max(0, Math.min(99, Math.floor(Number(args.skillValue ?? 50))))
  const difficulty = String(args.difficulty ?? 'regular')
  const bonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.bonusDice ?? 0))))
  const penaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.penaltyDice ?? 0))))
  const isPush = !!args.isPush
  const roll =
    bonusDice || penaltyDice
      ? ctx.rollD100WithModifiers(bonusDice, penaltyDice)
      : ctx.rollD(100)
  const { threshold, result: checkResult } = ctx.resolveSkillCheck(roll, skillValue, difficulty)
  const isSuccess = ['critical_success', 'extreme_success', 'hard_success', 'regular_success'].includes(checkResult)
  const content = JSON.stringify({
    roll,
    threshold,
    skillName,
    skillValue,
    difficulty,
    result: checkResult,
    success: isSuccess,
    isPush,
  })
  const diffLabel = difficulty === 'extreme' ? '极难' : difficulty === 'hard' ? '困难' : '常规'
  const modLabel =
    bonusDice || penaltyDice
      ? ` (${bonusDice ? `+${bonusDice}奖励骰` : ''}${penaltyDice ? `${bonusDice ? '/' : ''}${penaltyDice}惩罚骰` : ''})`
      : ''
  const pushLabel = isPush ? ' [孤注一掷]' : ''
  const displayMessages = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system' as const,
      type: 'dice' as const,
      content: `${skillName}检定(${diffLabel})${modLabel}${pushLabel} d100: ${roll} / 目标≤${threshold} → ${ctx.SKILL_CHECK_RESULT_TEXT[checkResult] ?? checkResult}`,
      result: { roll, target: threshold },
    },
  ]
  return { content, displayMessages }
}

function handleOpposedCheck(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const sideAName = String(args.sideAName ?? 'A')
  const sideAValue = Math.max(0, Math.min(99, Math.floor(Number(args.sideAValue ?? 50))))
  const sideBName = String(args.sideBName ?? 'B')
  const sideBValue = Math.max(0, Math.min(99, Math.floor(Number(args.sideBValue ?? 50))))
  const tieBreaker = String(args.tieBreaker ?? 'attacker') as 'attacker' | 'defender'
  const sideABonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideABonusDice ?? 0))))
  const sideAPenaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideAPenaltyDice ?? 0))))
  const sideBBonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideBBonusDice ?? 0))))
  const sideBPenaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideBPenaltyDice ?? 0))))
  const rollA =
    sideABonusDice || sideAPenaltyDice
      ? ctx.rollD100WithModifiers(sideABonusDice, sideAPenaltyDice)
      : ctx.rollD(100)
  const rollB =
    sideBBonusDice || sideBPenaltyDice
      ? ctx.rollD100WithModifiers(sideBBonusDice, sideBPenaltyDice)
      : ctx.rollD(100)
  const resA = ctx.resolveSkillCheck(rollA, sideAValue, 'regular')
  const resB = ctx.resolveSkillCheck(rollB, sideBValue, 'regular')
  const rankA = ctx.SUCCESS_LEVEL_RANK[resA.result] ?? 0
  const rankB = ctx.SUCCESS_LEVEL_RANK[resB.result] ?? 0
  let winner: 'A' | 'B' | 'tie' = 'tie'
  if (rankA !== rankB) winner = rankA > rankB ? 'A' : 'B'
  else if (sideAValue !== sideBValue) winner = sideAValue > sideBValue ? 'A' : 'B'
  else winner = tieBreaker === 'attacker' ? 'A' : 'B'
  const content = JSON.stringify({
    rollA,
    rollB,
    resultA: resA.result,
    resultB: resB.result,
    sideAName,
    sideAValue,
    sideBName,
    sideBValue,
    winner,
  })
  const modLabelA =
    sideABonusDice || sideAPenaltyDice
      ? ` (${sideABonusDice ? `+${sideABonusDice}奖` : ''}${sideAPenaltyDice ? `${sideABonusDice ? '/' : ''}${sideAPenaltyDice}惩` : ''})`
      : ''
  const modLabelB =
    sideBBonusDice || sideBPenaltyDice
      ? ` (${sideBBonusDice ? `+${sideBBonusDice}奖` : ''}${sideBPenaltyDice ? `${sideBBonusDice ? '/' : ''}${sideBPenaltyDice}惩` : ''})`
      : ''
  const displayMessages = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system' as const,
      type: 'dice' as const,
      content: `对抗检定 ${sideAName}(d100:${rollA}→${ctx.SKILL_CHECK_RESULT_TEXT[resA.result]})${modLabelA} vs ${sideBName}(d100:${rollB}→${ctx.SKILL_CHECK_RESULT_TEXT[resB.result]})${modLabelB} → ${winner === 'A' ? sideAName : winner === 'B' ? sideBName : '平局'}胜`,
      result: { roll: rollA, target: sideAValue },
    },
  ]
  return { content, displayMessages }
}

function handleRollDice(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const sides = Math.max(2, Math.min(1000, Math.floor(Number(args.sides ?? 100)) || 100))
  const roll = ctx.rollD(sides)
  const content = JSON.stringify({ roll, sides })
  const displayMessages = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system' as const,
      type: 'dice' as const,
      content: `投骰 d${sides}: ${roll}`,
      result: { roll, target: sides },
    },
  ]
  return { content, displayMessages }
}

export const checkHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    if (toolName === 'skill_check') return handleSkillCheck(args, context)
    if (toolName === 'opposed_check') return handleOpposedCheck(args, context)
    if (toolName === 'roll_dice') return handleRollDice(args, context)
    return { content: 'error: unknown tool', displayMessages: [] }
  },
}

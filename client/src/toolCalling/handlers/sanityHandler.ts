import type {
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerResult,
  SanCheckResult,
  InsanityResult,
} from '../types'
import { PHOBIA_TABLE, MANIA_TABLE, rollImmediateSymptom, rollSummarySymptom } from '../../data/insanityTables'

const TOOL_NAMES = ['san_check', 'trigger_insanity', 'adjust_san', 'reset_day'] as const

function handleSanCheck(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const currentSan = Math.max(0, Math.min(99, Math.floor(Number(args.currentSan ?? 50))))
  const successLossExpr = String(args.successLoss ?? '0')
  const failureLossExpr = String(args.failureLoss ?? '1d6')
  const roll = ctx.rollD(100)
  const passed = roll <= currentSan
  // Rulebook 5445-5448: a fumble is 96-100 when the target is below 50,
  // otherwise only 100 (matches coc7Rules fumble thresholds).
  const isFumble = currentSan < 50 ? roll >= 96 : roll === 100
  const lossExpr = passed ? successLossExpr : failureLossExpr
  let sanLost = isFumble ? 0 : ctx.parseDiceExpr(lossExpr)
  if (isFumble) {
    const m = failureLossExpr.match(/^(\d+)?d(\d+)$/)
    sanLost = m ? parseInt(m[1] || '1', 10) * parseInt(m[2]!, 10) : ctx.parseDiceExpr(failureLossExpr)
  }
  ctx.updateCharacterSAN(-sanLost)
  if (sanLost > 0) ctx.addCharacterDailySanLoss(sanLost)
  const payload: SanCheckResult = {
    roll,
    currentSan,
    passed,
    isFumble,
    sanLost,
    lossExpression: lossExpr,
  }
  const statusText = isFumble ? '大失败' : passed ? '成功' : '失败'
  const displayMessages: ToolHandlerResult['displayMessages'] = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      type: 'dice',
      content: `SAN检定 d100: ${roll} / 目标≤${currentSan} → ${statusText}`,
      result: { roll, target: currentSan },
    },
  ]
  
  if (isFumble && /[dD]/.test(failureLossExpr)) {
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      type: 'dice',
      content: `大失败惩罚 (最大化 ${failureLossExpr}): ${sanLost}`,
      result: { roll: sanLost },
    })
  } else if (!isFumble && /[dD]/.test(lossExpr)) {
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      type: 'dice',
      content: `SAN损失检定 ${lossExpr}: ${sanLost}`,
      result: { roll: sanLost },
    })
  } else if (sanLost > 0 && !/[dD]/.test(lossExpr)) {
    // For flat numbers, we can just optionally show a text message, but SAN -x handles it
  }

  if (sanLost > 0) {
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `SAN -${sanLost}`,
    })
  }
  return { content: JSON.stringify(payload), displayMessages }
}

function handleTriggerInsanity(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const sanLost = Math.max(0, Math.floor(Number(args.sanLost ?? 0)))
  const intValue = Math.max(0, Math.min(99, Math.floor(Number(args.intValue ?? 50))))
  // boutStyle: 'immediate' (有他人在场/现场, 表Ⅶ) vs 'summary' (独处/事后, 表Ⅷ).
  // Omitted → summary (规则书默认: 发作结束后的总结症状).
  const boutStyle = args.boutStyle === 'immediate' ? 'immediate' : 'summary'
  const c = ctx.characterSheet
  const sanAfter = c?.derived?.san ?? 0
  const currentSanBefore = sanAfter + sanLost
  const dailySanLoss = c?.dailySanLoss ?? 0
  let state: 'normal' | 'temporary' | 'indefinite' | 'permanent' = 'normal'
  let boutRoll: number | null = null
  let boutText = ''
  let symptom: { name: string; description: string } | null = null
  let phobiaAdded: string | null = null
  let maniaAdded: string | null = null

  const resolveBout = (): void => {
    const roll = ctx.rollD(10)
    boutRoll = roll
    const table = boutStyle === 'immediate' ? rollImmediateSymptom(roll) : rollSummarySymptom(roll)
    symptom = table
    if (roll === 9) {
      phobiaAdded = PHOBIA_TABLE[(ctx.rollD(100) - 1) % PHOBIA_TABLE.length] ?? '随机恐惧症'
      boutText = `${table.name}：${table.description}（获得恐惧症：${phobiaAdded}）`
    } else if (roll === 10) {
      maniaAdded = MANIA_TABLE[(ctx.rollD(100) - 1) % MANIA_TABLE.length] ?? '随机躁狂症'
      boutText = `${table.name}：${table.description}（获得躁狂症：${maniaAdded}）`
    } else {
      boutText = `${table.name}：${table.description}（持续 ${boutStyle === 'immediate' ? '1D10 轮' : '1D10 小时'}）`
    }
  }

  if (sanAfter <= 0 && sanLost > 0) {
    state = 'permanent'
    boutText = '永久疯狂'
  } else {
    const oneFifth = Math.floor(currentSanBefore / 5)
    if (dailySanLoss >= oneFifth && oneFifth > 0) {
      state = 'indefinite'
      resolveBout()
    }
    if (state === 'normal' && sanLost >= 5) {
      const intRoll = ctx.rollD(100)
      const intSuccess = intRoll <= intValue
      if (intSuccess) {
        state = 'temporary'
        resolveBout()
      } else {
        boutText = '压抑（INT检定失败，未陷入临时疯狂）'
      }
    }
  }
  const phobias = [...(c?.phobias ?? [])]
  const manias = [...(c?.manias ?? [])]
  if (phobiaAdded && !phobias.includes(phobiaAdded)) phobias.push(phobiaAdded)
  if (maniaAdded && !manias.includes(maniaAdded)) manias.push(maniaAdded)
  ctx.updateCharacterInsanityState(state, phobias, manias)
  const payload: InsanityResult = {
    insanityState: state,
    boutRoll: boutRoll ?? undefined,
    boutText,
    phobiaAdded: phobiaAdded ?? undefined,
    maniaAdded: maniaAdded ?? undefined,
    boutStyle,
    symptom: symptom ?? undefined,
  }
  const displayMessages: ToolHandlerResult['displayMessages'] = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `疯狂判定: ${state}${boutText ? ` — ${boutText}` : ''}`,
    },
  ]
  return { content: JSON.stringify(payload), displayMessages }
}

export const sanityHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    if (toolName === 'san_check') return handleSanCheck(args, context)
    if (toolName === 'trigger_insanity') return handleTriggerInsanity(args, context)

    const displayMessages: ToolHandlerResult['displayMessages'] = []
    const id = context.generateId()
    const ts = Date.now()

    if (toolName === 'adjust_san') {
      const delta = Number(args.delta ?? 0)
      context.updateCharacterSAN(delta)
      if (delta < 0) {
        context.addCharacterDailySanLoss(-delta)
      } else if (delta > 0) {
        const c: any = context.characterSheet
        const derived = c?.derived
        if (derived) {
          const mythos = typeof c?.cthulhuMythos === 'number' ? c.cthulhuMythos : 0
          const baseMax = typeof derived.sanMax === 'number' ? derived.sanMax : 99
          const maxByMythos = mythos >= 0 && mythos <= 99 ? 99 - mythos : baseMax
          const currentSan = derived.san
          if (typeof currentSan === 'number' && currentSan > maxByMythos) {
            const clampDelta = maxByMythos - currentSan
            if (clampDelta < 0) context.updateCharacterSAN(clampDelta)
          }
        }
      }
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: delta >= 0 ? `SAN +${delta}` : `SAN ${delta}`,
      })
      return { content: `SAN adjusted by ${delta}`, displayMessages }
    }

    if (toolName === 'reset_day') {
      context.resetCharacterDailySanLoss()
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: '新的一天开始，当日 SAN 损失已重置',
      })
      return { content: 'Daily SAN loss reset to 0 (new day).', displayMessages }
    }

    return { content: 'error: unknown tool', displayMessages: [] }
  },
}

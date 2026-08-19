import type {
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerResult,
  MeleeAttackResult,
  RangedAttackResult,
  MajorWoundResult,
  FirstAidResult,
  MedicineResult,
} from '../types'

const TOOL_NAMES = ['melee_attack', 'ranged_attack', 'adjust_hp', 'apply_major_wound', 'first_aid', 'medicine'] as const

/** Max possible total of a dice expression like "2d6" → 12 (impaling damage). */
function maxDiceTotal(expr: string): number {
  const s = String(expr).trim().toLowerCase()
  const match = s.match(/^(\d+)?d(\d+)$/)
  if (match) {
    const count = Math.max(1, Math.min(10, parseInt(match[1] || '1', 10)))
    const sides = Math.max(1, Math.min(100, parseInt(match[2]!, 10)))
    return count * sides
  }
  return Math.max(0, Math.floor(Number(s)) || 0)
}

/** Max value of a damage bonus string: "+1D4" → 4, "-2" → -2, "0" → 0. */
function maxDamageBonus(db: string): number {
  const s = String(db ?? '0').trim().toUpperCase()
  if (s === '' || s === '0') return 0
  const neg = s.match(/^-(\d+)$/)
  if (neg) return -Math.min(2, parseInt(neg[1]!, 10))
  const plus = s.match(/^\+(\d+)?D(\d+)$/)
  if (plus) return parseInt(plus[2]!, 10) * Math.max(1, parseInt(plus[1] || '1', 10))
  return 0
}

function handleMeleeAttack(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const sideAName = String(args.sideAName ?? 'A')
  const sideAValue = Math.max(0, Math.min(99, Math.floor(Number(args.sideAValue ?? 50))))
  const sideBName = String(args.sideBName ?? 'B')
  const sideBValue = Math.max(0, Math.min(99, Math.floor(Number(args.sideBValue ?? 50))))
  const tieBreaker = String(args.tieBreaker ?? 'attacker') as 'attacker' | 'defender'
  const sideABonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideABonusDice ?? 0))))
  const sideAPenaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideAPenaltyDice ?? 0))))
  const sideBBonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideBBonusDice ?? 0))))
  const sideBPenaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.sideBPenaltyDice ?? 0))))
  const damageExpr = String(args.damageExpr ?? '1d6')
  const attackerDamageBonus = String(args.attackerDamageBonus ?? '0')
  const defenderDamageBonus = String(args.defenderDamageBonus ?? '0')
  const attackerArmor = Math.max(0, Math.floor(Number(args.attackerArmor ?? 0)))
  const defenderArmor = Math.max(0, Math.floor(Number(args.defenderArmor ?? 0)))
  const investigatorSide = String(args.investigatorSide ?? 'none') as 'A' | 'B' | 'none'

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
  // Rulebook 6238-6241 / 6255-6256: when BOTH sides fail (failure/fumble,
  // i.e. neither succeeded), no one is hurt.
  const bothFailed = rankA <= 2 && rankB <= 2
  if (!bothFailed) {
    if (rankA !== rankB) winner = rankA > rankB ? 'A' : 'B'
    else if (sideAValue !== sideBValue) winner = sideAValue > sideBValue ? 'A' : 'B'
    else winner = tieBreaker === 'attacker' ? 'A' : 'B'
  }

  let damageDealt = 0
  // Impaling / extreme-success damage (rulebook 6263-6285): on an extreme
  // success (or better) the damage dice AND damage bonus are maxed; impaling
  // weapons additionally roll one extra weapon-damage die. Normal hits roll
  // the dice as usual. The rule applies to the winner's attack.
  const isImpaling = !!args.isImpaling
  const extremeHit = (winner === 'A' && resA.result === 'extreme_success') || (winner === 'B' && resB.result === 'extreme_success')
  const criticalHit = (winner === 'A' && resA.result === 'critical_success') || (winner === 'B' && resB.result === 'critical_success')
  const maxed = extremeHit || criticalHit
  if (winner === 'A') {
    const bonus = ctx.rollDamageBonus(attackerDamageBonus)
    const base = maxed ? maxDiceTotal(damageExpr) + (isImpaling ? ctx.parseDiceExpr(damageExpr) : 0) : ctx.parseDiceExpr(damageExpr)
    damageDealt = Math.max(0, base + (maxed ? maxDamageBonus(attackerDamageBonus) : bonus) - defenderArmor)
  } else if (winner === 'B') {
    const bonus = ctx.rollDamageBonus(defenderDamageBonus)
    const base = maxed ? maxDiceTotal(damageExpr) + (isImpaling ? ctx.parseDiceExpr(damageExpr) : 0) : ctx.parseDiceExpr(damageExpr)
    damageDealt = Math.max(0, base + (maxed ? maxDamageBonus(defenderDamageBonus) : bonus) - attackerArmor)
  }

  const investigatorIsLoser =
    (winner === 'A' && investigatorSide === 'B') || (winner === 'B' && investigatorSide === 'A')
  const displayMessages: ToolHandlerResult['displayMessages'] = []

  if (investigatorIsLoser && damageDealt > 0) {
    ctx.updateCharacterHP(-damageDealt)
    const c = ctx.characterSheet
    const hpMax = c?.derived?.hpMax ?? 1
    const hpAfter = c?.derived?.hp ?? 0
    const instantDeath = damageDealt > hpMax
    if (instantDeath) {
      ctx.setCharacterMajorWound(true)
      ctx.setCharacterDying(true)
    } else {
      const halfHp = hpMax / 2
      const isMajor = damageDealt >= halfHp
      if (isMajor) {
        ctx.setCharacterMajorWound(true)
        const con = c?.attributes?.con ?? 50
        const conRoll = ctx.rollD(100)
        if (conRoll > con) {
          displayMessages.push({
            id: ctx.generateId(),
            timestamp: Date.now(),
            role: 'system',
            content: '重伤 CON 检定失败，调查员昏迷',
          })
        }
      }
      if (hpAfter <= 0 && isMajor) ctx.setCharacterDying(true)
    }
  }

  const payload: MeleeAttackResult = {
    winner,
    winnerName: winner === 'A' ? sideAName : winner === 'B' ? sideBName : null,
    damageDealt,
    investigatorTookDamage: investigatorIsLoser && damageDealt > 0,
  }
  const winnerName = winner === 'A' ? sideAName : winner === 'B' ? sideBName : '平局'
  displayMessages.push({
    id: ctx.generateId(),
    timestamp: Date.now(),
    role: 'system',
    type: 'dice',
    content: `近战: ${sideAName} vs ${sideBName} → ${winnerName}胜${damageDealt > 0 ? `，造成 ${damageDealt} 点伤害` : ''}`,
    result: { roll: rollA, target: sideAValue },
  })
  return { content: JSON.stringify(payload), displayMessages }
}

function handleRangedAttack(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const skillName = String(args.skillName ?? '射击')
  const skillValue = Math.max(0, Math.min(99, Math.floor(Number(args.skillValue ?? 50))))
  const difficulty = String(args.difficulty ?? 'regular')
  const damageExpr = String(args.damageExpr ?? '1d6')
  const targetArmor = Math.max(0, Math.floor(Number(args.targetArmor ?? 0)))
  const targetIsInvestigator = !!args.targetIsInvestigator
  const bonusDice = Math.max(0, Math.min(2, Math.floor(Number(args.bonusDice ?? 0))))
  const penaltyDice = Math.max(0, Math.min(2, Math.floor(Number(args.penaltyDice ?? 0))))
  const damageBonus = String(args.damageBonus ?? '0')
  const isImpaling = !!args.isImpaling

  const roll = bonusDice || penaltyDice ? ctx.rollD100WithModifiers(bonusDice, penaltyDice) : ctx.rollD(100)
  const { threshold, result: checkResult } = ctx.resolveSkillCheck(roll, skillValue, difficulty)
  const hit = ['critical_success', 'extreme_success', 'hard_success', 'regular_success'].includes(checkResult)
  const maxed = checkResult === 'extreme_success' || checkResult === 'critical_success'
  let damageDealt = 0
  if (hit) {
    // Impaling damage (rulebook 6263-6285 / 6700-6702): extreme success maxes
    // damage (and any damage bonus) plus one extra weapon-damage roll.
    const base = maxed ? maxDiceTotal(damageExpr) + (isImpaling ? ctx.parseDiceExpr(damageExpr) : 0) : ctx.parseDiceExpr(damageExpr)
    const bonus = ctx.rollDamageBonus(damageBonus)
    damageDealt = Math.max(0, base + (maxed ? maxDamageBonus(damageBonus) : bonus) - targetArmor)
  }

  const displayMessages: ToolHandlerResult['displayMessages'] = []
  if (targetIsInvestigator && damageDealt > 0) {
    ctx.updateCharacterHP(-damageDealt)
    const c = ctx.characterSheet
    const hpMax = c?.derived?.hpMax ?? 1
    const hpAfter = c?.derived?.hp ?? 0
    const instantDeath = damageDealt > hpMax
    if (instantDeath) {
      ctx.setCharacterMajorWound(true)
      ctx.setCharacterDying(true)
    } else {
      const halfHp = hpMax / 2
      const isMajor = damageDealt >= halfHp
      if (isMajor) {
        ctx.setCharacterMajorWound(true)
        const con = c?.attributes?.con ?? 50
        const conRoll = ctx.rollD(100)
        if (conRoll > con) {
          displayMessages.push({
            id: ctx.generateId(),
            timestamp: Date.now(),
            role: 'system',
            content: '重伤 CON 检定失败，调查员昏迷',
          })
        }
      }
      if (hpAfter <= 0 && isMajor) ctx.setCharacterDying(true)
    }
  }

  const payload: RangedAttackResult = {
    roll,
    threshold,
    hit,
    result: checkResult,
    damageDealt,
    targetIsInvestigator: targetIsInvestigator && damageDealt > 0,
  }
  const hitText = hit ? '命中' : '未中'
  displayMessages.push({
    id: ctx.generateId(),
    timestamp: Date.now(),
    role: 'system',
    type: 'dice',
    content: `远程: ${skillName}检定 d100:${roll} → ${hitText}${damageDealt > 0 ? `，造成 ${damageDealt} 点伤害` : ''}`,
    result: { roll, target: threshold },
  })
  return { content: JSON.stringify(payload), displayMessages }
}

export const combatHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    const displayMessages: ToolHandlerResult['displayMessages'] = []
    const id = context.generateId()
    const ts = Date.now()

    if (toolName === 'melee_attack') return handleMeleeAttack(args, context)
    if (toolName === 'ranged_attack') return handleRangedAttack(args, context)

    if (toolName === 'adjust_hp') {
      const delta = Number(args.delta ?? 0)
      context.updateCharacterHP(delta)
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: delta >= 0 ? `HP +${delta}` : `HP ${delta}`,
      })
      return { content: `HP adjusted by ${delta}`, displayMessages }
    }

    if (toolName === 'apply_major_wound') {
      const hpMax = Math.max(1, Math.floor(Number(args.hpMax ?? 1)))
      const damageDealt = Math.max(0, Math.floor(Number(args.damageDealt ?? 0)))
      const hpAfter = Math.max(0, Math.floor(Number(args.hpAfter ?? 0)))
      const c = context.characterSheet
      const instantDeath = damageDealt > hpMax
      if (instantDeath) {
        context.setCharacterMajorWound(true)
        context.setCharacterDying(true)
      }
      const halfHp = hpMax / 2
      const isMajor = !instantDeath && damageDealt >= halfHp
      let unconscious = false
      if (isMajor) {
        context.setCharacterMajorWound(true)
        const con = c?.attributes?.con ?? 50
        const conRoll = context.rollD(100)
        unconscious = conRoll > con
      }
      if (hpAfter <= 0 && (isMajor || instantDeath)) context.setCharacterDying(true)
      const payload: MajorWoundResult = {
        instantDeath,
        hasMajorWound: isMajor || instantDeath,
        isDying: hpAfter <= 0 && (isMajor || instantDeath),
        unconscious,
      }
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: instantDeath
          ? '即死（单次伤害超过 HP 最大值）'
          : `重伤判定: ${isMajor ? '重伤' : '未达重伤'}${hpAfter <= 0 && isMajor ? '，濒死' : ''}${unconscious ? '，CON检定失败昏迷' : ''}`,
      })
      return { content: JSON.stringify(payload), displayMessages }
    }

    if (toolName === 'first_aid') return handleFirstAid(args, context)
    if (toolName === 'medicine') return handleMedicine(args, context)

    return { content: 'error: unknown tool', displayMessages: [] }
  },
}

function handleFirstAid(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const c = ctx.characterSheet
  const displayMessages: ToolHandlerResult['displayMessages'] = []
  const id = ctx.generateId()
  const ts = Date.now()

  if (!c || !c.derived) {
    const content: FirstAidResult = { healed: 0, stabilized: false }
    return { content: JSON.stringify(content), displayMessages }
  }

  const hp = c.derived.hp
  const hpMax = c.derived.hpMax
  const isDying = !!c.isDying

  const success = args.success !== false

  if (hp >= hpMax) {
    displayMessages.push({
      id,
      timestamp: ts,
      role: 'system',
      content: 'HP 已满，无需急救',
    })
    const content: FirstAidResult = { healed: 0, stabilized: false }
    return { content: JSON.stringify(content), displayMessages }
  }

  if (!success) {
    displayMessages.push({
      id,
      timestamp: ts,
      role: 'system',
      content: '急救失败，伤势未见好转',
    })
    const content: FirstAidResult = { healed: 0, stabilized: false }
    return { content: JSON.stringify(content), displayMessages }
  }

  const healed = Math.min(1, hpMax - hp)
  if (healed > 0) ctx.updateCharacterHP(healed)
  let stabilized = false
  if (isDying && healed > 0) {
    ctx.setCharacterDying(false)
    stabilized = true
  }

  displayMessages.push({
    id,
    timestamp: ts,
    role: 'system',
    content: `急救成功，HP +${healed}${stabilized ? '，调查员从濒死状态稳定为重伤' : ''}`,
  })

  const content: FirstAidResult = { healed, stabilized }
  return { content: JSON.stringify(content), displayMessages }
}

function handleMedicine(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const c = ctx.characterSheet
  const displayMessages: ToolHandlerResult['displayMessages'] = []
  const id = ctx.generateId()
  const ts = Date.now()

  if (!c || !c.derived) {
    const content: MedicineResult = { healed: 0 }
    return { content: JSON.stringify(content), displayMessages }
  }

  const hp = c.derived.hp
  const hpMax = c.derived.hpMax
  const success = !!args.success
  const healExpr = String(args.healExpr ?? '1d3')

  if (hp >= hpMax) {
    displayMessages.push({
      id,
      timestamp: ts,
      role: 'system',
      content: 'HP 已满，无需医学治疗',
    })
    const content: MedicineResult = { healed: 0 }
    return { content: JSON.stringify(content), displayMessages }
  }

  if (!success) {
    displayMessages.push({
      id,
      timestamp: ts,
      role: 'system',
      content: '医学检定失败，未能改善伤势',
    })
    const content: MedicineResult = { healed: 0 }
    return { content: JSON.stringify(content), displayMessages }
  }

  const rawHeal = Math.max(0, ctx.parseDiceExpr(healExpr))
  const canHeal = Math.max(0, hpMax - hp)
  const healed = Math.min(rawHeal, canHeal)
  if (healed > 0) ctx.updateCharacterHP(healed)

  displayMessages.push({
    id,
    timestamp: ts,
    role: 'system',
    content: `医学治疗成功，HP +${healed}`,
  })

  const content: MedicineResult = { healed }
  return { content: JSON.stringify(content), displayMessages }
}

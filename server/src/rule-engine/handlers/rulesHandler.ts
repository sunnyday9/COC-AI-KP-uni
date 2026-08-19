/**
 * rulesHandler — COC 7th 规则补充工具（规则书对照新增）：
 *  inspiration_check / cast_spell / read_tome / chase_turn / environment_damage / development_phase
 * 全部为可选新增能力：不改变既有 18 工具的调用语义。
 */
import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from '../types.js'

const TOOL_NAMES = ['inspiration_check', 'cast_spell', 'read_tome', 'chase_turn', 'environment_damage', 'development_phase'] as const

/** 表Ⅲ 环境伤害（规则书 7220-7259）：kind × severity → dice expr。 */
const ENV_DAMAGE: Record<string, Record<string, string>> = {
  fall: { mild: '1d3', moderate: '1d6', severe: '1d10', lethal: '2d10', terminal: '4d10', gory: '8d10' },
  fire: { mild: '1d3', moderate: '1d6', severe: '1d10', lethal: '2d10', terminal: '4d10', gory: '8d10' },
  drowning: { mild: '1d3', moderate: '1d6', severe: '1d10', lethal: '2d10', terminal: '4d10', gory: '8d10' },
  poison: { mild: '1d10', moderate: '2d10', severe: '4d10', lethal: '4d10', terminal: '4d10', gory: '4d10' },
}

function handleInspirationCheck(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const skillValue = Math.max(0, Math.min(99, Math.floor(Number(args.skillValue ?? 50))))
  const difficulty = String(args.difficulty ?? 'regular')
  const clue = String(args.clueDescription ?? '')
  const setback = String(args.setback ?? '')
  const roll = ctx.rollD(100)
  const { threshold, result: checkResult } = ctx.resolveSkillCheck(roll, skillValue, difficulty)
  const passed = ['critical_success', 'extreme_success', 'hard_success', 'regular_success'].includes(checkResult)
  const displayMessages: ToolHandlerResult['displayMessages'] = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      type: 'dice',
      content: `灵感检定 d100: ${roll} / 目标≤${threshold} → ${passed ? '成功' : '失败'}（无论成败线索都会给出）`,
      result: { roll, target: threshold },
    },
  ]
  return {
    content: JSON.stringify({
      roll,
      threshold,
      passed,
      clueGiven: clue,
      setback: passed ? '' : setback,
      note: passed ? '线索以迂回方式融入叙事' : '千钧一发：最差局面 + 破局线索同时给出',
    }),
    displayMessages,
  }
}

function handleCastSpell(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const spellName = String(args.spellName ?? '未知法术')
  const costMp = Math.max(0, Math.floor(Number(args.costMp ?? 0)))
  const costSan = Math.max(0, Math.floor(Number(args.costSan ?? 0)))
  const costPow = Math.max(0, Math.floor(Number(args.costPow ?? 0)))
  const powValue = Math.max(0, Math.min(99, Math.floor(Number(args.powValue ?? 50))))
  const firstCast = !!args.firstCast
  const push = !!args.push
  const c = ctx.characterSheet
  const mp = c?.derived?.mp ?? 0
  const hp = c?.derived?.hp ?? 0
  const hpMax = c?.derived?.hpMax ?? 1

  // 1) MP 扣除，不足部分 1:1 溢出到 HP（规则书 9.4）
  const mpOverflow = Math.max(0, costMp - mp)
  const mpPaid = Math.min(costMp, mp)
  if (mpPaid > 0) ctx.updateCharacterMP(-mpPaid)
  let hpDamage = 0
  if (mpOverflow > 0) {
    hpDamage = Math.min(hp, mpOverflow)
    ctx.updateCharacterHP(-hpDamage)
  }
  // 2) SAN 消耗
  let totalSanLost = 0
  if (costSan > 0) {
    totalSanLost += costSan
    ctx.updateCharacterSAN(-costSan)
    ctx.addCharacterDailySanLoss(costSan)
  }
  // 3) POW 消耗（可选）
  // 4) 首次施放：困难 POW 检定（规则书 9.3）
  let castResult = 'success'
  let checkDetail = ''
  if (firstCast) {
    const powThreshold = Math.floor(powValue / 2)
    const roll = ctx.rollD(100)
    const passed = roll <= powThreshold
    if (passed) {
      castResult = 'success'
      checkDetail = `困难 POW 检定 d100:${roll} ≤ ${powThreshold} 成功`
    } else if (push) {
      // 孤注一掷失败：法术必然生效但 1D6× 消耗反噬
      const backlashMultiplier = ctx.rollD(6)
      const extraSan = Math.max(0, Math.floor(costSan * backlashMultiplier))
      const extraMp = Math.max(0, Math.floor(costMp * backlashMultiplier))
      if (extraSan > 0) {
        totalSanLost += extraSan
        ctx.updateCharacterSAN(-extraSan)
        ctx.addCharacterDailySanLoss(extraSan)
      }
      const mpNow = c?.derived?.mp ?? 0
      const extraOverflow = Math.max(0, extraMp - mpNow)
      if (extraMp > 0) {
        ctx.updateCharacterMP(-Math.min(extraMp, mpNow))
        if (extraOverflow > 0) {
          const extraHpDamage = Math.min(hp - hpDamage, extraOverflow)
          if (extraHpDamage > 0) ctx.updateCharacterHP(-extraHpDamage)
          hpDamage += extraHpDamage
        }
      }
      castResult = 'success_with_backlash'
      checkDetail = `孤注一掷失败：法术仍生效，但反噬 ${backlashMultiplier}× 消耗（额外 SAN -${extraSan}，额外 MP -${extraMp}，HP 溢出 -${extraOverflow}）`
    } else {
      castResult = 'failed_first_cast'
      checkDetail = `困难 POW 检定 d100:${roll} > ${powThreshold} 失败（可孤注一掷：法术必然生效但 1D6× 反噬）`
    }
  }
  const displayMessages: ToolHandlerResult['displayMessages'] = [
    {
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `施法「${spellName}」: MP -${mpPaid}${hpDamage > 0 ? `，HP -${hpDamage}（MP 溢出）` : ''}${totalSanLost > 0 ? `，SAN -${totalSanLost}` : ''}${checkDetail ? `；${checkDetail}` : ''}`,
    },
  ]
  return {
    content: JSON.stringify({
      spellName,
      mpPaid,
      mpOverflow,
      hpDamage,
      sanLost: totalSanLost,
      castResult,
      checkDetail,
    }),
    displayMessages,
  }
}

function handleReadTome(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const tomeId = String(args.tomeId ?? '未知典籍')
  const mode = String(args.mode ?? 'browse') as 'browse' | 'study' | 'consult'
  const mythosCurrent = Math.max(0, Math.min(99, Math.floor(Number(args.mythosCurrent ?? 0))))
  const mythosGain = Math.max(0, Math.floor(Number(args.mythosGain ?? 0)))
  const sanLossExpr = String(args.sanLossExpr ?? '0')
  const languageSkill = Math.max(0, Math.min(99, Math.floor(Number(args.languageSkill ?? 50))))

  let mythosGained = 0
  let sanLost = 0
  let consultFound = false
  let languagePassed: boolean | null = null
  const displayMessages: ToolHandlerResult['displayMessages'] = []

  if (mode === 'browse') {
    // 泛读：语言检定（KP 可自动成功）→ CMI 增长 + 自动 SAN 损失（无理智检定）
    const langRoll = ctx.rollD(100)
    languagePassed = langRoll <= languageSkill
    if (languagePassed) {
      mythosGained = mythosGain
      sanLost = ctx.parseDiceExpr(sanLossExpr)
      if (mythosGained > 0) ctx.increaseCthulhuMythos(mythosGained)
      if (sanLost > 0) {
        ctx.updateCharacterSAN(-sanLost)
        ctx.addCharacterDailySanLoss(sanLost)
      }
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        content: `泛读「${tomeId}」: 语言检定 d100:${langRoll} ≤ ${languageSkill} 成功 → 克苏鲁神话 +${mythosGained}，SAN -${sanLost}（自动，无理智检定）`,
      })
    } else {
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        content: `泛读「${tomeId}」: 语言检定 d100:${langRoll} > ${languageSkill} 失败，未能读懂（可孤注一掷）`,
      })
    }
  } else if (mode === 'study') {
    // 精读：比较 mythos 与 MR（此处 mythosGain 视为 CMF 全额；已达 MR 只得 CMI）
    const cmf = mythosGain
    const cmi = Math.max(1, Math.floor(cmf / 2))
    const belowMr = mythosCurrent < 50 // 简化：MR=50 时按 CMI/CMF 比较（KP 可传实际 MR）
    mythosGained = belowMr ? cmf : cmi
    sanLost = ctx.parseDiceExpr(sanLossExpr)
    if (mythosGained > 0) ctx.increaseCthulhuMythos(mythosGained)
    if (sanLost > 0) {
      ctx.updateCharacterSAN(-sanLost)
      ctx.addCharacterDailySanLoss(sanLost)
    }
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `精读「${tomeId}」: ${belowMr ? '神话值 < MR，得 CMF 全额' : '神话值 ≥ MR，只得 CMI'} → 克苏鲁神话 +${mythosGained}，SAN -${sanLost}，所用语言技能获得成长标记`,
    })
  } else {
    // 查资料：1D100 ≤ MR 找到目标神话知识
    const mr = mythosCurrent
    const roll = ctx.rollD(100)
    consultFound = roll <= mr
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `查资料「${tomeId}」: d100:${roll} ${consultFound ? '≤' : '>'} ${mr} → ${consultFound ? '找到目标神话知识' : '一无所获'}`,
    })
  }

  return {
    content: JSON.stringify({ tomeId, mode, mythosGained, sanLost, consultFound, languagePassed }),
    displayMessages,
  }
}

function handleChaseTurn(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const participants = Array.isArray(args.participants) ? (args.participants as { name: string; mov: number; dex: number; actionPoints: number; location: number }[]) : []
  const map = Array.isArray(args.map) ? (args.map as { id: number; hazard?: { skill: string; damageExpr: string; difficulty: string }; obstacle?: { durability: number } }[]) : []
  const actions = Array.isArray(args.actions) ? (args.actions as { name: string; action: string; targetLocation?: number; skillName?: string; skillValue?: number; difficulty?: string }[]) : []
  const speedChecksDone = !!args.speedChecksDone

  const displayMessages: ToolHandlerResult['displayMessages'] = []
  const results: { name: string; action: string; outcome: string; damageTaken?: number; actionPointsLost?: number; newLocation?: number }[] = []

  for (const p of participants) {
    const pActions = actions.filter((a) => a.name === p.name)
    let ap = p.actionPoints
    for (const a of pActions) {
      if (ap <= 0) {
        results.push({ name: p.name, action: a.action, outcome: '行动点不足，无法行动' })
        continue
      }
      if (a.action === 'move') {
        const target = a.targetLocation ?? p.location + 1
        // 险境/障碍判定
        const loc = map.find((l) => l.id === target)
        ap -= 1
        let outcome = `移动到地点 ${target}`
        if (loc?.hazard) {
          const roll = ctx.rollD(100)
          const { threshold, result: checkResult } = ctx.resolveSkillCheck(roll, a.skillValue ?? 50, loc.hazard.difficulty ?? 'regular')
          const passed = ['critical_success', 'extreme_success', 'hard_success', 'regular_success'].includes(checkResult)
          if (passed) {
            outcome = `越过险境，移动到地点 ${target}`
          } else {
            const dmg = ctx.parseDiceExpr(loc.hazard.damageExpr ?? '1d6')
            const apLoss = ctx.rollD(3)
            ap -= apLoss
            outcome = `险境失败：受到 ${dmg} 点伤害，行动点 -${apLoss}`
            results.push({ name: p.name, action: a.action, outcome, damageTaken: dmg, actionPointsLost: apLoss, newLocation: target })
            continue
          }
        } else if (loc?.obstacle) {
          const roll = ctx.rollD(100)
          const passed = roll <= (a.skillValue ?? 50)
          if (!passed) {
            outcome = `障碍阻挡，无法通过地点 ${target}`
            results.push({ name: p.name, action: a.action, outcome, newLocation: p.location })
            continue
          }
          outcome = `破坏/绕过障碍（耐久 ${loc.obstacle.durability}），移动到地点 ${target}`
        }
        results.push({ name: p.name, action: a.action, outcome, newLocation: target })
      } else if (a.action === 'attack') {
        ap -= 1
        results.push({ name: p.name, action: a.action, outcome: '同地点攻击（使用战斗工具链结算）' })
      } else {
        ap -= 1
        results.push({ name: p.name, action: a.action, outcome: '其他行动（施法/撬锁等）' })
      }
    }
    if (ap < p.actionPoints) {
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        content: `追逐: ${p.name} 本轮消耗 ${p.actionPoints - ap} 行动点，剩余 ${Math.max(0, ap)}`,
      })
    }
  }

  return {
    content: JSON.stringify({
      speedChecksDone,
      roundComplete: true,
      results,
      note: speedChecksDone ? '' : '开场速度检定（CON/驾驶，极难+MOV，失败-MOV，追逐者初始落后 2 地点）尚未完成，请先处理',
    }),
    displayMessages,
  }
}

function handleEnvironmentDamage(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const kind = String(args.kind ?? 'fall') as 'fall' | 'fire' | 'drowning' | 'poison'
  const severity = String(args.severity ?? 'moderate')
  const conValue = Math.max(0, Math.min(99, Math.floor(Number(args.conValue ?? 50))))
  const targetIsInvestigator = !!args.targetIsInvestigator

  const expr = ENV_DAMAGE[kind]?.[severity] ?? '1d6'
  let damageDealt = 0
  let requiresConCheck = false
  let conPassed: boolean | null = null
  const displayMessages: ToolHandlerResult['displayMessages'] = []

  if (kind === 'drowning') {
    // 窒息/溺水：每轮 CON 检定，失败受伤害（规则书 7252-7257）
    requiresConCheck = true
    const conRoll = ctx.rollD(100)
    conPassed = conRoll <= conValue
    if (!conPassed) {
      damageDealt = ctx.parseDiceExpr(expr)
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `溺水: CON 检定 d100:${conRoll} > ${conValue} 失败 → 受到 ${damageDealt} 点伤害`,
      })
    } else {
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `溺水: CON 检定 d100:${conRoll} ≤ ${conValue} 成功，本轮无恙`,
      })
    }
  } else if (kind === 'poison') {
    // 毒药：CON 极难成功伤害减半，大成功豁免（规则书 7257-7260）
    const conRoll = ctx.rollD(100)
    const hardThreshold = Math.floor(conValue / 2)
    const extremeThreshold = Math.floor(conValue / 5)
    if (conRoll === 1) {
      conPassed = true
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `毒药: CON 检定 d100:${conRoll} 大成功 → 完全豁免`,
      })
    } else if (conRoll <= extremeThreshold) {
      conPassed = true
      damageDealt = Math.ceil(ctx.parseDiceExpr(expr) / 2)
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `毒药: CON 极难成功 d100:${conRoll} ≤ ${extremeThreshold} → 伤害减半 ${damageDealt}`,
      })
    } else if (conRoll <= hardThreshold) {
      conPassed = true
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `毒药: CON 困难成功 d100:${conRoll} ≤ ${hardThreshold} → 中毒但无伤害（副作用由 KP 裁定）`,
      })
    } else {
      conPassed = false
      damageDealt = ctx.parseDiceExpr(expr)
      displayMessages.push({
        id: ctx.generateId(),
        timestamp: Date.now(),
        role: 'system',
        type: 'dice',
        content: `毒药: CON 检定 d100:${conRoll} > ${conValue} 失败 → 受到 ${damageDealt} 点伤害`,
      })
    }
  } else {
    // fall/fire：直接按表Ⅲ 伤害
    damageDealt = ctx.parseDiceExpr(expr)
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      type: 'dice',
      content: `${kind === 'fall' ? '坠落' : '火焰'}伤害(${severity}) → ${damageDealt} 点`,
    })
  }

  if (targetIsInvestigator && damageDealt > 0) {
    ctx.updateCharacterHP(-damageDealt)
  }

  return {
    content: JSON.stringify({ kind, severity, damageDealt, requiresConCheck, conPassed }),
    displayMessages,
  }
}

function handleDevelopmentPhase(args: Record<string, unknown>, ctx: ToolHandlerContext): ToolHandlerResult {
  const growthSkills = Array.isArray(args.growthSkills) ? (args.growthSkills as { name: string; value: number }[]) : []
  const mythosGain = Math.max(0, Math.floor(Number(args.cthulhuMythosGain ?? 0)))

  const growthResults: { name: string; roll: number; grew: boolean; gain: number; newValue: number }[] = []
  let sanReward = 0
  const displayMessages: ToolHandlerResult['displayMessages'] = []

  for (const s of growthSkills) {
    const roll = ctx.rollD(100)
    const grew = roll > s.value || roll > 95
    const gain = grew ? ctx.rollD(10) : 0
    const newValue = s.value + gain
    if (grew) ctx.growCharacterSkill(s.name, newValue)
    growthResults.push({ name: s.name, roll, grew, gain, newValue })
    if (grew && newValue >= 90) sanReward += ctx.rollD(6) * 2
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `幕间成长「${s.name}」: d100:${roll} ${grew ? `> ${s.value} → +${gain}（现 ${newValue}%）` : '未成长'}`,
    })
  }

  if (mythosGain > 0) {
    ctx.increaseCthulhuMythos(mythosGain)
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `克苏鲁神话 +${mythosGain}`,
    })
  }

  if (sanReward > 0) {
    ctx.updateCharacterSAN(sanReward)
    displayMessages.push({
      id: ctx.generateId(),
      timestamp: Date.now(),
      role: 'system',
      content: `技能达 90%+ 自信心奖励: SAN +${sanReward}`,
    })
  }

  return {
    content: JSON.stringify({
      growthResults,
      cthulhuMythosGained: mythosGain,
      sanReward,
      marksCleared: true,
      note: '克苏鲁神话与信用评级不获得成长标记；不定性疯狂可在此阶段恢复（KP 裁定）',
    }),
    displayMessages,
  }
}

export const rulesHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    if (toolName === 'inspiration_check') return handleInspirationCheck(args, context)
    if (toolName === 'cast_spell') return handleCastSpell(args, context)
    if (toolName === 'read_tome') return handleReadTome(args, context)
    if (toolName === 'chase_turn') return handleChaseTurn(args, context)
    if (toolName === 'environment_damage') return handleEnvironmentDamage(args, context)
    if (toolName === 'development_phase') return handleDevelopmentPhase(args, context)
    return { content: 'error: unknown tool', displayMessages: [] }
  },
}

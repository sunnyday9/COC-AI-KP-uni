#!/usr/bin/env node
/**
 * test-agent/lib/toolExecutor.mjs — 模拟客户端工具执行器
 *
 * 项目架构：KP 工具循环在客户端。服务端每次 invoke 返回 toolCalls，
 * 客户端执行工具后把结果作为 role:'tool' 消息回传，再发起下一次 invoke。
 *
 * 本模块在测试中扮演"客户端工具执行器"：根据工具名生成与服务端
 * analyzeToolContinuation 兼容的 JSON 结果（格式对齐客户端真实 handler）：
 *  - skill_check → { roll, threshold, result, skillName, success }
 *  - roll_dice   → { roll, sides }
 *  - san_check   → { roll, currentSan, success }
 *  - grant_clue  → 'Clue granted: <desc>'（客户端 narrativeHandler 输出）
 *  - transition_scene → 'Scene transitioned to: <name>'
 *  - end_game    → 'Game ended: <title>'
 *  - adjust_hp   → 'HP adjusted by N'
 *  - 其他        → 通用 JSON { ok: true, tool: name }
 */

/** 根据工具调用生成客户端会返回的 tool 消息 content */
export function simulateToolResult(tc) {
  const name = tc.name
  let args = {}
  try {
    args = JSON.parse(tc.arguments || '{}')
  } catch {
    args = { _parseError: tc.arguments }
  }

  switch (name) {
    case 'skill_check': {
      const skillName = String(args.skillName ?? '未知')
      const skillValue = Number(args.skillValue ?? 60)
      const roll = Math.floor(Math.random() * 100) + 1
      const success = roll <= skillValue
      return JSON.stringify({
        roll,
        threshold: skillValue,
        result: success ? 'regular_success' : 'failure',
        skillName,
        success,
      })
    }
    case 'opposed_check': {
      const rollA = Math.floor(Math.random() * 100) + 1
      const rollB = Math.floor(Math.random() * 100) + 1
      return JSON.stringify({
        rollA,
        rollB,
        result: rollA <= rollB ? 'A_wins' : 'B_wins',
        success: true,
      })
    }
    case 'roll_dice': {
      const sides = Math.max(2, Number(args.sides ?? 6) || 6)
      const roll = Math.floor(Math.random() * sides) + 1
      return JSON.stringify({ roll, sides })
    }
    case 'san_check': {
      const currentSan = Number(args.currentSan ?? 60)
      const roll = Math.floor(Math.random() * 100) + 1
      const loss = Number(args.failureLoss ?? 1)
      return JSON.stringify({
        roll,
        currentSan,
        success: roll <= currentSan,
        sanLoss: roll <= currentSan ? Number(args.successLoss ?? 0) : loss,
        newSan: Math.max(0, currentSan - (roll <= currentSan ? Number(args.successLoss ?? 0) : loss)),
      })
    }
    case 'grant_clue': {
      const description = String(args.description ?? '')
      return description ? `Clue granted: ${description}` : 'error: description required'
    }
    case 'transition_scene': {
      const sceneName = String(args.sceneName ?? '')
      return sceneName ? `Scene transitioned to: ${sceneName}` : 'error: sceneName required'
    }
    case 'end_game': {
      const title = String(args.title ?? '').trim() || '结局'
      return `Game ended: ${title}`
    }
    case 'adjust_hp': {
      const delta = Number(args.delta ?? 0)
      return `HP adjusted by ${delta}`
    }
    case 'adjust_san': {
      const delta = Number(args.delta ?? 0)
      return `SAN adjusted by ${delta}`
    }
    case 'adjust_mp': {
      const delta = Number(args.delta ?? 0)
      return `MP adjusted by ${delta}`
    }
    case 'spend_luck': {
      const amount = Number(args.amount ?? 0)
      return JSON.stringify({ spent: amount, success: true })
    }
    case 'first_aid': {
      return JSON.stringify({ success: true, healed: 1 })
    }
    case 'medicine': {
      return JSON.stringify({ success: true, healed: 1 })
    }
    case 'melee_attack':
    case 'ranged_attack': {
      return JSON.stringify({ success: true, damage: 4 })
    }
    case 'apply_major_wound': {
      return JSON.stringify({ success: true })
    }
    case 'trigger_insanity': {
      return JSON.stringify({ success: true })
    }
    case 'reset_day': {
      return JSON.stringify({ success: true })
    }
    default:
      return JSON.stringify({ ok: true, tool: name })
  }
}

/**
 * 驱动完整玩家回合：发送消息 → 收到 toolCalls → 模拟执行 → 回传 → 再 invoke，
 * 直到无工具调用或达到上限。
 *
 * @param ws          connectWs 返回的 WS 客户端
 * @param messages    当前对话上下文（会被追加）
 * @param playerText  玩家本条消息
 * @param opts        { maxRounds, tag, storyContext }
 * @returns { messages, toolCalls, content, rounds, totalMs }
 */
export async function runPlayerTurn(ws, initialMessages, playerText, { maxRounds = 8, tag = '', storyContext = undefined, invokeTimeoutMs = 180_000 } = {}) {
  const messages = [...initialMessages]
  const allToolCalls = []
  const start = Date.now()
  let finalContent = ''
  let rounds = 0

  messages.push({ role: 'user', content: playerText })

  for (let loop = 0; loop < maxRounds; loop++) {
    rounds++
    const r = await ws.invoke(messages, { streamId: `${tag}_${Date.now()}_${loop}`, timeoutMs: invokeTimeoutMs }, storyContext)
    const content = r.content || ''
    const tcs = r.toolCalls || []

    if (content) finalContent = content
    if (tcs.length === 0) break

    // 记录 + 模拟执行
    for (const tc of tcs) {
      let args = {}
      try {
        args = JSON.parse(tc.arguments || '{}')
      } catch {
        args = { _parseError: tc.arguments }
      }
      allToolCalls.push({ name: tc.name, args, id: tc.id })
    }

    // 追加 assistant（含 tool_calls）+ tool 结果（客户端真实行为）
    messages.push({
      role: 'assistant',
      content: content,
      tool_calls: tcs.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.arguments },
      })),
    })
    const toolResults = tcs.map((t) => ({
      role: 'tool',
      tool_call_id: t.id,
      content: simulateToolResult(t),
    }))
    messages.push(...toolResults)
  }

  return { messages, toolCalls: allToolCalls, content: finalContent, rounds, totalMs: Date.now() - start }
}

export function hasTool(calls, name) {
  return calls.some((c) => c.name === name)
}

export function countTool(calls, name) {
  return calls.filter((c) => c.name === name).length
}

export function toolArgs(calls, name) {
  const t = calls.find((c) => c.name === name)
  return t ? t.args : null
}

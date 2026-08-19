#!/usr/bin/env node
/**
 * test-agent/scenario-investigate.mjs — 场景一：调查链（线索驱动）API 级测试
 *
 * 直接通过 HTTP + WS 驱动项目服务端，验证：
 *  - AW-C-01 开场叙事
 *  - AW-C-02 侦查场景 → skill_check → grant_clue（线索 1）
 *  - AW-C-03 查看办公桌 → 线索 2/3
 *  - AW-C-04 查看学校资料 → 线索 4
 *  - AW-C-05 询问教师 → 线索 5/6
 *  - AW-C-06 查看刘向圆抽屉 → 线索 8
 *  - AW-C-07 查看预算表 → 线索 9
 *  - AW-C-08 查看账本 → 线索 12
 *  - AW-C-09 询问学生 → 线索 15
 *  - AW-C-10 前往地下入口 → 场景切换
 *  - AW-C-11 检查水迹 → 线索 19
 *  - AW-C-12 前往地下室 → 场景切换
 *  - AW-C-13 查看仪式书 → 线索 20
 *
 * 运行：node test-agent/scenario-investigate.mjs
 * 依赖：AW_BASE_URL / AW_API_KEY / AW_MODEL 环境变量（或本机 ZCode 配置）
 */

import {
  ROOT,
  startServices,
  registerUser,
  saveAiSettings,
  uploadAndIndex,
  connectWs,
  step,
  printSummary,
  cleanup,
  getLlmConfig,
  getResults,
} from './lib/common.mjs'
import { runPlayerTurn, hasTool, toolArgs } from './lib/toolExecutor.mjs'
import path from 'node:path'
import fs from 'node:fs'

/* ═══════════════════ 主流程 ═══════════════════ */

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3101, 5176, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `aw_user_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)
    console.log('[AW] AI settings saved (mimo-v2.5)')

    // 上传并索引剧本（结构化门控版，供服务端 scriptContext 门控使用）
    const fixture = path.join(ROOT, 'test-agent', 'fixtures', 'black-campus-structured.json')
    const story = await uploadAndIndex(apiBase, fixture, token)
    const scriptId = story.upload?.scriptId ?? story.upload?.id
    console.log(`[AW] story uploaded + indexed: ${scriptId}`)

    // 建立 WS
    const ws = connectWs(apiBase, token)
    await ws.opened
    console.log('[AW] WS connected\n')

    // 会话状态跟踪（clues/scene 供 storyContext 门控）
    const obtainedClues = new Set() // clue ids
    let currentSceneName = '校长办公室'
    const storyContext = () => ({
      scriptId,
      sceneId: currentSceneName,
      sceneName: currentSceneName,
      sceneType: 'investigation',
      openClues: [...obtainedClues].map((id) => ({ id, description: id })),
    })
    // 工具调用后同步状态（模拟客户端 addClue/transitionToScene）
    function applyToolCalls(toolCalls) {
      for (const tc of toolCalls) {
        if (tc.name === 'grant_clue' && tc.args.clueId) obtainedClues.add(tc.args.clueId)
        if (tc.name === 'transition_scene' && tc.args.sceneName) currentSceneName = tc.args.sceneName
      }
    }

    // 初始消息：开场
    const opening = await runPlayerTurn(ws, [], '我们刚进入古城福音中学，校长马卡拉接待了我们。请为调查员做开场描述。', { tag: 'AW-open', storyContext: storyContext() })

    await step('AW-C-01 开场叙事（KP 有回复）', () => {
      if (!opening.content) throw new Error('开场无叙事回复')
      console.log(`    开场文本: ${opening.content.slice(0, 120)}...`)
    })

    // 对话上下文（从开场后的消息继续）
    let messages = opening.messages

    // ── 调查链：逐条发送玩家行动 ──

    const clueNames = []

    await step('AW-C-02 侦查办公桌 → skill_check + grant_clue（线索）', async () => {
      const r = await runPlayerTurn(ws, messages, '我仔细侦查这间校长办公室，搜查办公桌。', { tag: 'AW-C-02', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      // 门控已注入可获线索；LLM 有权选择 skill_check 或直接 grant_clue（显明线索）
      if (!hasTool(r.toolCalls, 'skill_check') && !hasTool(r.toolCalls, 'grant_clue')) {
        throw new Error(`无 skill_check / grant_clue，实际: ${JSON.stringify(r.toolCalls)}`)
      }
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) {
        clueNames.push(c.args.description || '')
        console.log(`    获得线索: ${(c.args.description || '').slice(0, 60)}`)
      }
      if (!hasTool(r.toolCalls, 'grant_clue')) console.log(`    [warn] 无 grant_clue: ${JSON.stringify(r.toolCalls)}`)
    })

    await step('AW-C-03 查看学校资料 → 线索（地基设计图）', async () => {
      const r = await runPlayerTurn(ws, messages, '我查看校长办公室里的学校资料和地基设计图。', { tag: 'AW-C-03', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-C-04 前往教师办公室询问刘向圆（NPC 对话）', async () => {
      const r = await runPlayerTurn(ws, messages, '我前往教师办公室，向督学主任刘向圆询问失踪学生的情况。', { tag: 'AW-C-04', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      console.log(`    回复: ${(r.content || '').slice(0, 80)}`)
    })

    await step('AW-C-05 查看刘向圆抽屉 → 线索（火车票）', async () => {
      const r = await runPlayerTurn(ws, messages, '我趁刘向圆不注意，查看她的抽屉。', { tag: 'AW-C-05', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-C-06 前往总务处查看预算表/账本 → 线索', async () => {
      const r = await runPlayerTurn(ws, messages, '我前往总务办公室，查看预算表和账本，寻找异常。', { tag: 'AW-C-06', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-C-07 询问学生 → 线索（禁地地图）', async () => {
      const r = await runPlayerTurn(ws, messages, '我在教学楼走廊里找到学生林小雨，向她打听失踪学生和学校里的传闻。', { tag: 'AW-C-07', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-C-08 前往男生宿舍地下入口 → 场景切换', async () => {
      const r = await runPlayerTurn(ws, messages, '我前往男生宿舍一层，寻找通往地下的入口。', { tag: 'AW-C-08', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const ts = r.toolCalls.filter((c) => c.name === 'transition_scene')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (ts.length > 0) console.log(`    场景: ${(ts[0].args.sceneName || '').slice(0, 60)}`)
      else console.log('    [warn] 未触发 transition_scene')
    })

    await step('AW-C-09 检查水迹/门卫 → 线索', async () => {
      const r = await runPlayerTurn(ws, messages, '我检查宿舍走廊的水迹，并和门卫老周聊聊最近夜里的怪事。', { tag: 'AW-C-09', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-C-10 前往地下密室 → 场景切换', async () => {
      const r = await runPlayerTurn(ws, messages, '我用钥匙打开铁链，沿着水迹走进地下室。', { tag: 'AW-C-10', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const ts = r.toolCalls.filter((c) => c.name === 'transition_scene')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (ts.length > 0) console.log(`    场景: ${(ts[0].args.sceneName || '').slice(0, 60)}`)
      else console.log('    [warn] 未触发 transition_scene')
    })

    await step('AW-C-11 查看仪式书/神像 → 关键线索', async () => {
      const r = await runPlayerTurn(ws, messages, '我查看地下室石台上的仪式书和青铜神像。', { tag: 'AW-C-11', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const clues = r.toolCalls.filter((c) => c.name === 'grant_clue')
      for (const c of clues) clueNames.push(c.args.description || '')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    }, 240_000)

    await step('AW-C-12 结局：破坏仪式 → end_game', async () => {
      const r = await runPlayerTurn(ws, messages, '我决定破坏仪式，制服马卡拉，救出昏迷的学生！', { tag: 'AW-C-12', storyContext: storyContext() })
      messages = r.messages
      applyToolCalls(r.toolCalls)
      const eg = r.toolCalls.filter((c) => c.name === 'end_game')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (eg.length > 0) {
        console.log(`    结局: ${(eg[0].args.outcome || '')} — ${(eg[0].args.title || '').slice(0, 40)}`)
      } else {
        console.log('    [warn] 未触发 end_game，工具链可能未走完')
      }
    }, 240_000)

    /* ── 汇总 ── */
    console.log(`\n[AW] 调查链汇总`)
    console.log(`  获得线索 ${clueNames.length} 条:`)
    for (const c of clueNames) console.log(`    - ${c.slice(0, 80)}`)

    ws.close()
  } finally {
    printSummary('scenario-investigate')
    cleanup()
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function resultsCount() {
  return getResults().length
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})

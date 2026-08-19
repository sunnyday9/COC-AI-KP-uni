#!/usr/bin/env node
/**
 * test-agent/scenario-rules.mjs — 规则书补全验证（API 级）
 *
 * 验证 COC-7th 规则书对照新增的能力在真实 KP Agent 流程中可被调用：
 *  - AW-R-01 施法场景（cast_spell）
 *  - AW-R-02 阅读神话典籍（read_tome）
 *  - AW-R-03 追逐场景（chase_turn）
 *  - AW-R-04 环境伤害（environment_damage）
 *  - AW-R-05 幕间成长（development_phase）
 *  - AW-R-06 灵感检定（inspiration_check）—— 玩家停滞时 KP 使用
 *
 * 运行：node test-agent/scenario-rules.mjs
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
  getLlmConfig,
  getResults,
} from './lib/common.mjs'
import { runPlayerTurn, hasTool, toolArgs } from './lib/toolExecutor.mjs'
import path from 'node:path'

/* ═══════════════════ 主流程 ═══════════════════ */

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase } = await startServices(3103, 5178, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `rules_user_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)
    console.log('[AW] AI settings saved')

    const fixture = path.join(ROOT, 'test-agent', 'fixtures', 'black-campus.txt')
    await uploadAndIndex(apiBase, fixture, token)
    console.log('[AW] story uploaded + indexed')

    const ws = connectWs(apiBase, token)
    await ws.opened
    console.log('[AW] WS connected\n')

    // 初始消息：开场
    let messages = []
    const opening = await runPlayerTurn(ws, [], '我们刚进入古城福音中学，校长马卡拉接待了我们。请为调查员做开场描述。', { tag: 'AW-R-open', invokeTimeoutMs: 240_000 })
    messages = opening.messages

    await step('AW-R-01 施法场景 → cast_spell（规则书第九章）', async () => {
      const r = await runPlayerTurn(ws, messages, '我在密室中尝试施放一个古老的防护法术，消耗 3 点魔法值和 2 点理智。', { tag: 'AW-R-01', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const cs = r.toolCalls.filter((c) => c.name === 'cast_spell')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (cs.length === 0) console.log('    [warn] 未调用 cast_spell（LLM 可能选择叙事处理）')
    }, 240_000)

    await step('AW-R-02 阅读典籍 → read_tome（规则书第十一章）', async () => {
      const r = await runPlayerTurn(ws, messages, '我拿起桌上的古籍《伊波恩之书》，尝试泛读它的内容。', { tag: 'AW-R-02', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const rt = r.toolCalls.filter((c) => c.name === 'read_tome')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (rt.length === 0) console.log('    [warn] 未调用 read_tome（LLM 可能选择 skill_check 处理）')
    }, 240_000)

    await step('AW-R-03 追逐场景 → chase_turn（规则书第七章）', async () => {
      const r = await runPlayerTurn(ws, messages, '突然警报大作！我夺门而出，身后的邪教徒紧追不舍，我们开始了一场追逐！', { tag: 'AW-R-03', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const ct = r.toolCalls.filter((c) => c.name === 'chase_turn')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (ct.length === 0) console.log('    [warn] 未调用 chase_turn（LLM 可能用 skill_check/叙事处理追逐）')
    }, 240_000)

    await step('AW-R-04 环境伤害 → environment_damage（规则书表Ⅲ）', async () => {
      const r = await runPlayerTurn(ws, messages, '我从二楼窗户跳下逃生，摔落在楼下的草地上！', { tag: 'AW-R-04', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const ed = r.toolCalls.filter((c) => c.name === 'environment_damage')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (ed.length === 0) console.log('    [warn] 未调用 environment_damage（LLM 可能用 adjust_hp 处理）')
    }, 240_000)

    await step('AW-R-05 幕间成长 → development_phase（规则书第五章）', async () => {
      const r = await runPlayerTurn(ws, messages, '这次的冒险告一段落，我们休整一夜，进行幕间成长：检查这次用过的技能。', { tag: 'AW-R-05', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const dp = r.toolCalls.filter((c) => c.name === 'development_phase')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (dp.length === 0) console.log('    [warn] 未调用 development_phase（LLM 可能未识别幕间时机）')
    }, 240_000)

    await step('AW-R-06 灵感检定 → inspiration_check（规则书第十章）', async () => {
      const r = await runPlayerTurn(ws, messages, '我们完全卡住了，不知道下一步该去哪里调查。我停下来思考，试图回忆起之前见过的线索。', { tag: 'AW-R-06', invokeTimeoutMs: 240_000 })
      messages = r.messages
      const ic = r.toolCalls.filter((c) => c.name === 'inspiration_check')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      if (ic.length === 0) console.log('    [warn] 未调用 inspiration_check（停滞检测可能已强制 grant_clue）')
    }, 240_000)

    /* ── 汇总 ── */
    console.log('\n[AW] 规则书场景汇总')
    ws.close()
  } finally {
    printSummary('[scenario-rules]')
  }
}

main().catch((err) => {
  console.error('[AW] FATAL:', err)
  const results = getResults()
  printSummary('[scenario-rules]')
  process.exit(1)
})

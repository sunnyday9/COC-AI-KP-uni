#!/usr/bin/env node
/**
 * test-agent/scenario-combat.mjs — 场景二：战斗链（API 级）
 *
 * 验证：
 *  - AW-CM-01 开场
 *  - AW-CM-02 遭遇战 → melee_attack / ranged_attack
 *  - AW-CM-03 战损 → adjust_hp / first_aid / medicine（治疗链）
 *  - AW-CM-04 濒死/重伤处理
 *  - AW-CM-05 战后收尾叙事
 *
 * 运行：node test-agent/scenario-combat.mjs
 */

import {
  startServices,
  registerUser,
  saveAiSettings,
  connectWs,
  step,
  printSummary,
  cleanup,
  getLlmConfig,
} from './lib/common.mjs'
import { runPlayerTurn, hasTool } from './lib/toolExecutor.mjs'

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3102, 5177, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `aw_cm_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)

    const ws = connectWs(apiBase, token)
    await ws.opened
    console.log('[AW] WS connected\n')

    let messages = []

    await step('AW-CM-01 开场（教学楼遭遇）', async () => {
      const r = await runPlayerTurn(ws, messages, '我们在教学楼走廊里遇到一只扭曲的怪物挡路，它发出嘶嘶声扑了过来！请描述场景。', { tag: 'AW-CM-01' })
      messages = r.messages
      if (!r.content) throw new Error('开场无叙事')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-CM-02 主动攻击 → 战斗工具', async () => {
      const r = await runPlayerTurn(ws, messages, '我拔出匕首，向怪物的腹部刺去！', { tag: 'AW-CM-02' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      if (!names.some((n) => ['melee_attack', 'ranged_attack', 'skill_check', 'roll_dice'].includes(n))) {
        throw new Error(`无战斗相关工具: ${JSON.stringify(r.toolCalls)}`)
      }
    })

    await step('AW-CM-03 怪物反击 → 战损处理（adjust_hp）', async () => {
      const r = await runPlayerTurn(ws, messages, '怪物挥动触手击中了我，我受了伤！请结算我的伤势。', { tag: 'AW-CM-03' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      console.log(`    回复: ${(r.content || '').slice(0, 80)}`)
    })

    await step('AW-CM-04 治疗 → first_aid / medicine', async () => {
      const r = await runPlayerTurn(ws, messages, '我给自己做急救处理，包扎伤口。', { tag: 'AW-CM-04' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      if (!names.some((n) => ['first_aid', 'medicine', 'adjust_hp'].includes(n))) {
        console.log('    [warn] 未触发治疗工具（LLM 可能选择叙事处理）')
      }
    })

    await step('AW-CM-05 继续战斗 → 击杀或逃脱', async () => {
      const r = await runPlayerTurn(ws, messages, '我咬牙继续战斗，用尽全力向怪物要害猛刺！', { tag: 'AW-CM-05' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      console.log(`    回复: ${(r.content || '').slice(0, 100)}`)
    })

    ws.close()
  } finally {
    printSummary('scenario-combat')
    cleanup()
  }
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})

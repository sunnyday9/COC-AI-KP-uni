#!/usr/bin/env node
/**
 * test-agent/scenario-sanity.mjs — 场景三：SAN/恐怖链（API 级）
 *
 * 验证：
 *  - AW-CS-01 开场（诡异氛围）
 *  - AW-CS-02 直面恐怖 → san_check
 *  - AW-CS-03 SAN 损失 → adjust_san / trigger_insanity
 *  - AW-CS-04 疯狂状态处理
 *  - AW-CS-05 恢复/收尾
 *
 * 运行：node test-agent/scenario-sanity.mjs
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

  const { apiBase, tmpRoot } = await startServices(3103, 5178, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `aw_cs_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)

    const ws = connectWs(apiBase, token)
    await ws.opened
    console.log('[AW] WS connected\n')

    let messages = []

    await step('AW-CS-01 开场（诡异氛围）', async () => {
      const r = await runPlayerTurn(ws, messages, '我们走进地下室，空气冰冷，墙壁上画满扭曲的符号，黑暗中传来低语声。请描述。', { tag: 'AW-CS-01' })
      messages = r.messages
      if (!r.content) throw new Error('开场无叙事')
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
    })

    await step('AW-CS-02 直面恐怖 → san_check', async () => {
      const r = await runPlayerTurn(ws, messages, '我直视青铜神像的眼睛，那眼睛仿佛在转动，我的理智正在崩塌！', { tag: 'AW-CS-02' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      if (!hasTool(r.toolCalls, 'san_check')) {
        console.log('    [warn] 未触发 san_check（LLM 可能以叙事表达恐惧）')
      }
    })

    await step('AW-CS-03 SAN 损失 → adjust_san', async () => {
      const r = await runPlayerTurn(ws, messages, '那低语钻进我的脑子，我的精神受到重创，我感觉自己正在失去理智！', { tag: 'AW-CS-03' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      if (!names.some((n) => ['san_check', 'adjust_san', 'trigger_insanity'].includes(n))) {
        console.log('    [warn] 未触发 SAN 相关工具')
      }
    })

    await step('AW-CS-04 疯狂边缘 → trigger_insanity', async () => {
      const r = await runPlayerTurn(ws, messages, '我再也撑不住了，眼前出现无数幻觉，我尖叫着跪倒在地！', { tag: 'AW-CS-04' })
      messages = r.messages
      const names = r.toolCalls.map((c) => c.name)
      console.log(`    工具: ${names.join(', ') || '(纯叙事)'}`)
      if (!hasTool(r.toolCalls, 'trigger_insanity')) {
        console.log('    [warn] 未触发 trigger_insanity')
      }
    })

    await step('AW-CS-05 恢复/收尾', async () => {
      const r = await runPlayerTurn(ws, messages, '同伴把我拉出地下室，我在月光下慢慢平复呼吸，努力找回理智。', { tag: 'AW-CS-05', invokeTimeoutMs: 240_000 })
      messages = r.messages
      console.log(`    工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      console.log(`    回复: ${(r.content || '').slice(0, 100)}`)
    }, 240_000)

    ws.close()
  } finally {
    printSummary('scenario-sanity')
    cleanup()
  }
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})

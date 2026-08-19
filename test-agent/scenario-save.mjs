#!/usr/bin/env node
/**
 * test-agent/scenario-save.mjs — 场景四：存档/读档（API 级）
 *
 * 验证：
 *  - AW-S-01 存档写入（含消息历史 + 角色状态）
 *  - AW-S-02 读档恢复（消息 + 状态一致）
 *  - AW-S-03 存档列表
 *  - AW-S-04 删除存档
 *  - AW-S-05 存档后继续对话（上下文保持）
 *
 * 运行：node test-agent/scenario-save.mjs
 */

import {
  startServices,
  registerUser,
  saveAiSettings,
  connectWs,
  api,
  step,
  printSummary,
  cleanup,
  getLlmConfig,
} from './lib/common.mjs'
import { runPlayerTurn } from './lib/toolExecutor.mjs'

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3107, 5182, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `aw_s_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)

    const ws = connectWs(apiBase, token)
    await ws.opened

    // 先跑两轮对话产生消息历史
    let messages = []
    let firstTurn
    await step('AW-S-00 产生对话历史（2 轮）', async () => {
      firstTurn = await runPlayerTurn(ws, messages, '我进入校长办公室，查看桌上的文件。', { tag: 'AW-S-00a' })
      messages = firstTurn.messages
      const second = await runPlayerTurn(ws, messages, '我询问刘向圆关于失踪学生的事。', { tag: 'AW-S-00b' })
      messages = second.messages
      console.log(`    对话历史长度: ${messages.length} 条消息`)
    })

    await step('AW-S-01 存档写入（含消息+状态）', async () => {
      const snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        displayName: '调查档案',
        messages,
        characterSheet: { name: '测试调查员', hp: 12, san: 60, mp: 9, luck: 55 },
        currentScene: '校长办公室',
        cluesObtained: ['办公桌上的相框'],
      }
      const r = await api(apiBase, 'PUT', '/api/saves/save_001', snapshot, token)
      console.log(`    status: ${r.status}, body: ${r.text.slice(0, 50)}`)
      if (r.status !== 200) throw new Error(`存档失败 (${r.status}): ${r.text}`)
    })

    await step('AW-S-02 读档恢复（消息+状态一致）', async () => {
      const r = await api(apiBase, 'GET', '/api/saves/save_001', undefined, token)
      if (r.status !== 200) throw new Error(`读档失败 (${r.status})`)
      const s = r.json
      if (s.messages?.length !== messages.length) throw new Error(`消息数不符: 期望 ${messages.length} 实际 ${s.messages?.length}`)
      if (s.characterSheet?.hp !== 12) throw new Error(`HP 不符: ${s.characterSheet?.hp}`)
      if (s.currentScene !== '校长办公室') throw new Error(`场景不符: ${s.currentScene}`)
      console.log(`    消息 ${s.messages.length} 条, HP=${s.characterSheet.hp}, 场景=${s.currentScene}, 线索=${s.cluesObtained?.length}`)
    })

    await step('AW-S-03 存档列表', async () => {
      const r = await api(apiBase, 'GET', '/api/saves', undefined, token)
      console.log(`    status: ${r.status}, 存档: ${JSON.stringify(r.json)}`)
      if (!Array.isArray(r.json) || !r.json.includes('save_001')) throw new Error(`存档列表缺 save_001: ${r.text}`)
    })

    await step('AW-S-05 存档后继续对话（上下文保持）', async () => {
      const r = await runPlayerTurn(ws, messages, '我记下了刚才的发现，继续调查这所学校。', { tag: 'AW-S-05' })
      messages = r.messages
      console.log(`    继续对话工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      console.log(`    回复: ${(r.content || '').slice(0, 80)}`)
    })

    await step('AW-S-04 删除存档', async () => {
      const r = await api(apiBase, 'DELETE', '/api/saves/save_001', undefined, token)
      console.log(`    status: ${r.status}`)
      if (r.status !== 200) throw new Error(`删除失败 (${r.status})`)
      const list = await api(apiBase, 'GET', '/api/saves', undefined, token)
      if (list.json?.includes('save_001')) throw new Error('删除后仍存在')
    })

    ws.close()
  } finally {
    printSummary('scenario-save')
    cleanup()
  }
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})

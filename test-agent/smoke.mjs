#!/usr/bin/env node
/**
 * test-agent/smoke.mjs — 快速连通性冒烟
 * 验证：注册 → 保存 mimo 设置 → WS 连接 → 发一条消息 → 收到回复（含工具调用）
 * 运行：node test-agent/smoke.mjs
 */

import {
  startServices,
  registerUser,
  saveAiSettings,
  connectWs,
  cleanup,
  getLlmConfig,
} from './lib/common.mjs'

async function main() {
  const llm = getLlmConfig()
  console.log(`[SMOKE] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3101, 5176, { web: false })
  console.log(`[SMOKE] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `smoke_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)
    console.log('[SMOKE] settings saved')

    const ws = connectWs(apiBase, token)
    await ws.opened
    console.log('[SMOKE] WS connected')

    const t0 = Date.now()
    const r = await ws.invoke(
      [
        { role: 'user', content: '我仔细侦查这间房间，搜查书架。' },
      ],
      { streamId: `smoke_${Date.now()}`, timeoutMs: 120_000 },
    )
    const ms = Date.now() - t0
    console.log(`[SMOKE] invoke 完成 (${ms}ms)`)
    console.log(`[SMOKE] content: ${(r.content || '').slice(0, 150)}`)
    console.log(`[SMOKE] toolCalls: ${JSON.stringify(r.toolCalls, null, 2).slice(0, 500)}`)
    console.log(`[SMOKE] chunks: ${r.chunks.length}, traces: ${r.traces.length}`)

    if (r.content || (r.toolCalls && r.toolCalls.length > 0)) {
      console.log('[SMOKE] ✅ PASS — 收到回复')
    } else {
      console.log('[SMOKE] ❌ FAIL — 无回复')
      process.exitCode = 1
    }

    ws.close()
  } catch (err) {
    console.error('[SMOKE] ❌ FAIL:', err.message)
    process.exitCode = 1
  } finally {
    cleanup()
  }
}

main()

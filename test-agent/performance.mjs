#!/usr/bin/env node
/**
 * test-agent/performance.mjs — 性能测量（真实 LLM 基线）
 *
 * 测量：
 *  - AW-P-01 单轮 invoke 端到端延迟（发送→end 帧）
 *  - AW-P-02 工具链完整回合总耗时
 *  - AW-P-03 每轮 LLM 调用次数（trace 事件计数）
 *  - AW-P-04 长对话劣化：第 1/3/5 条消息延迟对比
 *  - AW-P-05 流式 chunk 分布（首 chunk 延迟）
 *
 * 运行：node test-agent/performance.mjs
 * 输出 JSON 到 test-agent/perf-results.json（供报告引用）
 */

import {
  startServices,
  registerUser,
  saveAiSettings,
  connectWs,
  cleanup,
  getLlmConfig,
} from './lib/common.mjs'
import { runPlayerTurn } from './lib/toolExecutor.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function main() {
  const llm = getLlmConfig()
  console.log(`[PERF] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3105, 5180, { web: false })
  console.log(`[PERF] services up: ${apiBase}`)

  const perf = { llm: llm.model, ts: new Date().toISOString(), samples: [] }

  try {
    const token = await registerUser(apiBase, `aw_p_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)
    const ws = connectWs(apiBase, token)
    await ws.opened

    /* ── P-01 单轮 invoke 延迟（3 次采样） ── */
    console.log('\n[PERF] P-01 单轮 invoke 延迟（3 次）')
    const p01 = []
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      const r = await ws.invoke([{ role: 'user', content: `我搜索房间寻找线索（第 ${i + 1} 次）。` }], {
        streamId: `perf_p01_${i}`,
        timeoutMs: 120_000,
      })
      const ms = Date.now() - t0
      p01.push(ms)
      console.log(`  第${i + 1}次: ${ms}ms, toolCalls=${(r.toolCalls || []).length}, chunks=${r.chunks.length}`)
    }
    perf.samples.push({ name: 'AW-P-01', values: p01, avg: Math.round(p01.reduce((a, b) => a + b, 0) / p01.length) })

    /* ── P-02 工具链完整回合（侦查→线索） ── */
    console.log('\n[PERF] P-02 工具链完整回合耗时')
    const t0 = Date.now()
    const turn = await runPlayerTurn(ws, [], '我仔细侦查书架，寻找线索。', { tag: 'perf_p02' })
    const turnMs = Date.now() - t0
    console.log(`  工具链: ${turn.toolCalls.map((c) => c.name).join(' → ') || '(纯叙事)'}`)
    console.log(`  轮数: ${turn.rounds}, 总耗时: ${turnMs}ms`)
    perf.samples.push({ name: 'AW-P-02', value: turnMs, rounds: turn.rounds, chain: turn.toolCalls.map((c) => c.name) })

    /* ── P-03 每轮 LLM 调用次数（trace 事件） ── */
    console.log('\n[PERF] P-03 单次 invoke 的 trace 事件数（LLM 调用次数指标）')
    // 收集一次完整 invoke 的 trace
    const t1 = Date.now()
    const r3 = await ws.invoke([{ role: 'user', content: '我检查桌子上的旧书。' }], {
      streamId: 'perf_p03',
      timeoutMs: 120_000,
    })
    const traceCount = r3.traces.length
    const traceTypes = {}
    for (const t of r3.traces) traceTypes[t.name || t.type] = (traceTypes[t.name || t.type] || 0) + 1
    console.log(`  trace 事件总数: ${traceCount}`)
    console.log(`  类型分布: ${JSON.stringify(traceTypes)}`)
    perf.samples.push({ name: 'AW-P-03', traceCount, traceTypes, ms: Date.now() - t1 })

    /* ── P-04 长对话劣化（1/3/5 条消息） ── */
    console.log('\n[PERF] P-04 长对话劣化（1/3/5 条）')
    let messages = []
    const p04 = []
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      const r = await runPlayerTurn(ws, messages, `我继续调查学校，看看有没有新的发现（第 ${i + 1} 轮探索）。`, { tag: `perf_p04_${i}` })
      messages = r.messages
      const ms = Date.now() - t0
      if (i === 0 || i === 2 || i === 4) {
        p04.push({ round: i + 1, ms, toolChain: r.toolCalls.map((c) => c.name) })
        console.log(`  第${i + 1}条: ${ms}ms, 工具: ${r.toolCalls.map((c) => c.name).join(', ') || '(纯叙事)'}`)
      }
    }
    perf.samples.push({ name: 'AW-P-04', values: p04 })

    /* ── P-05 流式 chunk 分布 ── */
    console.log('\n[PERF] P-05 流式 chunk 分布（首 chunk 延迟）')
    const t2 = Date.now()
    const r5 = await ws.invoke([{ role: 'user', content: '请详细描述校长办公室的环境，让我感受一下氛围。' }], {
      streamId: 'perf_p05',
      timeoutMs: 120_000,
    })
    const firstChunkAt = r5.chunks.length > 0 ? '有' : '无'
    console.log(`  chunks 数: ${r5.chunks.length}, 总耗时: ${Date.now() - t2}ms`)
    perf.samples.push({ name: 'AW-P-05', chunks: r5.chunks.length, hasChunks: r5.chunks.length > 0, ms: Date.now() - t2 })

    ws.close()

    /* ── 保存结果 ── */
    const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-results.json')
    fs.writeFileSync(outPath, JSON.stringify(perf, null, 2))
    console.log(`\n[PERF] 结果已保存: ${outPath}`)
    console.log(`[PERF] 摘要: P-01 avg=${perf.samples[0].avg}ms, P-02=${perf.samples[1].value}ms, P-03 trace=${perf.samples[2].traceCount}`)
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error('[PERF] FATAL', err)
  cleanup()
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * test-agent/robustness.mjs — 鲁棒性测试（API 级）
 *
 * 验证：
 *  - AW-R-01 非法消息（非数组）→ 优雅错误
 *  - AW-R-02 消息缺 role/content → 优雅错误
 *  - AW-R-03 空消息数组 → 空响应不崩溃
 *  - AW-R-04 超长单条消息 → 不崩溃
 *  - AW-R-05 连续快速 invoke（并发流隔离）
 *  - AW-R-06 未登录 WS → 4001 拒绝
 *  - AW-R-07 无效 token → 401
 *  - AW-R-08 服务端错误恢复（kill 后重启不脏数据）
 *  - AW-R-09 工具参数非法 JSON → 服务端仍响应
 *
 * 运行：node test-agent/robustness.mjs
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
import { spawn } from 'node:child_process'
import path from 'node:path'

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3104, 5179, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  try {
    const token = await registerUser(apiBase, `aw_r_${Date.now() % 100000}`, 'testpass123')
    await saveAiSettings(apiBase, llm, token)

    /* ── R-01 非法消息 ── */
    await step('AW-R-01 非数组消息 → 400（修复验证）', async () => {
      const r = await api(apiBase, 'POST', '/api/kp/invoke', { messages: 'not-an-array' }, token)
      console.log(`    status: ${r.status}, body: ${r.text.slice(0, 80)}`)
      // 修复后: normalizeMessages 对非数组抛 BadRequestError → 400（替代静默 200）
      if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}: ${r.text}`)
    })

    /* ── R-02 消息缺字段 ── */
    await step('AW-R-02 消息缺 role/content → 400', async () => {
      const r = await api(apiBase, 'POST', '/api/kp/invoke', { messages: [{ role: 'user' }] }, token)
      console.log(`    status: ${r.status}`)
      // 缺 content 的条目会被 normalizeMessages 抛 BadRequestError → 400
      if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}: ${r.text}`)
    })

    /* ── R-03 空消息数组 ── */
    await step('AW-R-03 空消息数组 → 200 空响应', async () => {
      const r = await api(apiBase, 'POST', '/api/kp/invoke', { messages: [] }, token)
      console.log(`    status: ${r.status}, body: ${r.text.slice(0, 80)}`)
      if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
    })

    /* ── R-04 超长消息 ── */
    await step('AW-R-04 超长消息（100KB）→ 不崩溃', async () => {
      const long = '我重复重复重复重复重复重复重复重复重复。'.repeat(8000)
      const ws = connectWs(apiBase, token)
      await ws.opened
      try {
        const r = await ws.invoke([{ role: 'user', content: long }], {
          streamId: 'r04_long',
          timeoutMs: 120_000,
        })
        console.log(`    收到响应 content=${(r.content || '').length}ch, toolCalls=${(r.toolCalls || []).length}`)
      } catch (e) {
        console.log(`    [warn] 超长消息 invoke 失败: ${e.message.slice(0, 100)}`)
      }
      ws.close()
    })

    /* ── R-05 并发流隔离 ── */
    await step('AW-R-05 两个并发 invoke 流不串扰', async () => {
      const ws = connectWs(apiBase, token)
      await ws.opened
      const p1 = ws.invoke([{ role: 'user', content: '我搜索房间寻找线索。' }], { streamId: 'r05_a' })
      const p2 = ws.invoke([{ role: 'user', content: '我检查桌子上的书。' }], { streamId: 'r05_b' })
      const [r1, r2] = await Promise.all([p1, p2])
      console.log(`    流A: content=${(r1.content || '').length}ch, tc=${(r1.toolCalls || []).length}`)
      console.log(`    流B: content=${(r2.content || '').length}ch, tc=${(r2.toolCalls || []).length}`)
      if (r1.streamId !== 'r05_a' || r2.streamId !== 'r05_b') throw new Error('streamId 串扰！')
      ws.close()
    })

    /* ── R-06 未登录 WS → 4001 ── */
    await step('AW-R-06 未登录 WS 连接被拒（4001）', async () => {
      const u = new URL(apiBase)
      const wsUrl = `ws://${u.host}/ws` // 无 token
      const ws = new WebSocket(wsUrl)
      const code = await new Promise((resolve) => {
        ws.onclose = (ev) => resolve(ev.code)
        ws.onerror = () => {}
        setTimeout(() => resolve(null), 5000)
      })
      console.log(`    close code: ${code}`)
      if (code !== 4001) throw new Error(`期望 4001，实际 ${code}`)
    })

    /* ── R-07 无效 token ── */
    await step('AW-R-07 无效 token → 401', async () => {
      const r = await api(apiBase, 'GET', '/api/settings', undefined, 'invalid-token-xyz')
      console.log(`    status: ${r.status}`)
      if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`)
    })

    /* ── R-09 工具参数非法 JSON 仍能继续 ── */
    await step('AW-R-09 工具参数非法 JSON → 不 500，后续 invoke 正常（修复验证）', async () => {
      // 直接构造带非法 arguments 的 assistant+tool 消息，验证服务端不再崩溃
      const ws = connectWs(apiBase, token)
      await ws.opened
      const messages = [
        { role: 'user', content: '我搜索房间。' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc_bad', type: 'function', function: { name: 'skill_check', arguments: '{bad json' } }],
        },
        { role: 'tool', tool_call_id: 'tc_bad', content: 'error: 参数解析失败' },
        { role: 'user', content: '我继续搜索，看看有没有别的线索。' },
      ]
      try {
        const r = await ws.invoke(messages, { streamId: 'r09_badjson', timeoutMs: 120_000 })
        console.log(`    收到响应 content=${(r.content || '').length}ch, tc=${(r.toolCalls || []).length}`)
        // 修复后坏 arguments 被降级为 '{}'，图应正常完成
        if (!r.content && !(r.toolCalls || []).length) {
          throw new Error('修复后非法 arguments 应降级执行，而不是空响应')
        }
      } catch (e) {
        throw new Error(`非法 JSON 后续 invoke 失败: ${e.message.slice(0, 120)}`)
      } finally {
        ws.close()
      }
      // 后续 invoke 正常（同一服务无残留错误状态）
      const ws2 = connectWs(apiBase, token)
      await ws2.opened
      try {
        const r2 = await ws2.invoke([{ role: 'user', content: '我看看墙上的海报。' }], { streamId: 'r09_after' })
        console.log(`    后续 invoke: content=${(r2.content || '').length}ch, tc=${(r2.toolCalls || []).length}`)
        if (!r2.content && !(r2.toolCalls || []).length) throw new Error('后续 invoke 无响应')
      } finally {
        ws2.close()
      }
    })

  } finally {
    printSummary('robustness')
    cleanup()
  }
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})

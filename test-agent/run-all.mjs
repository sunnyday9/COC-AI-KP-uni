#!/usr/bin/env node
/**
 * test-agent/run-all.mjs — 全部测试统一入口
 *
 * 当前套件只运行 room-protocol：服务端权威单轨的公开 REST/WS 旅程。
 * 旧的 scenario-*.mjs / robustness.mjs / performance.mjs 保留为历史材料，
 * 不再由此入口执行（它们依赖已退役的 kp:invoke 客户端循环）。
 *
 * 运行：node test-agent/run-all.mjs
 * 环境：AW_BASE_URL / AW_API_KEY / AW_MODEL（或本机 ZCode 配置自动读取）
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

const SCRIPTS = [
  ['room-protocol.mjs', '房间权威协议'],
]

let totalPass = 0
let totalFail = 0

for (const [script, label] of SCRIPTS) {
  console.log(`\n═══════════════════════════════════════`)
  console.log(`  [${label}] ${script}`)
  console.log(`═══════════════════════════════════════`)
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TEST_DIR, script)], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
  if (r === 0) {
    totalPass++
    console.log(`  ✔ ${label} 完成`)
  } else {
    totalFail++
    console.log(`  ✘ ${label} 失败 (exit ${r})`)
  }
}

console.log(`\n═══════════════════════════════════════`)
console.log(`[run-all] ${totalPass} 个场景完成, ${totalFail} 个失败`)
console.log(`[run-all] 详细结果见各场景输出; 汇总报告见 REPORT.md`)
process.exitCode = totalFail > 0 ? 1 : 0

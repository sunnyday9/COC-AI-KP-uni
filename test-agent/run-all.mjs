#!/usr/bin/env node
/**
 * test-agent/run-all.mjs — 全部测试统一入口
 *
 * 依次执行：
 *  1. scenario-investigate（调查链 12 用例）
 *  2. scenario-combat（战斗链 5 用例）
 *  3. scenario-sanity（SAN 链 5 用例）
 *  4. scenario-gating（门控 7 用例）
 *  5. scenario-rules（规则书补全 6 用例）
 *  6. robustness（鲁棒性 8 用例）
 *  7. performance（性能测量 5 项）
 *
 * 运行：node test-agent/run-all.mjs
 * 环境：AW_BASE_URL / AW_API_KEY / AW_MODEL（或本机 ZCode 配置自动读取）
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

const SCRIPTS = [
  ['scenario-investigate.mjs', '调查链'],
  ['scenario-combat.mjs', '战斗链'],
  ['scenario-sanity.mjs', 'SAN 链'],
  ['scenario-gating.mjs', '门控回归'],
  ['scenario-rules.mjs', '规则书补全'],
  ['robustness.mjs', '鲁棒性'],
  ['performance.mjs', '性能'],
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

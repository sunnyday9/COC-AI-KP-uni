#!/usr/bin/env node
/**
 * 金样本评测 CLI（T3 #39）。
 *
 * 用法：
 *   node --import training/eval/register-ts.ts training/eval/run-eval.ts \
 *     --endpoint https://api.example.com/v1 --model qwen3-8b [--api-key sk-...] \
 *     [--samples training/eval/golden-samples.json] [--out reports/baseline.json] \
 *     [--concurrency 4] [--limit 5] [--temperature 0.7] [--tag baseline] [--list]
 *
 * 凭据解析顺序：--api-key > EVAL_API_KEY 环境变量；--endpoint/--model > EVAL_BASE_URL/EVAL_MODEL。
 * 报告 JSON 落盘到 --out（相对仓库根），含两个指标、可分类失败明细与 24 工具覆盖。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEval, toolCoverage, type EvalReport } from './lib/runner.ts'
import type { EvalEndpoint } from './lib/client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function num(name: string, fallback: number): number {
  const v = arg(name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`--${name} 不是数字: ${v}`)
  return n
}

const samplesPath = resolve(REPO_ROOT, arg('samples') ?? 'training/eval/golden-samples.json')

if (flag('list')) {
  const { loadSamples: load } = await import('./lib/runner.ts')
  const samples = load(samplesPath)
  for (const s of samples) console.log(`${s.id.padEnd(34)} ${s.category.padEnd(18)} ${s.tools.join(',')}`)
  const uncovered = toolCoverage(samples).filter((c) => !c.covered)
  console.log(`\n共 ${samples.length} 条；未覆盖工具: ${uncovered.length ? uncovered.map((c) => c.tool).join(', ') : '（无，24 工具全覆盖）'}`)
  process.exit(0)
}

const baseUrl = arg('endpoint') ?? process.env.EVAL_BASE_URL
const model = arg('model') ?? process.env.EVAL_MODEL
const apiKey = arg('api-key') ?? process.env.EVAL_API_KEY
if (!baseUrl || !model) {
  console.error('缺少端点配置：需要 --endpoint/--model（或 EVAL_BASE_URL/EVAL_MODEL 环境变量）')
  process.exit(1)
}
const endpoint: EvalEndpoint = {
  baseUrl,
  apiKey: apiKey ?? '',
  model,
  temperature: num('temperature', 0.7),
  maxTokens: num('max-tokens', 2048),
  timeoutMs: num('timeout-ms', 120_000),
}

console.log(`金样本评测：${endpoint.model} @ ${endpoint.baseUrl}`)
const { report } = await runEval({
  endpoint,
  samplesPath,
  concurrency: num('concurrency', 4),
  limit: arg('limit') ? num('limit', 0) : undefined,
})

printReport(report)

const tag = arg('tag') ?? report.endpoint.model.replace(/[^\w.-]+/g, '_')
const date = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const out = resolve(REPO_ROOT, arg('out') ?? `training/eval/reports/${tag}-${date}.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(`\n报告已写入: ${out}`)

function printReport(r: EvalReport) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  console.log(`\n═══ 结果 ═══`)
  console.log(`样本: ${r.judgedCount}/${r.sampleCount} 判定完成（端点错误 ${r.endpointErrors.length}）`)
  console.log(`格式遵循率: ${pct(r.formatRate)}   裁定正确率: ${pct(r.verdictRate)}`)
  if (r.endpointErrors.length) {
    console.log(`\n── 端点错误（不计入比率）──`)
    for (const e of r.endpointErrors) console.log(`  ${e.id}: ${e.message.slice(0, 200)}`)
  }
  if (r.failures.length) {
    console.log(`\n── 失败明细（按分类）──`)
    for (const [cat, n] of Object.entries(r.failureBreakdown)) console.log(`  ${cat}: ${n}`)
    for (const f of r.failures) console.log(`\n  [${f.category}] ${f.id}\n    ${f.detail}`)
  }
  console.log(`\n── 工具覆盖 ──`)
  const uncovered = r.toolCoverage.filter((c) => !c.covered)
  console.log(uncovered.length ? `  未覆盖: ${uncovered.map((c) => c.tool).join(', ')}` : `  24 工具全覆盖`)
  console.log(`\ntokens: prompt ${r.usage.promptTokens} / completion ${r.usage.completionTokens}，用时 ${Math.round(r.durationMs / 1000)}s`)
}

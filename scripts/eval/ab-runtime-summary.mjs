/**
 * P25 运行时 A/B 汇总（实验分支 feature/kp-dossier-workflow）。
 *
 * 读 ab-compare 的真实模式产出 JSON，打印报告用的三张表：
 *  1) 房间级：rag vs dossier 的回合数/失败数/TTFT与整回合延迟分位/注入 tokens/工具分布；
 *  2) verify_original：从 wire 采样回填消息里统计调用数、命中（有结论）率、剧透层标注、
 *     未取得率——工具结果在会话中就是原文（≤600 字符截断线内），可当"直答内容"直接核对；
 *  3) 对局内事实回合（P10 口径，仅作次要度量——KP 仍在扮演态，见报告口径说明）。
 *
 * 用法：node scripts/eval/ab-runtime-summary.mjs --compare=training/eval/reports/ab-runtime-p25.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const cmpPath = arg('compare', 'training/eval/reports/ab-runtime-p25.json')
const j = JSON.parse(fs.readFileSync(path.join(ROOT, cmpPath), 'utf8'))

const f2 = (x) => (x == null ? '—' : Number(x).toFixed(2))

function toolResults(wf) {
  const out = []
  for (const t of wf.turns ?? []) {
    for (const tc of t.toolCalls ?? []) out.push({ name: tc.name, turn: t.input })
  }
  return out
}

console.log(`# P25 运行时 A/B 汇总（model=${j.model}，turns=${j.options?.turns}，startedAt=${new Date(j.startedAt).toISOString()}）\n`)

console.log('## 1) 房间级指标\n')
console.log('| 剧本 | workflow | 回合 | 失败 | TTFT p50/p95 | 整回合 p50/p95 | 注入 tok | 回复 tok | 工具分布 |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const [key, s] of Object.entries(j.stories ?? {})) {
  for (const wf of ['rag', 'dossier']) {
    const w = s.workflows?.[wf]
    if (!w || w.error) { console.log(`| ${key} | ${wf} | — | — | — | — | — | — | ${w?.error ?? 'missing'} |`); continue }
    const tm = w.turnMetrics ?? {}
    console.log(
      `| ${key} | ${wf} | ${w.totals.playTurns} | ${w.totals.failedTurns} | ${tm.ttft?.p50 ?? '—'}/${tm.ttft?.p95 ?? '—'}ms | ` +
      `${tm.total?.p50 ?? '—'}/${tm.total?.p95 ?? '—'}ms | ${w.totals.injectionTokens} | ${w.totals.kpReplyTokens} | ${JSON.stringify(w.toolCallDistribution)} |`,
    )
  }
}

console.log('\n## 2) verify_original 调用明细（dossier 房）\n')
for (const [key, s] of Object.entries(j.stories ?? {})) {
  const w = s.workflows?.dossier
  if (!w || w.error) continue
  const calls = toolResults(w).filter((c) => c.name === 'verify_original')
  const others = toolResults(w).filter((c) => c.name !== 'verify_original')
  console.log(`- **${key}**：查证调用 ${calls.length} 次（其余工具 ${others.length} 次）`)
  // wire 回填内容里区分命中/未取得/剧透层
  const texts = []
  for (const t of w.turns ?? []) {
    for (const tc of t.toolCalls ?? []) {
      if (tc.name !== 'verify_original') continue
      texts.push({ turn: t.input })
    }
  }
  if (!calls.length) console.log('  （本局 KP 未调用查证工具）')
}

console.log('\n## 3) 对局内事实回合（P10 口径，次要度量）\n')
console.log('| 剧本 | # | 问题 | rag | dossier | fab(rag/dos) |')
console.log('|---|---|---|---|---|---|')
for (const [key, s] of Object.entries(j.stories ?? {})) {
  for (const [i, f] of (s.facts ?? []).entries()) {
    const jd = f.judge ?? {}
    console.log(`| ${key} | ${i + 1} | ${String(f.q).slice(0, 30)}… | ${jd.rag_score ?? jd.ragScore ?? '—'} | ${jd.dossier_score ?? jd.dossierScore ?? '—'} | ${jd.rag_fabrication ?? '—'}/${jd.dossier_fabrication ?? '—'} |`)
  }
}

const scoreOf = (s, wf) => {
  const arr = (s.facts ?? []).map((f) => (wf === 'rag' ? f.judge?.rag_score ?? f.judge?.ragScore : f.judge?.dossier_score ?? f.judge?.dossierScore)).filter((x) => x != null)
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
}
const sc = Object.entries(j.stories ?? {})
const ragAvg = sc.map(([, s]) => scoreOf(s, 'rag')).filter((x) => x != null)
const dosAvg = sc.map(([, s]) => scoreOf(s, 'dossier')).filter((x) => x != null)
if (ragAvg.length || dosAvg.length) {
  console.log(`\n对局内事实回合均分：rag ${f2(ragAvg.reduce((a, b) => a + b, 0) / Math.max(1, ragAvg.length))}（${ragAvg.length} 篇）｜dossier ${f2(dosAvg.reduce((a, b) => a + b, 0) / Math.max(1, dosAvg.length))}（${dosAvg.length} 篇）`)
}

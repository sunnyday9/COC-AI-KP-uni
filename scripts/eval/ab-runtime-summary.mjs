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

console.log('\n## 2) verify_original 调用明细（dossier 房；内容取自 wire 回填）\n')
let allCalls = 0
let allHit = 0
let allMiss = 0
let allGated = 0
for (const [key, s] of Object.entries(j.stories ?? {})) {
  const w = s.workflows?.dossier
  if (!w || w.error) continue
  const calls = (w.turns ?? []).flatMap((t) => (t.toolCalls ?? []).filter((c) => c.name === 'verify_original').map((c) => ({ turn: t.input, content: (t.verifyResults ?? []) })))
  const contents = (w.turns ?? []).flatMap((t) => t.verifyResults ?? [])
  const miss = contents.filter((c) => c.includes('未取得')).length
  const gated = contents.filter((c) => c.includes('剧透层')).length
  const hit = contents.length - miss
  allCalls += calls.length
  allHit += hit
  allMiss += miss
  allGated += gated
  console.log(`- **${key}**：工具调用 ${calls.length} 次（其余工具 ${(w.turns ?? []).flatMap((t) => t.toolCalls ?? []).length - calls.length} 次）｜回填内容 ${contents.length} 条：命中 ${hit}、未取得 ${miss}、剧透层标注 ${gated}`)
  for (const [i, c] of contents.entries()) {
    console.log(`  ${i + 1}. ${c.replace(/\s+/g, ' ').slice(0, 150)}`)
  }
}
if (allCalls) {
  const rate = ((allHit / Math.max(1, allHit + allMiss)) * 100).toFixed(0)
  console.log(`\n合计：调用 ${allCalls} 次｜命中率 ${rate}%（命中 ${allHit} / 未取得 ${allMiss}）｜剧透层标注 ${allGated}`)
} else {
  console.log('\n本局 KP 未调用查证工具（工具分布见第 1 节）。')
}

console.log('\n## 3) 对局内事实回合（P10 口径，次要度量）\n')
console.log('| 剧本 | # | 问题 | rag | dossier | fab(rag/dos) |')
console.log('|---|---|---|---|---|---|')
for (const [key, s] of Object.entries(j.stories ?? {})) {
  for (const [i, f] of (s.facts ?? []).entries()) {
    const jd = f.judge ?? {}
    // 按臂标 invalid（`f.ragValid === false`）：空回复臂的分数不可信，显式打叉
    const rMark = f.ragValid === false ? '⛔invalid' : '—'
    const dMark = f.dosValid === false ? '⛔invalid' : '—'
    const r = f.ragValid === false ? rMark : (jd.rag_score ?? jd.ragScore ?? '—')
    const d = f.dosValid === false ? dMark : (jd.dossier_score ?? jd.dossierScore ?? '—')
    console.log(`| ${key} | ${i + 1} | ${String(f.q).slice(0, 30)}… | ${r} | ${d} | ${jd.rag_fabrication ?? '—'}/${jd.dossier_fabrication ?? '—'} |`)
  }
}
// 事实回合有效性守卫（M2 收尾）：空回复（房间已 end_game）的臂分不可用——
// 打 invalid 标记并从 §5 均分里**按臂**剔除，不把"没作答"平均成低分、也不连带
// 抹掉另一臂的有效数据（审查发现）。
for (const [key, s] of Object.entries(j.stories ?? {})) {
  const bad = ['rag', 'dossier'].filter((wf) => s.workflows?.[wf]?.factRound?.valid === false)
  if (bad.length) {
    console.log(`\n⚠️ **${key}**：${bad.map((wf) => `${wf} 臂 ${s.workflows[wf].factRound.emptyReplies}/${s.workflows[wf].factRound.turns} 个事实回合空回复（多为游玩段内 end_game 使房间已结束）`).join('；')}——该臂已从 §5 均分中剔除（另一臂不受影响）。`)
  }
}

/* ── M1-T8 新增：纹理 rubric 与检索补充注入统计 ── */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

console.log('\n## 4) 纹理 rubric（M1-T8，ADR-0007：叙事是否引用了原文可考的细节质地 1–5）\n')
console.log('| 剧本 | 回合 | rag | dossier | note |')
console.log('|---|---|---|---|---|')
const texRag = []
const texDos = []
for (const [key, s] of Object.entries(j.stories ?? {})) {
  for (const [i, t] of (s.texture ?? []).entries()) {
    const jt = t.judge ?? {}
    const r = jt.rag_texture
    const d = jt.dossier_texture
    if (r != null) texRag.push(Number(r))
    if (d != null) texDos.push(Number(d))
    console.log(`| ${key} | ${t.turn ?? i + 1} | ${r ?? '—'} | ${d ?? '—'} | ${String(jt.note ?? jt.judgeError ?? '').replace(/\|/g, '/').slice(0, 60)} |`)
  }
}
if (texRag.length || texDos.length) {
  const mr = mean(texRag)
  const md = mean(texDos)
  const gap = mr != null && md != null ? md - mr : null
  console.log(`\n纹理均分：rag ${f2(mr)}（n=${texRag.length}）｜dossier ${f2(md)}（n=${texDos.length}）｜差 ${gap == null ? '—' : (gap >= 0 ? '+' : '') + gap.toFixed(2)}`)
}

console.log('\n## 5) 检索补充注入统计（M1-T8，wire 采样）\n')
console.log('| 剧本 | workflow | 有补充的回合 | 补充字符均量 |')
console.log('|---|---|---|---|')
for (const [key, s] of Object.entries(j.stories ?? {})) {
  for (const wf of ['rag', 'dossier']) {
    const w = s.workflows?.[wf]
    if (!w || w.error) continue
    const turns = (w.turns ?? []).filter((t) => !t.skipped)
    // 从 supplementBlocks（小节原文）算，不看 supplementChars 派生字段——
    // 后者在修复前的那次运行里是 0（字段名取错），旧数据仍可由此重算
    const withSup = turns.filter((t) => (t.supplementBlocks ?? []).length > 0 || (t.supplementChars ?? 0) > 0)
    const total = turns.reduce((a, t) => a + (t.supplementChars ?? 0) || 0, 0)
    const totalFromBlocks = turns.reduce(
      (a, t) => a + (t.supplementBlocks ?? []).reduce((x, b) => x + String(b).length, 0),
      0,
    )
    const denom = Math.max(total, totalFromBlocks)
    console.log(`| ${key} | ${wf} | ${withSup.length}/${turns.length} | ${withSup.length ? Math.round(denom / withSup.length) : '—'} |`)
  }
}

const scoreOf = (s, wf) => {
  // 逐条按**该臂自己**的有效性取样（审查发现：一臂 invalid 不该连带抹掉另一臂数据）。
  // 同篇两臂都有效时两侧等价；只有一臂有效时另一臂的故事级值仍可算。
  const arr = (s.facts ?? [])
    .filter((f) => (wf === 'rag' ? f.ragValid !== false : f.dosValid !== false))
    .map((f) => (wf === 'rag' ? f.judge?.rag_score ?? f.judge?.ragScore : f.judge?.dossier_score ?? f.judge?.dossierScore))
    .filter((x) => x != null)
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
}
const sc = Object.entries(j.stories ?? {})
const ragAvg = sc.map(([, s]) => scoreOf(s, 'rag')).filter((x) => x != null)
const dosAvg = sc.map(([, s]) => scoreOf(s, 'dossier')).filter((x) => x != null)
if (ragAvg.length || dosAvg.length) {
  console.log(`\n对局内事实回合均分：rag ${f2(ragAvg.reduce((a, b) => a + b, 0) / Math.max(1, ragAvg.length))}（${ragAvg.length} 篇）｜dossier ${f2(dosAvg.reduce((a, b) => a + b, 0) / Math.max(1, dosAvg.length))}（${dosAvg.length} 篇）`)
}

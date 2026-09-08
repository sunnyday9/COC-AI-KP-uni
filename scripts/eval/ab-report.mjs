/**
 * A/B report generator — rag workflow vs dossier workflow (real-LLM edition).
 * Consumes the ab-compare results JSON (--out) and writes a per-story +
 * aggregate markdown report to docs/experiments/.
 *
 * Usage:
 *   node scripts/eval/ab-report.mjs --in training/eval/reports/ab-real-<tag>.json
 *       [--out docs/experiments/dossier-vs-rag-real-<date>.md]
 *       [--label "dossier-vs-rag-real-2026-09-08"]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const inPath = path.join(ROOT, arg('in', ''))
if (!fs.existsSync(inPath)) {
  console.error(`results file not found: ${inPath}`)
  process.exit(1)
}
const data = JSON.parse(fs.readFileSync(inPath, 'utf8'))
const outPath = path.join(ROOT, arg('out', `docs/experiments/${arg('label', 'dossier-vs-rag-real')}.md`))

const s2 = (v) => (v == null ? '-' : String(Math.round(v)))
const num = (v) => (typeof v === 'number' ? v : null)
const fmtMs = (v) => (v == null ? '-' : `${Math.round(v)}ms`)

/** Pool a metric across the executed play turns of one workflow across stories. */
function poolPct(stories, metric, p, workflow) {
  const vals = []
  for (const s of Object.values(stories)) {
    const wf = s.workflows?.[workflow]
    if (!wf?.turns) continue
    for (const t of wf.turns) {
      const v = num(t[metric])
      if (v != null && !t.skipped) vals.push(v)
    }
  }
  vals.sort((a, b) => a - b)
  if (!vals.length) return null
  const idx = Math.min(vals.length - 1, Math.ceil((p / 100) * vals.length) - 1)
  return Math.round(vals[Math.max(0, idx)])
}

function aggregate(stories) {
  const agg = { ttft: {}, total: {}, kpTokens: {}, injection: {}, empty: {}, failed: 0, skipped: 0, played: 0, tools: { rag: {}, dossier: {} } }
  for (const w of ['rag', 'dossier']) {
    agg.ttft[w] = {}
    agg.total[w] = {}
    agg.kpTokens[w] = {}
    for (const p of [50, 95, 99]) {
      agg.ttft[w][p] = poolPct(stories, 'ttftMs', p, w)
      agg.total[w][p] = poolPct(stories, 'totalMs', p, w)
      agg.kpTokens[w][p] = poolPct(stories, 'kpReplyTokens', p, w)
    }
  }
  for (const s of Object.values(stories)) {
    for (const w of ['rag', 'dossier']) {
      const wf = s.workflows?.[w]
      if (!wf?.totals) continue
      agg.played += wf.totals.playTurns ?? 0
      agg.failed += wf.totals.failedTurns ?? 0
      agg.skipped += wf.totals.skippedTurns ?? 0
      agg.empty[w] = (agg.empty[w] ?? 0) + (wf.totals.emptyInjectionTurns ?? 0)
      agg.injection[w] = (agg.injection[w] ?? 0) + (wf.totals.injectionTokens ?? 0)
      for (const [name, n] of Object.entries(wf.toolCallDistribution ?? {})) {
        agg.tools[w][name] = (agg.tools[w][name] ?? 0) + n
      }
    }
  }
  return agg
}

const stories = data.stories || {}
const agg = aggregate(stories)
const dateStr = new Date(data.updatedAt ?? data.startedAt ?? Date.now()).toISOString().slice(0, 10)

const L = []
L.push(`# dossier workflow vs rag workflow 真实 LLM A/B 对比报告（${dateStr}）`)
L.push('')
L.push(`> 实验分支 feature/kp-dossier-workflow（main 的 embedding RAG 原样保留为对照基准）。`)
L.push(`> 模式：**真实 LLM**（${data.model} @ ${data.baseUrl}）；报告自动生成自 \`${arg('in', '')}\`。`)
L.push('')
L.push('## 结论速览')
L.push('')
L.push('- **剧本理解（事实一致性）**：见各篇事实得分表；判断依据 = 对局后 5 问 ground-truth 追问 + 同模型 LLM-as-judge（1-5 忠实度）。')
L.push('- **对话性能（TTFT/总延迟）**：见汇总表（每回合 p50/p95/p99）。')
L.push('- **token 消耗**：知识注入量每回合实测（rag = wire 采样 rag_context；dossier = 当前场景档案块）；KP 回复长度对比。')
L.push('- **工具调用分布**：dossier 查证工具（scene_list/scene_dossier/lexical_search）触发率 vs rag 无查证。')
L.push('')
L.push('## 方法口径')
L.push('')
L.push(`- 每篇剧本：同房间同输入脚本（10 行动回合，见下）+ 事实追问 5 问/篇；rag 与 dossier 两个 solo 房各跑一遍，起始角色卡相同。`)
L.push(`- 行动回合脚本（workflow 无关的通用 COC beat）：${JSON.stringify(data.playScript ?? [])}`)
L.push(`- **TTFT** = 玩家消息发出到首个 \`kp_chunk\` 流式帧到达（服务端 \`KP_CHUNK_STREAM=1\`，LLM 内容增量逐帧广播；不含推理/工具前置——即用户感知首字延迟）。`)
L.push(`- **总延迟** = 消息发出到整回合帧流静默（含工具链往返）。opening 单独计。`)
L.push(`- **知识注入 token**：rag 每回合 = wire 采样 rag_context 实测；dossier 每回合 = 档案当前场景块（scene name+description+sceneText）估算（中文 ≈0.9 tok/字）。两槽位在 system 提示中同级。`)
L.push(`- **事实一致性**：每篇 5 个 ground-truth 问题（从剧本原文出、带原文引证）；对局后以普通对话追问两房，回答由同一模型（${data.model}）按 1-5 盲评忠实度 + fabrication 判定（编造 NPC/地点/真相）。口径 = LLM-as-judge，样例可人工复核（回答全文在数据 JSON）。`)
L.push(`- 模型为推理型（reasoning→content）；dossier 生成/档案抽取与 judge 调用走非流式（超时上限 240s），KP 回合全部流式无固定超时。`)
L.push('')
L.push('## 汇总表（全部剧本 pooled，play 回合）')
L.push('')
L.push('| 指标 | rag | dossier | 差值(dossier−rag) |')
L.push('|---|---|---|---|')
const tdiff = (w1, w2) => `${w2 - w1 >= 0 ? '+' : ''}${Math.round(w2 - w1)}ms`
L.push(`| TTFT p50 | ${fmtMs(agg.ttft.rag[50])} | ${fmtMs(agg.ttft.dossier[50])} | ${num(agg.ttft.rag[50]) != null && num(agg.ttft.dossier[50]) != null ? tdiff(agg.ttft.rag[50], agg.ttft.dossier[50]) : '-'} |`)
L.push(`| TTFT p95 | ${fmtMs(agg.ttft.rag[95])} | ${fmtMs(agg.ttft.dossier[95])} | ${num(agg.ttft.rag[95]) != null && num(agg.ttft.dossier[95]) != null ? tdiff(agg.ttft.rag[95], agg.ttft.dossier[95]) : '-'} |`)
L.push(`| TTFT p99 | ${fmtMs(agg.ttft.rag[99])} | ${fmtMs(agg.ttft.dossier[99])} | ${num(agg.ttft.rag[99]) != null && num(agg.ttft.dossier[99]) != null ? tdiff(agg.ttft.rag[99], agg.ttft.dossier[99]) : '-'} |`)
L.push(`| 整回合 p50 | ${fmtMs(agg.total.rag[50])} | ${fmtMs(agg.total.dossier[50])} | ${num(agg.total.rag[50]) != null && num(agg.total.dossier[50]) != null ? tdiff(agg.total.rag[50], agg.total.dossier[50]) : '-'} |`)
L.push(`| 整回合 p95 | ${fmtMs(agg.total.rag[95])} | ${fmtMs(agg.total.dossier[95])} | ${num(agg.total.rag[95]) != null && num(agg.total.dossier[95]) != null ? tdiff(agg.total.rag[95], agg.total.dossier[95]) : '-'} |`)
L.push(`| 知识注入总量（tok，全部回合） | ${agg.injection.rag ?? 0} | ${agg.injection.dossier ?? 0} | |`)
L.push(`| 空注入回合（无知识兜底） | ${agg.empty.rag ?? 0} | ${agg.empty.dossier ?? 0} | |`)
L.push(`| 回合数（executed/failed/skipped） | ${agg.played / 2 || 0} / ${agg.failed} / ${agg.skipped} | | |`)
L.push('')
L.push('\\* 注：注入量按字符估算非精确 token 数；逐篇值见下。')
L.push('')
L.push('## 工具调用分布（全部回合 pooled）')
L.push('')
L.push('| 工具 | rag | dossier |')
L.push('|---|---|---|')
const toolNames = new Set([...Object.keys(agg.tools.rag), ...Object.keys(agg.tools.dossier)]).size ? [...new Set([...Object.keys(agg.tools.rag), ...Object.keys(agg.tools.dossier)])] : []
for (const name of toolNames.sort()) {
  L.push(`| ${name} | ${agg.tools.rag[name] ?? 0} | ${agg.tools.dossier[name] ?? 0} |`)
}
L.push('')
L.push('## 事实一致性汇总（全部剧本 5 问/篇）')
L.push('')
let factStats = { rag: { n: 0, sum: 0, fab: 0, judged: 0 }, dossier: { n: 0, sum: 0, fab: 0, judged: 0 } }
for (const s of Object.values(stories)) {
  for (const f of s.facts ?? []) {
    const j = f.judge ?? {}
    for (const w of ['rag', 'dossier']) {
      const score = num(j[`${w}_score`] ?? j[`${w}Score`])
      const fab = j[`${w}_fabrication`] ?? j[`${w}Fabrication`]
      factStats[w].n += 1
      if (score != null) { factStats[w].sum += score; factStats[w].judged += 1 }
      if (fab === true) factStats[w].fab += 1
    }
  }
}
L.push(`| 指标 | rag | dossier |`)
L.push('|---|---|---|')
const fcell = (w) => {
  const st = factStats[w]
  return st.judged ? `${(st.sum / st.judged).toFixed(2)}（judged ${st.judged}/${st.n}，fab ${st.fab}）` : `n/a（judged 0/${st.n}）`
}
L.push(`| 平均忠实度 1-5 | ${fcell('rag')} | ${fcell('dossier')} |`)
L.push('')
L.push('---')
L.push('')

for (const [key, s] of Object.entries(stories)) {
  const rag = s.workflows?.rag
  const dos = s.workflows?.dossier
  L.push(`## ${key}`)
  L.push('')
  if (s.error || !rag || !dos) {
    L.push(`> ⚠️ 本篇未跑完：${s.error ?? 'workflow 缺失'}`)
    L.push('')
    continue
  }
  L.push(`- 剧本原文 ${s.setup?.storyChars ?? '?'} 字符；rag 索引 ${s.setup?.ragIndex?.chunkCount ?? '-'} chunks（${s.setup?.ragIndex?.ok ? 'ok' : 'FAILED'}）；档案 ${JSON.stringify(s.setup?.dossierGen?.data ?? {})}（生成 ${s.setup?.dossierGen?.ms ?? '-'}ms）`)
  const factAvg = { rag: null, dossier: null }
  for (const w of ['rag', 'dossier']) {
    const judged = (s.facts ?? []).filter((f) => num(f.judge?.[`${w}_score`] ?? f.judge?.[`${w}Score`]) != null)
    if (judged.length) factAvg[w] = (judged.reduce((a, f) => a + (f.judge[`${w}_score`] ?? f.judge[`${w}Score`]), 0) / judged.length).toFixed(2)
  }
  L.push(`- 事实一致性平均分（LLM-as-judge 1-5）：rag **${factAvg.rag ?? 'n/a'}** vs dossier **${factAvg.dossier ?? 'n/a'}**（judged ${(s.facts ?? []).length} 问）`)
  L.push('')
  L.push('| 指标 | rag | dossier |')
  L.push('|---|---|---|')
  const row = (label, get) => L.push(`| ${label} | ${get(rag)} | ${get(dos)} |`)
  row('opening 总延迟', (w) => fmtMs(w.openingMs))
  row('TTFT p50 / p95 / p99', (w) => `${fmtMs(w.turnMetrics?.ttft?.p50)} / ${fmtMs(w.turnMetrics?.ttft?.p95)} / ${fmtMs(w.turnMetrics?.ttft?.p99)}`)
  row('整回合 p50 / p95', (w) => `${fmtMs(w.turnMetrics?.total?.p50)} / ${fmtMs(w.turnMetrics?.total?.p95)}`)
  row('KP 回复 token p50', (w) => s2(w.turnMetrics?.kpReplyTokens?.p50))
  row('回合数（exec/fail/skip）', (w) => `${w.totals?.playTurns ?? '-'} / ${w.totals?.failedTurns ?? '-'} / ${w.totals?.skippedTurns ?? '-'}`)
  row('知识注入总量（tok）', (w) => s2(w.totals?.injectionTokens))
  row('注入/回合 p50（tok）', (w) => s2(w.turnMetrics?.injectionTokens?.p50))
  row('空注入回合', (w) => s2(w.totals?.emptyInjectionTurns))
  row('工具调用', (w) => Object.entries(w.toolCallDistribution ?? {}).map(([n, c]) => `${n}×${c}`).join(' ') || '—')
  L.push('')
  const facts = s.facts ?? []
  if (facts.length) {
    L.push('| 事实问 | rag 分/fab | dossier 分/fab | judge note |')
    L.push('|---|---|---|---|')
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]
      const j = f.judge ?? {}
      L.push(`| ${String(f.q).slice(0, 42)}… | ${j.rag_score ?? j.ragScore ?? '-'} / ${j.rag_fabrication ? 'fab' : '-'} | ${j.dossier_score ?? j.dossierScore ?? '-'} / ${j.dossier_fabrication ? 'fab' : '-'} | ${String(j.note ?? j.judgeError ?? '').slice(0, 80)} |`)
    }
    L.push('')
    const f0 = facts[0]
    if (f0) {
      L.push(`**示例追问（第 1 问）**：${f0.q}`)
      L.push('')
      L.push(`- rag 房回答：${String(f0.ragReply ?? '').slice(0, 260)}`)
      L.push(`- dossier 房回答：${String(f0.dosReply ?? '').slice(0, 260)}`)
      L.push('')
    }
  }
  L.push('---')
  L.push('')
}

L.push('## 数据与复现')
L.push('')
L.push(`- 原始数据 JSON：\`${arg('in', '')}\``)
L.push(`- 对局 harness：\`scripts/eval/ab-compare.mjs\`（真实模式 env：AB_AI_BASE_URL/AB_AI_API_KEY/OPENCODE_SESSION/MOCK_AI=0）`)
L.push(`- 事实清单：\`scripts/eval/ab-facts/*.json\`（每篇 5 问 ground-truth + 原文引证）`)
L.push(`- 报告生成：\`node scripts/eval/ab-report.mjs --in <json> --out <md>\``)
L.push('')
L.push('## 已知局限')
L.push('')
L.push('- judge 与被评对象同为 mimo-v2.5（自评偏差可能）；回答全文留档可人工复核。')
L.push('- dossier 注入量为档案块的字符估算；rag 注入量为 wire 采样原文。')
L.push('- TTFT 含工具链前置：dossier 回合若先查证（scene_dossier 等）再叙事，首字自然更晚——这正是被测量的行为差异。')
L.push('- mimo 为推理模型：reasoning 阶段不产生 content chunk；TTFT 测量的是首个可见叙事 token。')

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, L.join('\n'), 'utf8')
console.log(`report written: ${outPath}`)

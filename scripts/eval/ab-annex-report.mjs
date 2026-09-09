/**
 * P20 报告聚合器：读取 ab-annex-batch 输出的逐篇 JSON（ab-recon-annex-<key>.json，
 * 含 gen 响应 + annexFile 明细 + 探针得分），打印供 docs 报告使用的 digest。
 * 用法：node scripts/eval/ab-annex-report.mjs [reportsDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const dir = process.argv[2] ?? path.join(ROOT, 'training', 'eval', 'reports')

const files = fs.readdirSync(dir).filter((f) => f.startsWith('ab-recon-annex-') && f.endsWith('.json'))
const stories = []
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  for (const s of Object.values(raw.stories ?? {})) stories.push({ key: s.key, story: s })
}
stories.sort((a, b) => (a.story.startedAt ?? 0) - (b.story.startedAt ?? 0))

let poolProbes = 0
let poolScore = 0
let poolFab = 0
const rows = []
for (const { key, story } of stories) {
  const g = story.gen ?? {}
  const af = story.annexFile
  const scored = (story.probes ?? []).filter((p) => p.judge?.score != null)
  const avg = scored.length ? (scored.reduce((s, p) => s + p.judge.score, 0) / scored.length).toFixed(2) : '—'
  const fab = scored.filter((p) => p.judge.fabrication).length
  poolProbes += scored.length
  poolScore += scored.reduce((s, p) => s + p.judge.score, 0)
  poolFab += fab
  const byCat = {}
  for (const p of scored) {
    const c = p.cat ?? 'fact'
    byCat[c] = byCat[c] ?? []
    byCat[c].push(`${p.judge.score}${p.judge.fabrication ? '/fab' : ''}`)
  }
  const pendingTypes = {}
  const pendingNames = []
  for (const p of af?.pending ?? []) {
    pendingTypes[p.type] = (pendingTypes[p.type] ?? 0) + 1
    pendingNames.push(p.name)
  }
  const mergedTypes = {}
  for (const m of af?.merged ?? []) mergedTypes[m.type] = (mergedTypes[m.type] ?? 0) + 1
  const drops = (af?.images ?? []).filter((i) => !i.kept).map((i) => `p${i.page}:${i.dropReason?.slice(0, 14)}`).join('; ')
  const kept = (af?.images ?? []).filter((i) => i.kept).map((i) => `p${i.page}:${i.kind}${i.transcript ? `(${i.transcript.length}字)` : ''}`).join('; ')
  rows.push({
    key,
    gen: g.ok ? { scenes: g.scenes, clues: g.clues, npcs: g.npcs, trans: g.transitions, events: g.events, truths: g.truths, endings: g.endings, cov: g.coveragePct, warns: (g.warnings ?? []).length } : { err: g.error },
    annex: { imgs: g.annexImages, drops: g.annexDrops, failed: g.annexFailed, pending: g.annexPending, tr: g.annexTransitions, clues: g.annexClues, note: af?.note },
    annexDetail: { kept, drops, pendingTypes, pendingNames: pendingNames.join('、'), mergedTypes },
    avg, fab, judged: scored.length, byCat,
    ms: Math.round((story.elapsedMs ?? 0) / 1000),
  })
}
console.log('== gen/annex 汇总 ==')
for (const r of rows) {
  const g = r.gen
  console.log(
    `${r.key}\n  gen=${g.err ? `FAIL ${g.err}` : `scenes ${g.scenes} / clues ${g.clues} / npcs ${g.npcs} / trans ${g.trans} / events ${g.events} / truths ${g.truths} / endings ${g.endings} / cov ${g.cov}% / warns ${g.warns}`}\n  annex=${JSON.stringify(r.annex)}\n  kept=${r.annexDetail.kept || '—'}\n  drops=${r.annexDetail.drops || '—'}\n  pending=${JSON.stringify(r.annexDetail.pendingTypes)}${r.annexDetail.pendingNames ? ' → ' + r.annexDetail.pendingNames : ''}\n  merged=${JSON.stringify(r.annexDetail.mergedTypes)}`,
  )
}
console.log('\n== 直答得分 ==')
for (const r of rows) {
  const cats = Object.entries(r.byCat).map(([c, v]) => `${c}: ${v.join(' ')}`).join(' | ')
  console.log(`${r.key}  avg=${r.avg}（judged ${r.judged}，fab ${r.fab}，${r.ms}s）  ${cats}`)
}
console.log(`\npooled: avg ${(poolScore / poolProbes).toFixed(2)}（judged ${poolProbes}，fab ${poolFab}）`)

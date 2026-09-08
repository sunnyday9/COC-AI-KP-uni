/**
 * Dossier v2 重建测试驱动（真实 LLM）。
 *
 * 检验用户级目标："仅凭档案 JSON 能否反推出剧本的剧情/时间线/人物关系/场景切换"。
 *
 * 流程（每篇故事）：
 *  1) spawn 服务端（临时 DATA_DIR；DOSSIER_DATA_DIR = training/eval/dossier-cache，
 *     档案落盘可复核）→ 上传剧本 → POST /api/dossier/:id/generate 生成 **v2** 档案
 *     （schema v2 = scenes/clues/npcs + transitions/events/relations/meta + 质量告警）；
 *  2) 档案问答探针（直答模式，不经对局——规避"KP 把追问当行动输入"的 5 问探针缺陷）：
 *     把整份档案 JSON 放进 context，逐问作答；judge 对照原文引证(refQuote)打 1-5 忠实分
 *     + fabrication 判定；
 *  3) 探针集合 = scripts/eval/ab-facts/<key>.json（旧 5 问，可对比 v1 档案对局分）
 *     + scripts/eval/ab-facts/v2/<key>.json（时间线/关系/场景图/细节/真相分类问）。
 *
 * 输出：--out JSON（每篇含生成质量字段 + 每问答案与 judge 分）。
 *
 * env（真实模式）：MOCK_AI=0 AB_AI_BASE_URL=... AB_AI_API_KEY=... AB_AI_MODEL=mimo-v2.5
 * OPENCODE_SESSION=...；密钥只从环境变量读。
 * 用法：MOCK_AI=0 AB_AI_* OPENCODE_SESSION=x node scripts/eval/ab-reconstruct.mjs \
 *   --keys=早八要迟到了,巫_20220928_nocom --out=training/eval/reports/ab-reconstruct-<ts>.json
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Agent } from 'undici'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const API_BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? 3280}`
const MOCK = process.env.MOCK_AI === '1'
const REAL_CFG = {
  baseUrl: process.env.AB_AI_BASE_URL ?? '',
  apiKey: process.env.AB_AI_API_KEY ?? '',
  model: process.env.AB_AI_MODEL ?? 'mimo-v2.5',
}
const FACTS_DIR = path.join(ROOT, 'scripts', 'eval', 'ab-facts')
const STORY_DIR = path.join(ROOT, 'AI-COC-KP Story Document', 'stories')
const CACHE_DIR = path.join(ROOT, 'training', 'eval', 'dossier-cache')
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
const origFetch = globalThis.fetch
globalThis.fetch = (url, opts = {}) => origFetch(url, { ...opts, dispatcher })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
const estTokens = (t) => {
  const s = String(t ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.round(cjk * 0.9 + (s.length - cjk) / 3.5)
}

const children = []
let serverLogs = ''
async function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGTERM')
    } catch { /* ignore */ }
  }
  await sleep(800)
}

/* ── 直连 LLM（档案问答 + judge）── */
async function callLLM(messages, maxTokens = 800) {
  const res = await fetch(`${REAL_CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${REAL_CFG.apiKey}`,
      ...(process.env.OPENCODE_SESSION ? { 'x-opencode-session': process.env.OPENCODE_SESSION } : {}),
    },
    body: JSON.stringify({ model: REAL_CFG.model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).choices?.[0]?.message?.content ?? ''
}

function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

async function withRetry(fn, label) {
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fn() } catch (e) { lastErr = e.message || String(e) }
    if (attempt === 0) { console.log(`  [retry] ${label}: ${lastErr}`); await sleep(3000) }
  }
  return { judgeError: `after retry: ${lastErr}` }
}

/** 档案直答：档案 JSON（超长则压缩 sceneText）→ 答案。 */
function buildDossierPayload(dossier) {
  const full = JSON.stringify(dossier)
  if (full.length <= 22_000) return { payload: full, variant: 'full' }
  const slim = {
    ...dossier,
    scenes: (dossier.scenes ?? []).map((s) => ({
      ...s,
      sceneText: String(s.sceneText ?? '').slice(0, 900),
      // 截断标注，避免把"档案查不到"误判为"档案缺内容"
    })),
  }
  return { payload: JSON.stringify(slim), variant: `slim(sceneText≤900) full=${full.length}chars`, }
}

const ANSWER_SYSTEM =
  '你是剧本档案问答器。用户给你一份从跑团模组整理出的结构化档案 JSON，随后提出关于该剧本的问题。' +
  '你只依据档案内容回答，不得编造；档案中没有的信息，明确回答"档案中无此信息"。回答用中文、可直接引用档案原文。'

async function answerFromDossier(dossier, q) {
  const { payload, variant } = buildDossierPayload(dossier)
  const raw = await withRetry(() => callLLM([
    { role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content: `【档案】\n${payload}\n\n【问题】${q}` },
  ], 900), 'answer')
  return { raw, variant }
}

async function judgeAnswer(storyTitle, probe, answer) {
  const ask =
    `你是剧本事实一致性评审。剧本《${storyTitle}》。一个"档案问答器"只凭剧本的结构化档案（不含剧本原文）回答了下面的问题，` +
    `请对照剧本原文依据判断它的回答是否忠于剧本。\n\n` +
    `【问题】${probe.q}\n` +
    `【剧本原文依据】${probe.refQuote}\n` +
    `【要点】${probe.ref}\n\n` +
    `【档案问答器回答】\n${String(answer ?? '（无回答）').slice(0, 1000)}\n\n` +
    `按 1-5 打忠实度分（5=要点全中且准确；3=大体正确但有含糊/细节偏离；1=答非所问、与依据矛盾、或档案缺该信息而未能回答）。` +
    `fabrication=true 表示回答含剧本中不存在或被依据否定的内容。档案缺少该信息导致"档案中无此信息"式的如实回答时，打 1 分且 fabrication=false（这暴露的正是档案覆盖缺口）。` +
    `只输出 JSON：{"score":1-5,"fabrication":true/false,"note":"≤60字"}`
  const raw = await withRetry(() => callLLM([{ role: 'user', content: ask }], 2000), 'judge')
  if (raw && typeof raw === 'object' && raw.judgeError) return raw
  const j = parseJudgeJson(raw)
  if (j && j.score != null) return j
  return { judgeError: `unparseable judge output: ${String(raw ?? '').slice(0, 120)}` }
}

async function main() {
  const keys = (arg('keys', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!keys.length) { console.error('--keys=key1,key2 required'); process.exit(1) }
  if (!MOCK && (!REAL_CFG.baseUrl || !REAL_CFG.apiKey)) { console.error('real mode needs AB_AI_BASE_URL + AB_AI_API_KEY'); process.exit(1) }
  const outPath = arg('out', `training/eval/reports/ab-reconstruct-${Date.now()}.json`)
  const out = { mode: MOCK ? 'mock' : 'real', model: REAL_CFG.model, startedAt: Date.now(), stories: {} }

  // 服务端：临时 DATA_DIR，档案落 CACHE_DIR（可复核）
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ab-recon-'))
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      MOCK_AI: MOCK ? '1' : '0',
      PORT: String(process.env.E2E_PORT ?? 3280),
      JWT_SECRET: 'ab-secret-change-me',
      DATA_DIR: path.join(tmpRoot, 'data'),
      RAG_DATA_DIR: path.join(tmpRoot, 'rag'),
      DOSSIER_DATA_DIR: CACHE_DIR,
      UPLOADS_DIR: path.join(tmpRoot, 'uploads'),
      LLM_TIMEOUT_MS: '240000',
      KP_WIRE_SAMPLING: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (serverLogs += d))
  child.stderr.on('data', (d) => (serverLogs += d))
  children.push(child)
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) }); if ([200, 401].includes(r.status)) break } catch { /* retry */ }
    await sleep(1000)
  }
  const uname = `abrecon_${Date.now()}`
  await fetch(`${API_BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: 'ab-pass-word' }) })
  const login = await fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: 'ab-pass-word' }) })
  const { token, userId } = await login.json()
  if (!MOCK) {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ai: { provider: 'openai_compatible', baseUrl: REAL_CFG.baseUrl, apiKey: REAL_CFG.apiKey, model: REAL_CFG.model, temperature: 0.7, maxTokens: 2048 }, rag: { useEmbeddings: true, provider: 'builtin', model: 'text-embedding-3-small', useGraphRAG: false, extractionModel: '' } }),
    })
    if (res.status !== 200) throw new Error(`settings: ${res.status}`)
  }

  for (const key of keys) {
    const t0 = Date.now()
    // 探针 = 旧 5 问（若存在）+ v2 分类问（若存在）
    const probes = []
    for (const dir of ['', 'v2']) {
      const f = path.join(FACTS_DIR, dir, `${key}.json`)
      if (fs.existsSync(f)) probes.push(...JSON.parse(fs.readFileSync(f, 'utf8')).facts.map((x) => ({ ...x, src: dir || 'v1' })))
    }
    if (!probes.length) { console.log(`[skip] ${key}: no probes in ab-facts`); continue }
    const story = { key, storyName: probes[0]?.story ?? key, probes: [], startedAt: Date.now() }
    out.stories[key] = story
    // 找剧本文件：probes[0].file 或 <key>.pdf
    const file = path.join(STORY_DIR, probes[0].file ?? `${key}.pdf`)
    if (!fs.existsSync(file)) { console.log(`[skip-missing] ${key}: ${file}`); continue }

    const fd = new FormData()
    fd.append('file', new Blob([fs.readFileSync(file)], { type: 'application/octet-stream' }), path.basename(file))
    const up = await fetch(`${API_BASE}/api/stories/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd, signal: AbortSignal.timeout(180_000) })
    const upData = await up.json()
    const scriptId = upData.id ?? upData.scriptId
    console.log(`\n=== ${key} === scriptId=${scriptId} probes=${probes.length}`)

    // 生成 v2 档案
    const genRes = await fetch(`${API_BASE}/api/dossier/${encodeURIComponent(scriptId)}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
      signal: AbortSignal.timeout(7_200_000),
    })
    const gen = await genRes.json()
    story.gen = { ...gen, ms: Date.now() - t0 }
    console.log(`  [gen] ${JSON.stringify(gen)} (${Math.round((Date.now() - t0) / 1000)}s)`)
    if (!gen?.ok) { story.error = gen?.error ?? 'gen failed'; console.log(`  [warn] ${key} dossier gen failed — 跳过问答`); continue }

    // 读落盘档案（v2 JSON 全量）
    const dossierPath = path.join(CACHE_DIR, String(userId ?? '1'), `${sanitize(scriptId)}.json`)
    let dossier = null
    for (let i = 0; i < 10 && !dossier; i++) {
      try { dossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8')) } catch { await sleep(2000) }
    }
    if (!dossier) { story.error = 'dossier file not found in cache'; console.log('  [warn] dossier cache miss'); continue }
    // 结构质量自检（镜像 assessDossier 的孤儿引用口径，快速版）
    const sceneIds = new Set((dossier.scenes ?? []).map((s) => s.id))
    const sceneNames = new Set((dossier.scenes ?? []).map((s) => s.name))
    const npcIds = new Set((dossier.npcs ?? []).map((n) => n.id))
    const npcNames = new Set((dossier.npcs ?? []).map((n) => n.name))
    const known = (ref, ids, names) => !!ref && (ids.has(ref) || names.has(ref))
    const orphanTransitions = (dossier.transitions ?? []).filter((t) => !known(t.from, sceneIds, sceneNames) || !known(t.to, sceneIds, sceneNames)).map((t) => `${t.from}→${t.to}`)
    const orphanRelations = []
    let relations = 0
    for (const n of dossier.npcs ?? []) for (const r of n.relations ?? []) { relations++; if (!known(r.target, npcIds, npcNames)) orphanRelations.push(`${n.name}—${r.target}`) }
    const orphanEvents = (dossier.events ?? []).filter((e) => e.scene && !known(e.scene, sceneIds, sceneNames)).map((e) => e.scene)
    story.dossierStats = {
      scenes: (dossier.scenes ?? []).length, clues: (dossier.clues ?? []).length, npcs: (dossier.npcs ?? []).length,
      transitions: (dossier.transitions ?? []).length, events: (dossier.events ?? []).length, relations,
      orphanTransitions, orphanRelations, orphanEvents,
      meta: dossier.meta ?? null,
      chars: JSON.stringify(dossier).length,
    }

    // 档案直答探针
    for (const p of probes) {
      const a = await answerFromDossier(dossier, p.q)
      const answer = typeof a.raw === 'object' && a.raw?.judgeError ? `(answer failed: ${a.raw.judgeError})` : String(a.raw ?? '')
      const judge = await judgeAnswer(story.storyName, p, answer)
      const rec = { cat: p.cat ?? 'fact', q: p.q, variant: a.variant, answer: answer.slice(0, 1200), judge }
      story.probes.push(rec)
      const j = judge.score != null ? `score=${judge.score}${judge.fabrication ? '/fab' : ''}` : `ERR ${judge.judgeError ?? ''}`
      console.log(`  [probe ${rec.cat}] ${p.q.slice(0, 34)}… → ${j}`)
      await sleep(1500) // 轻退避
    }
    story.elapsedMs = Date.now() - t0
    const scored = story.probes.filter((p) => p.judge?.score != null)
    if (scored.length) {
      const avg = (scored.reduce((s, p) => s + p.judge.score, 0) / scored.length).toFixed(2)
      const fab = scored.filter((p) => p.judge.fabrication).length
      console.log(`== ${key} 平均 ${avg}（judged ${scored.length}，fab ${fab}）==`)
    }
  }

  out.updatedAt = Date.now()
  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nresults → ${outPath}`)
  await cleanup()
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}

main().catch(async (e) => {
  console.error('reconstruct fail:', e.message)
  console.error(serverLogs.slice(-3000))
  await cleanup()
  process.exit(1)
})

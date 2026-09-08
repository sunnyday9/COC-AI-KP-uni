/**
 * Repair pass for dossier-arm injection metrics (real A/B run).
 *
 * The main batch ran with per-run temp DOSSIER_DATA_DIR that was deleted
 * afterwards, so the harness could not read back dossier JSON → dossier
 * per-turn injection tokens stayed 0. Rooms themselves DID run with real
 * dossiers (setup.dossierGen.ok true).
 *
 * This script: re-uploads each story, regenerates the dossier (LLM, same
 * settings as the batch), caches the JSON under training/eval/dossier-cache/,
 * then patches the results JSON: for every dossier-room turn it derives the
 * active scene (opening/turns before the first transition = dossier scenes[0];
 * after a transition_scene tool call = its sceneName arg) and writes
 * injectionTokens = estimated tokens of that scene's block. rag-arm numbers
 * come from wire samples and are left untouched.
 *
 * Usage (real mode env like ab-compare):
 *   MOCK_AI=0 AB_AI_* OPENCODE_SESSION=... node scripts/eval/ab-dossier-metrics.mjs \
 *     --in training/eval/reports/ab-real-20260908.json
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
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
const CACHE_DIR = path.join(ROOT, 'training', 'eval', 'dossier-cache')

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
const origFetch = globalThis.fetch
globalThis.fetch = (url, opts = {}) => origFetch(url, { ...opts, dispatcher })

const inPath = path.join(ROOT, process.argv.find((a) => a.startsWith('--in='))?.slice(5) ?? 'training/eval/reports/ab-real-20260908.json')

const children = []
let logs = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const estTokens = (text) => {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.round(cjk * 0.9 + (s.length - cjk) / 3.5)
}

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

async function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGTERM')
    } catch { /* ignore */ }
  }
  await sleep(800)
}

async function main() {
  const results = JSON.parse(fs.readFileSync(inPath, 'utf8'))
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ab-dosrepair-'))
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
  child.stdout.on('data', (d) => (logs += d))
  child.stderr.on('data', (d) => (logs += d))
  children.push(child)

  // server ready
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) }); if ([200, 401].includes(r.status)) break } catch { /* retry */ }
    await sleep(1000)
  }
  const uname = `abrepair_${Date.now()}`
  const pw = 'ab-pass-word'
  await fetch(`${API_BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: pw }) })
  const login = await fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: pw }) })
  const { token, userId } = (await login.json())
  if (!MOCK) {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ai: { provider: 'openai_compatible', baseUrl: REAL_CFG.baseUrl, apiKey: REAL_CFG.apiKey, model: REAL_CFG.model, temperature: 0.7, maxTokens: 2048 },
        rag: { useEmbeddings: true, provider: 'builtin', model: 'text-embedding-3-small', useGraphRAG: false, extractionModel: '' },
      }),
    })
    if (res.status !== 200) throw new Error(`settings: ${res.status}`)
  }

  const storyDir = path.join(ROOT, 'AI-COC-KP Story Document', 'stories')
  const pending = []
  for (const [key, s] of Object.entries(results.stories ?? {})) {
    if (!s.workflows?.dossier?.turns?.length) continue
    const file = path.join(storyDir, s.storyFile ?? `${key}.pdf`)
    if (!fs.existsSync(file)) { console.log(`[skip-missing] ${key} (${file})`); continue }
    pending.push({ key, file })
  }
  console.log(`regenerating dossiers for ${pending.length} stories…`)

  for (const { key, file } of pending) {
    const story = results.stories[key]
    const fd = new FormData()
    fd.append('file', new Blob([fs.readFileSync(file)], { type: 'application/octet-stream' }), path.basename(file))
    const up = await fetch(`${API_BASE}/api/stories/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
    const upData = await up.json()
    const scriptId = upData.id ?? upData.scriptId
    const t0 = Date.now()
    const gen = await fetch(`${API_BASE}/api/dossier/${encodeURIComponent(scriptId)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
      signal: AbortSignal.timeout(7_200_000),
    })
    const genData = await gen.json()
    console.log(`[gen] ${key}: ${JSON.stringify(genData)} (${Math.round((Date.now() - t0) / 1000)}s)`)
    story.setup = story.setup ?? {}
    story.setup.dossierGenRepair = { ...genData, ms: Date.now() - t0 }
    if (!genData?.ok) { console.log(`  [warn] dossier regen failed for ${key}, injection stays 0`); continue }

    // load cached dossier (userId dir may be absent in file name path; find by scriptId suffix)
    const uidDir = path.join(CACHE_DIR, String(userId ?? '1'))
    const candidates = fs.readdirSync(uidDir).filter((f) => f.includes(scriptId.replace(/[^\w-]/g, '_')) || f === `${scriptId}.json`)
    const dp = path.join(uidDir, candidates[0])
    const dossier = JSON.parse(fs.readFileSync(dp, 'utf8'))
    const sceneTokens = {}
    for (const sc of dossier.scenes ?? []) {
      sceneTokens[sc.name] = estTokens(`${sc.name ?? ''}\n${sc.description ?? ''}\n${sc.sceneText ?? ''}`)
    }
    const firstScene = dossier.scenes?.[0]?.name ?? null

    // per-turn reconstruction: dossier rooms' active scene = last transition_scene arg (or firstScene)
    const wf = story.workflows.dossier
    let activeScene = firstScene
    for (const t of wf.turns) {
      if (t.skipped) continue
      for (const tc of t.toolCalls ?? []) {
        if (tc.name === 'transition_scene') {
          try {
            const args = JSON.parse(tc.arguments ?? '{}')
            if (args.sceneName) activeScene = args.sceneName
          } catch { /* ignore */ }
        }
      }
      if (activeScene == null) { t.injectionTokens = 0; continue }
      const hit = Object.keys(sceneTokens).find((n) => n === activeScene)
      t.injectionTokens = hit ? sceneTokens[hit] : 0
      t.injectionScene = activeScene
    }
    const execT = wf.turns.filter((t) => !t.skipped)
    const pct = (vals, p) => {
      const sorted = vals.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b)
      if (!sorted.length) return null
      return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)])
    }
    wf.turnMetrics = wf.turnMetrics ?? {}
    wf.turnMetrics.injectionTokens = { n: execT.length, p50: pct(execT.map((t) => t.injectionTokens), 50), p95: pct(execT.map((t) => t.injectionTokens), 95), p99: pct(execT.map((t) => t.injectionTokens), 99) }
    wf.totals = wf.totals ?? {}
    wf.totals.injectionTokens = execT.reduce((s, t) => s + (t.injectionTokens ?? 0), 0)
    wf.totals.emptyInjectionTurns = execT.filter((t) => (t.injectionTokens ?? 0) === 0).length
    console.log(`  [patched] ${key} dossier: 注入总量=${wf.totals.injectionTokens}tok 空回合=${wf.totals.emptyInjectionTurns} 首场景="${firstScene}"`)
  }

  const outPath = arg('out', inPath)
  fs.writeFileSync(outPath, JSON.stringify({ ...results, patchedAt: Date.now() }, null, 2))
  console.log(`patched results → ${outPath}`)
  await cleanup()
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  console.log('DONE')
  process.exit(0)
}

main().catch((e) => {
  console.error('repair fail:', e.message)
  console.error(logs.slice(-3000))
  cleanup().finally(() => process.exit(1))
})

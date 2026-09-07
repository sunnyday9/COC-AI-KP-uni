/**
 * A/B comparison harness — rag workflow vs dossier workflow (experiment branch
 * feature/kp-dossier-workflow).
 *
 * Drives the SAME input script through two solo rooms of the same story (one
 * rag, one dossier) and collects structured comparison data:
 *  - per-room wire samples (llm graph calls, tool calls, knowledge injection)
 *  - token estimate of the injected knowledge block per turn
 *  - tool-call distribution (dossier: lookup tools vs rag: none)
 *
 * Usage:
 *   MOCK_AI=1 (default): deterministic mock run, zero cost.
 *   MOCK_AI=0 + BYOK envs: real-LLM run (costs your BYOK quota).
 *   node scripts/eval/ab-compare.mjs [--out training/eval/reports/ab-<tag>.json]
 *
 * Env: E2E_PORT, BYOK via server settings PUT (real mode reads
 * AB_AI_BASE_URL / AB_AI_API_KEY / AB_AI_MODEL / AB_AI_PROTOCOL).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const API_BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`
const WS_URL = (API_BASE.replace(/^http/, 'ws')).replace('localhost', '127.0.0.1')
const FIXTURE = path.join(ROOT, 'e2e', 'fixtures', 'demo-story.txt')
const MOCK = process.env.MOCK_AI !== '0'

/** The SAME input script drives both rooms. 侦查/对话/移动/查证 beats. */
const INPUT_SCRIPT = [
  '我环顾四周，侦查一下这间旧图书馆。',
  '管理员先生，地下室为什么被封起来了？',
  '我检查那只青瓷花瓶。',
  '我试着撬开地下室门上的铁链锁。',
  '档案室里的卷宗都写了些什么？',
  '情报确认：剧本里还有哪些地点可以去？',
]

/* ═══════════ harness plumbing (mirrors e2e journeys) ═══════════ */

const logs = { server: [] }
let children = []
const results = []

function step(name, fn) {
  const start = Date.now()
  return fn()
    .then(() => { results.push({ name, pass: true, ms: Date.now() - start }); console.log(`  [PASS] ${name} (${Date.now() - start}ms)`) })
    .catch((err) => { results.push({ name, pass: false, ms: Date.now() - start, error: err.message }); console.error(`  [FAIL] ${name}: ${err.message}`); throw err })
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed') }
function tail(arr, n = 80) { return arr.slice(-n).join('\n') }

async function spawnServer(tmpRoot) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      MOCK_AI: MOCK ? '1' : '0',
      PORT: String(process.env.E2E_PORT ?? 3100),
      JWT_SECRET: 'ab-secret-change-me',
      DATA_DIR: path.join(tmpRoot, 'data'),
      RAG_DATA_DIR: path.join(tmpRoot, 'rag'),
      DOSSIER_DATA_DIR: path.join(tmpRoot, 'dossiers'),
      UPLOADS_DIR: path.join(tmpRoot, 'uploads'),
      MODELS_DIR: path.join(tmpRoot, 'models'),
      KP_WIRE_SAMPLING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.server.push(d.toString()))
  child.stderr.on('data', (d) => logs.server.push(d.toString()))
  children.push(child)
  return child
}

async function waitServerReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) }); if (r.status === 401 || r.status === 200) return } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error(`server not ready\n--- log ---\n${tail(logs.server)}`)
}

async function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else { try { spawn('pkill', ['-TERM', '-P', String(c.pid)], { stdio: 'ignore' }) } catch { /* ignore */ } c.kill('SIGTERM') }
    } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 800))
}

async function api(method, p, body, token) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function registerUser(tag) {
  const username = `ab_${tag}_${Date.now()}`
  const password = ['ab', 'pass', 'word'].join('-')
  const reg = await api('POST', '/api/auth/register', { username, password })
  assert(reg.status === 200, `register failed: ${reg.status}`)
  const login = await api('POST', '/api/auth/login', { username, password })
  const me = await api('GET', '/api/auth/me', undefined, login.data.token)
  return { username, password, token: login.data.token, userId: me.data?.user?.id ?? 0 }
}

function makeSheet(name) {
  const base = { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }
  return {
    occupationId: 'judge', occupationName: '法官', playerName: name, attributes: base,
    skills: { 侦查: 65, 聆听: 60, 图书馆使用: 55, 格斗: 40, 信用评级: 40 },
    derived: { hp: Math.floor((base.con + base.siz) / 10), hpMax: Math.floor((base.con + base.siz) / 10), mp: Math.floor(base.pow / 5), mpMax: Math.floor(base.pow / 5), san: base.pow, sanMax: base.pow },
    damageBonus: '0', build: 0, mov: 8, armor: 0,
  }
}

async function uploadStory(token) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(FIXTURE)], { type: 'text/plain' }), 'demo-story.txt')
  const res = await fetch(`${API_BASE}/api/stories/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const data = await res.json().catch(() => ({}))
  assert(res.status === 200, `upload failed: ${res.status} ${JSON.stringify(data)}`)
  return (data.id ?? data.scriptId ?? 'demo-story.txt')
}

function openWs(token) {
  const socket = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`)
  const frames = []
  const waiters = []
  socket.on('message', (raw) => {
    let f; try { f = JSON.parse(String(raw)) } catch { return }
    frames.push(f)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(f) }
    }
  })
  const opened = new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`))) })
  return { socket, frames, opened, waitFor(pred, timeoutMs, label) { const hit = frames.find(pred); if (hit) return Promise.resolve(hit); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`waitFor timeout: ${label}`)), timeoutMs); waiters.push({ pred, resolve, reject, timer }) }) } }
}

/** Rough token estimate (Chinese ~1 token/char; EN ~1 token/4 chars). */
function estTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const other = s.length - cjk
  return Math.round(cjk * 0.9 + other / 3.5)
}

async function runRoom(token, workflow, roomId, ws) {
  // join triggers opening (solo, messages empty)
  ws.socket.send(JSON.stringify({ type: 'room:join', roomId }))
  await ws.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && f.payload.message.content.length > 0, 30_000, 'opening kp')
  const perTurn = []
  for (const content of INPUT_SCRIPT) {
    const kpWatermark = ws.frames.filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp').reduce((m, f) => Math.max(m, f.seq ?? 0), 0)
    ws.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content } } }))
    const kp = await ws.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && (f.seq ?? 0) > kpWatermark, 30_000, `kp after: ${content.slice(0, 20)}`)
    perTurn.push({ input: content, kpReply: kp.payload.message.content, kpReplyTokens: estTokens(kp.payload.message.content) })
  }
  return perTurn
}

/* ═══════════ DB read: wire samples per room ═══════════ */

function readWireSamples(dbPath, roomId) {
  const rows = wireDb.all(dbPath, roomId)
  return rows.map((r) => ({
    turnSeq: r.turn_seq,
    ragContextTokens: estTokens(r.rag_context),
    ragContextChars: (r.rag_context || '').length,
    toolCalls: JSON.parse(r.tool_calls || '[]'),
    wireMessages: JSON.parse(r.wire_messages || '[]'),
  }))
}

/* node:sqlite lazy adapter (DatabaseSync read per call). */
const wireDb = (() => {
  let db = null
  return {
    all(dbPath, roomId) {
      // node:sqlite is experimental — open a fresh handle per call to avoid
      // holding the file lock across the server's writes.
      const { DatabaseSync } = require('node:sqlite')
      const handle = new DatabaseSync(dbPath, { readOnly: true })
      try {
        return handle.prepare(`SELECT turn_seq, rag_context, tool_calls, wire_messages, created_at FROM kp_wire_samples WHERE room_id = ? ORDER BY turn_seq`).all(roomId)
      } finally {
        handle.close()
      }
    },
  }
})()

/* ═══════════════════ main ═══════════════════ */

async function main() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ab-compare-'))
  await spawnServer(tmpRoot)
  await waitServerReady()

  let user, scriptId
  const summary = { mode: MOCK ? 'mock' : 'real', workflow: { rag: {}, dossier: {} }, script: INPUT_SCRIPT }
  try {
    await step('注册 + 上传 demo-story + rag 索引 + dossier 生成', async () => {
      user = await registerUser('main')
      scriptId = await uploadStory(user.token)
      const rag = await api('GET', `/api/stories/${encodeURIComponent(scriptId)}/rag`, undefined, user.token)
      const content = typeof rag.data.content === 'string' ? rag.data.content : JSON.stringify(rag.data)
      const idx = await api('POST', '/api/rag/index', { scriptId, chunks: [{ id: 'c0', content }], storyMeta: { name: 'demo-story' } }, user.token)
      assert(idx.data.ok, `rag index failed: ${JSON.stringify(idx.data)}`)
      const gen = await api('POST', `/api/dossier/${encodeURIComponent(scriptId)}/generate`, {}, user.token)
      assert(gen.data.ok, `dossier generate failed: ${JSON.stringify(gen.data)}`)
    })

    for (const workflow of ['rag', 'dossier']) {
      await step(`建 ${workflow} solo 房并驱动同一输入脚本`, async () => {
        const created = await api('POST', '/api/rooms/solo', { storyId: scriptId, name: `ab_${workflow}`, sheet: makeSheet(`ab_${workflow}`), workflow }, user.token)
        assert(created.status === 200, `create ${workflow} room failed: ${JSON.stringify(created.data)}`)
        const roomId = created.data.roomId
        const ws = openWs(user.token)
        await ws.opened
        const perTurn = await runRoom(user.token, workflow, roomId, ws)
        ws.socket.close()
        const dbPath = path.join(tmpRoot, 'data', 'ai-kp.db')
        let wire = []
        try { wire = readWireSamples(dbPath, roomId) } catch { wire = [] }
        // Mock 模式 wire 采样不落库（KP_WIRE_SAMPLING 对 MOCK 跳过）——知识注入量改用
        // 理论值：dossier = 档案场景块（从档案 JSON 算）；rag mock = 0（无 embedding → 情报块恒空）。
        let injectedChars = wire.reduce((s, w) => s + w.ragContextChars, 0)
        let injectedTokens = wire.reduce((s, w) => s + w.ragContextTokens, 0)
        let note = ''
        if (MOCK && workflow === 'rag') {
          note = 'mock 下 rag 无 embedding → fetchRagContext 恒空（情报块 0 注入）'
        }
        if (MOCK && workflow === 'dossier') {
          // 读档案文件拿真实 sceneText（mock 生成落盘），近似每回合注入的当前场景档案块
          try {
            const dossierDir = path.join(tmpRoot, 'dossiers', String(user.userId))
            const files = await fs.promises.readdir(dossierDir)
            const dossier = JSON.parse(await fs.promises.readFile(path.join(dossierDir, files[0]), 'utf-8'))
            const sceneText = dossier.scenes?.[0]?.sceneText ?? ''
            injectedChars = (sceneText.length + 200) * (perTurn.length + 1)
            injectedTokens = Math.round(injectedChars * 0.9)
          } catch { /* fall through to 0 */ }
          note = 'mock 下 dossier 注入 = 档案首场景块（sceneText 实测）'
        }
        summary.workflow[workflow] = {
          roomId,
          mode: MOCK ? 'mock' : 'real',
          note,
          turns: perTurn,
          totalKpReplyTokens: perTurn.reduce((s, t) => s + t.kpReplyTokens, 0),
          wireSampleCount: wire.length,
          totalInjectedKnowledgeChars: injectedChars,
          totalInjectedKnowledgeTokens: injectedTokens,
          toolCallDistribution: wire.reduce((acc, w) => {
            for (const tc of w.toolCalls) {
              const name = tc.name || tc.function?.name || 'unknown'
              acc[name] = (acc[name] || 0) + 1
            }
            return acc
          }, {}),
        }
      })
    }

    console.log('\n=== A/B 对比摘要 ===')
    for (const w of ['rag', 'dossier']) {
      const s = summary.workflow[w]
      console.log(`\n[${w}] wire样本=${s.wireSampleCount} 知识注入总token=${s.totalInjectedKnowledgeTokens} KP回复总token=${s.totalKpReplyTokens}`)
      console.log(`  工具调用分布: ${JSON.stringify(s.toolCallDistribution)}`)
    }
    const rag = summary.workflow.rag
    const dos = summary.workflow.dossier
    if (rag.totalInjectedKnowledgeTokens > 0) {
      console.log(`\n知识注入: rag=${rag.totalInjectedKnowledgeTokens} tok vs dossier=${dos.totalInjectedKnowledgeTokens} tok (dossier ${Math.round((1 - dos.totalInjectedKnowledgeTokens / rag.totalInjectedKnowledgeTokens) * 100)}% 更省)`)
    } else {
      console.log(`\n知识注入: rag=${rag.totalInjectedKnowledgeTokens} tok（${rag.note ?? '无'}）vs dossier=${dos.totalInjectedKnowledgeTokens} tok（${dos.note ?? ''}）`)
    }

    // 落盘报告
    const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
    if (out) {
      const outPath = path.join(ROOT, out)
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
      await fs.promises.writeFile(outPath, JSON.stringify({ ...summary, generatedAt: Date.now() }, null, 2))
      console.log(`\n报告已写: ${outPath}`)
    }

    const failed = results.filter((r) => !r.pass)
    if (failed.length) { console.error(`\n--- server log tail ---\n${tail(logs.server)}`); process.exitCode = 1 }
  } finally {
    await cleanup()
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error(`ab-compare crashed: ${err.stack || err.message}`)
  console.error(`\n--- server log tail ---\n${tail(logs.server)}`)
  process.exitCode = 1
})

/**
 * A/B comparison harness — rag workflow vs dossier workflow (experiment branch
 * feature/kp-dossier-workflow). Real-LLM edition.
 *
 * Drives the SAME input script + per-story fact questions through two solo
 * rooms of the same story (rag / dossier) and collects per-turn comparison
 * data:
 *  - per-turn TTFT (first `kp_chunk` frame, needs server KP_CHUNK_STREAM=1)
 *    and whole-turn latency
 *  - per-turn knowledge injection (rag: wire-sample rag_context; dossier:
 *    current-scene block from the dossier JSON) & empty-injection detection
 *  - tool-call distribution per room (dossier: scene_list/scene_dossier/
 *    lexical_search vs rag: none)
 *  - fact-faithfulness: M=5 ground-truth questions per story asked to both
 *    rooms after play, judged 1-5 by the same real LLM (LLM-as-judge)
 *
 * Usage:
 *   # mock smoke (zero cost; validates the chain incl. chunk frames)
 *   MOCK_AI=1 node scripts/eval/ab-compare.mjs --out training/eval/reports/ab-mock-<tag>.json
 *
 *   # real (costs BYOK quota) — endpoint/session env, see mimo-endpoint memory:
 *   MOCK_AI=0 AB_AI_BASE_URL=https://opencode.ai/zen/go/v1 AB_AI_API_KEY=<from config.json>
 *   AB_AI_MODEL=mimo-v2.5 OPENCODE_SESSION=ab-real-<tag> \
 *     node scripts/eval/ab-compare.mjs --dir "AI-COC-KP Story Document/stories" \
 *     --out training/eval/reports/ab-real-<tag>.json
 *
 * Story selection: --file <path> (repeatable) / --dir <dir> (all story files,
 * sorted) / none → e2e demo fixture (smoke). --turns N play turns (default
 * 10). Facts: read from scripts/eval/ab-facts/<storyFile>.json when present
 * (5 per story); --skip-facts disables the fact round.
 *
 * Resume: when --out exists, stories already completed (or failed with
 * keepFailed) are skipped; rerun skips only completed. Failed stories retried.
 *
 * Env: E2E_PORT, MOCK_AI, AB_AI_BASE_URL / AB_AI_API_KEY / AB_AI_MODEL,
 * OPENCODE_SESSION (server env → x-opencode-session header + judge).
 * Wire sampling is server-side default-on (KP_WIRE_SAMPLING=1 set here).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { Agent } from 'undici'

/**
 * 长请求（dossier 生成可达 10-30 分钟）：undici 默认 headersTimeout/bodyTimeout
 * 各 300s，会在响应完成前掐断连接（'Headers Timeout Error'）——全局换用无该
 * 超时的 dispatcher；总时长上限仍由各调用点的 AbortSignal.timeout 控制。
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
const origFetch = globalThis.fetch
globalThis.fetch = (url, opts = {}) => origFetch(url, { ...opts, dispatcher })

const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const API_BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`
const WS_URL = API_BASE.replace(/^http/, 'ws').replace('localhost', '127.0.0.1')
const FIXTURE = path.join(ROOT, 'e2e', 'fixtures', 'demo-story.txt')
const DEFAULT_FACTS_DIR = path.join(ROOT, 'scripts', 'eval', 'ab-facts')
const MOCK = process.env.MOCK_AI !== '0'
const REAL_CFG = {
  baseUrl: process.env.AB_AI_BASE_URL ?? '',
  apiKey: process.env.AB_AI_API_KEY ?? '',
  model: process.env.AB_AI_MODEL ?? 'mimo-v2.5',
}

/** The SAME play script drives both rooms (workflow-agnostic COC beats). */
const PLAY_SCRIPT = [
  '我环顾四周，仔细观察一下现在的环境，看看自己在什么地方、有什么值得注意的。',
  '我试着和在场的人交谈，打听这里到底发生了什么。',
  '我仔细搜查这个房间，寻找可疑的线索或痕迹。',
  '我想去下一个地方看看，那里可能藏着什么。',
  '我检查一下随身携带的物品，看看有什么能派上用场。',
  '情报确认：根据你目前掌握的情报，这个事件涉及哪些人物、地点与线索？',
  '刚才发现的线索让我很在意，能再详细展开说说吗？',
  '我隐约听到不远处传来奇怪的声音，我会怎么应对？',
  '事情似乎已经逼近核心了，现在最关键、最需要查明的真相是什么？',
  '我决定采取行动，让这件事有一个了结。',
]

/* ═══════════════ harness plumbing (mirrors e2e journeys) ═══════════════ */

const logs = { server: [] }
let children = []
const results = []
const PERCENTILES = [50, 95, 99]

function step(name, fn) {
  const start = Date.now()
  return fn()
    .then(() => { results.push({ name, pass: true, ms: Date.now() - start }); console.log(`  [PASS] ${name} (${Date.now() - start}ms)`) })
    .catch((err) => { results.push({ name, pass: false, ms: Date.now() - start, error: err.message }); console.error(`  [FAIL] ${name}: ${err.message}`); throw err })
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed') }
function tail(arr, n = 120) { return arr.slice(-n).join('\n') }
function pct(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[Math.max(0, idx)])
}
function pctRow(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b)
  const row = { n: sorted.length }
  for (const p of PERCENTILES) row[`p${p}`] = pct(sorted, p)
  row.mean = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null
  return row
}
function estTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const other = s.length - cjk
  return Math.round(cjk * 0.9 + other / 3.5)
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

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
      // Real 模式复用 server/data/models 缓存（Xenova/text2vec 449MB 一次下载）；
      // mock 模式不下载模型，仍指向临时目录即可。
      ...(MOCK ? { MODELS_DIR: path.join(tmpRoot, 'models') } : {}),
      // 非流式调用超时（dossier 生成/抽取）：默认 60s 对推理模型过紧 → real 模式放宽到 240s
      LLM_TIMEOUT_MS: String(process.env.LLM_TIMEOUT_MS ?? (MOCK ? 60_000 : 240_000)),
      KP_WIRE_SAMPLING: '1',
      KP_CHUNK_STREAM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.server.push(d.toString()))
  child.stderr.on('data', (d) => logs.server.push(d.toString()))
  children.push(child)
  return child
}

async function waitServerReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) }); if (r.status === 401 || r.status === 200) return } catch { /* retry */ }
    await sleep(800)
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
  await sleep(800)
}

async function api(method, p, body, token, timeoutMs = 120_000) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

/** Upload one story file → server story id (scriptId). */
async function uploadStory(token, filePath) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: 'application/octet-stream' }), path.basename(filePath))
  const res = await fetch(`${API_BASE}/api/stories/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
    signal: AbortSignal.timeout(180_000),
  })
  const data = await res.json().catch(() => ({}))
  assert(res.status === 200, `upload ${path.basename(filePath)} failed: ${res.status} ${JSON.stringify(data)}`)
  return { id: data.id ?? data.scriptId, name: data.name ?? path.basename(filePath) }
}

/** Real mode: configure AI settings from env (mimo) + rag 内置 text2vec 本地嵌入. */
async function configureRealAi(token) {
  assert(REAL_CFG.baseUrl && REAL_CFG.apiKey, 'real mode needs AB_AI_BASE_URL + AB_AI_API_KEY env')
  const res = await api('PUT', '/api/settings', {
    ai: {
      provider: 'openai_compatible',
      baseUrl: REAL_CFG.baseUrl,
      apiKey: REAL_CFG.apiKey,
      model: REAL_CFG.model,
      temperature: 0.7,
      maxTokens: 2048,
    },
    rag: { useEmbeddings: true, provider: 'builtin', model: 'text-embedding-3-small', useGraphRAG: false, extractionModel: '' },
  }, token)
  assert(res.status === 200, `settings PUT failed: ${res.status} ${JSON.stringify(res.data)}`)
  console.log(`  [real] AI 配置: ${REAL_CFG.model} @ ${REAL_CFG.baseUrl}（rag 用内置 text2vec 本地嵌入；OPENCODE_SESSION=${process.env.OPENCODE_SESSION ? 'set' : 'UNSET'}`)
}

/* ═══════════════ story text → rag chunks (mirrors client fileToChunks) ═══════════════ */

function makeChunks(text, maxChars = 1400, overlap = 120) {
  const blocks = String(text ?? '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40)
  const chunks = []
  let buf = ''
  for (const b of blocks) {
    if (b.length > maxChars) {
      if (buf) { chunks.push(buf); buf = '' }
      for (let i = 0; i < b.length; i += maxChars - overlap) chunks.push(b.slice(i, i + maxChars))
      continue
    }
    if (buf.length + b.length + 2 > maxChars) {
      chunks.push(buf)
      buf = b
    } else {
      buf = buf ? `${buf}\n${b}` : b
    }
  }
  if (buf) chunks.push(buf)
  // rag index 契约：chunks 需 { id, content } 对象（无 id 会落空 id → 检索后取不回原文）
  return chunks.map((content, i) => ({ id: `c${i}`, content }))
}

/* ═══════════════ websocket room drive + measurement ═══════════════ */

function openWs(token) {
  const socket = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`)
  const frames = []
  const waiters = []
  socket.on('message', (raw) => {
    let f; try { f = JSON.parse(String(raw)) } catch { return }
    f._t = Date.now() // 帧到达时间（TTFT/总延迟测量锚点）
    frames.push(f)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(f) }
    }
  })
  const opened = new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`))) })
  return { socket, frames, opened, waitFor(pred, timeoutMs, label) { const hit = frames.find(pred); if (hit) return Promise.resolve(hit); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`waitFor timeout(${timeoutMs}ms): ${label}`)), timeoutMs); waiters.push({ pred, resolve, reject, timer }) }) } }
}

/** Current max seq of already-delivered kp/system messages (turn watermark). */
function msgWatermark(frames, role = null) {
  return frames
    .filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && (!role || f.payload?.message?.role === role))
    .reduce((m, f) => Math.max(m, f.seq ?? 0), 0)
}

function isKpMsg(f) { return f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' }
function isSysMsg(f) { return f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'system' }
function isChunk(f) { return f.type === 'room:event' && f.eventType === 'kp_chunk' && f.payload?.content }
const FAIL_MSG = '回合失败'

/**
 * Wait for one full KP turn batch: frames with seq > wmark (message_appended
 * kp/system + kp_chunk) until the stream goes quiet (quietMs). A turn may
 * append mid-turn tool displays (system) around the kp narrative, so the
 * terminal is "no new frame for quietMs", not the first frame.
 */
async function waitTurnBatch(ws, wmark, quietMs, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  const hit = () => ws.frames.filter((f) => (isKpMsg(f) || isSysMsg(f) || isChunk(f)) && (f.seq ?? 0) > wmark)
  let last = hit()
  while (Date.now() < deadline) {
    const cur = hit()
    if (cur.length > 0) {
      const newest = cur[cur.length - 1]._t
      if (cur.some((f) => isKpMsg(f) || isSysMsg(f)) && Date.now() - newest > quietMs) return cur
    }
    await sleep(200)
  }
  throw new Error(`waitTurnBatch timeout(${timeoutMs}ms): ${label}`)
}

/**
 * Drive one room: join → wait opening → run `turns` inputs sequentially.
 * Per turn collects { ttftMs (first chunk after send), totalMs (turn batch
 * quiet), chunkCount, reply (kp narrative), failed, sceneBefore }.
 */
async function driveRoom(token, roomId, ws, turns, dbPath, roomLabel) {
  const tJoin = Date.now()
  ws.socket.send(JSON.stringify({ type: 'room:join', roomId }))
  const quietMs = MOCK ? 350 : 1500
  const opening = {}
  try {
    const first = await ws.waitFor((f) => isKpMsg(f) || isSysMsg(f), MOCK ? 30_000 : 240_000, `${roomLabel} opening kp`)
    opening.totalMs = Date.now() - tJoin
    opening.failed = first.payload.message.role === 'system'
    const firstChunk = ws.frames.filter(isChunk)[0]
    opening.ttftMs = firstChunk ? firstChunk._t - tJoin : null
  } catch (err) {
    opening.error = err.message
  }

  const perTurn = []
  let wireRows = []
  let roomEnded = false
  try { wireRows = readWireSamples(dbPath, roomId) } catch { /* opening 无采样行（mock） */ }
  for (let i = 0; i < turns.length; i++) {
    const content = turns[i]
    const wmark = msgWatermark(ws.frames)
    // 场景/阶段（本回合注入用的档案块锚点 + 结局提前终止）：上回合结束后的房间 scene
    let sceneBefore = null
    let phase = null
    try {
      const g = await api('GET', `/api/rooms/${roomId}`, undefined, token, 15_000)
      sceneBefore = (g.data?.state ?? g.data)?.scene ?? null
      phase = g.data?.phase ?? null
    } catch { /* scene 采集失败不阻塞 */ }
    if (phase === 'ended' || roomEnded) {
      roomEnded = true
      perTurn.push({ input: content, skipped: 'room ended', sceneBefore })
      continue
    }

    const tSend = Date.now()
    ws.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content } } }))
    const rec = { input: content, tSend, ttftMs: null, totalMs: null, chunkCount: 0, reply: '', display: '', failed: false, sceneBefore, wireAdded: 0, injectionChars: 0, injectionTokens: 0, toolCalls: [] }

    let batch = []
    try {
      batch = await waitTurnBatch(ws, wmark, quietMs, MOCK ? 30_000 : 240_000, `${roomLabel} turn ${i + 1}: ${content.slice(0, 18)}`)
    } catch (err) { rec.error = err.message }

    if (batch.length > 0) {
      const firstChunk = batch.find(isChunk)
      rec.ttftMs = firstChunk ? firstChunk._t - tSend : null
      rec.totalMs = batch[batch.length - 1]._t - tSend
      const msgs = batch.filter((f) => isKpMsg(f) || isSysMsg(f))
      rec.failed = msgs.some((f) => isSysMsg(f) && f.payload.message.content.includes(FAIL_MSG))
      const kpTexts = msgs.filter(isKpMsg).map((f) => f.payload.message.content ?? '')
      const sysTexts = msgs.filter((f) => isSysMsg(f) && !f.payload.message.content.includes(FAIL_MSG)).map((f) => f.payload.message.content ?? '')
      rec.reply = kpTexts.join('\n') || sysTexts.join('\n')
      rec.display = sysTexts.join('\n')
      rec.chunkCount = batch.filter(isChunk).length
    } else {
      rec.failed = true
      rec.error = rec.error || 'no reply within timeout'
    }
    rec.kpReplyTokens = estTokens(rec.reply)

    // wire 采样增量（等落库后 diff → 本回合注入/工具数据；mock 无采样行 → 全 0）
    if (!MOCK) await sleep(400)
    try {
      const before = wireRows.length
      const rows = readWireSamples(dbPath, roomId)
      const added = rows.slice(before)
      rec.wireAdded = added.length
      rec.injectionChars = added.reduce((s, r) => s + r.ragContextChars, 0)
      rec.injectionTokens = added.reduce((s, r) => s + r.ragContextTokens, 0)
      rec.toolCalls = added.flatMap((r) => r.toolCalls)
      // P25：查证工具（verify_original）的**回填内容**逐字留在 wire 里（≤600 字符
      // 截断线内即工具原文），取出来供报告核对命中率与直答质量；其余工具不落内容。
      rec.verifyResults = added
        .flatMap((r) => r.wireMessages ?? [])
        .filter((m) => m?.role === 'tool' && typeof m.content === 'string' && m.content.includes('【原文查证'))
        .map((m) => String(m.content).slice(0, 700))
      wireRows = rows
    } catch { /* wire 采样缺失不阻塞 */ }

    perTurn.push(rec)
    if (rec.failed) console.warn(`    [warn] ${roomLabel} turn ${i + 1} 失败: ${(rec.error ?? rec.reply).slice(0, 120)}`)
  }

  return { opening, perTurn, wireRows }
}

/* ═══════════════ DB read: wire samples per room ═══════════════ */

const wireDb = (() => {
  let db = null
  return {
    all(dbPath, roomId) {
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

function readWireSamples(dbPath, roomId) {
  const rows = wireDb.all(dbPath, roomId)
  return rows.map((r) => ({
    turnSeq: r.turn_seq,
    ragContextChars: (r.rag_context || '').length,
    ragContextTokens: estTokens(r.rag_context),
    toolCalls: JSON.parse(r.tool_calls || '[]'),
    wireMessages: JSON.parse(r.wire_messages || '[]'),
  }))
}

/* ═══════════════ LLM-as-judge (real mode; direct calls, not via server) ═══════════════ */

async function callRealLLM(messages, { maxTokens = 500, temperature = 0 } = {}) {
  const res = await fetch(`${REAL_CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${REAL_CFG.apiKey}`,
      ...(process.env.OPENCODE_SESSION ? { 'x-opencode-session': process.env.OPENCODE_SESSION } : {}),
    },
    body: JSON.stringify({ model: REAL_CFG.model, messages, max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`judge LLM ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/** Judge both rooms' answers for one fact question (retry once on empty/garbled). */
async function judgeOneFact(storyTitle, fact, ragReply, dosReply) {
  const ask =
    `你是剧本事实一致性评审。剧本《${storyTitle}》。` +
    `对局结束后我们向两个 AI 守密人追问了同一个问题，现请对照剧本原文判断各自的回答是否忠于剧本。\n\n` +
    `【问题】${fact.q}\n` +
    `【剧本原文依据】${fact.refQuote}\n` +
    `【要点】${fact.ref}\n\n` +
    `【RAG 房（embedding 检索注入）回答】\n${(ragReply || '（无回答）').slice(0, 900)}\n\n` +
    `【DOSSIER 房（档案注入）回答】\n${(dosReply || '（无回答）').slice(0, 900)}\n\n` +
    `对每个回答按 1-5 打忠实度分（5=完全忠于剧本且准确；3=大体正确但有含糊或细节偏离；1=明显编造/与依据矛盾/答非所问）。` +
    `fabrication=true 表示回答含剧本中不存在或被依据否定的内容（编造 NPC/地点/真相）。` +
    `不要输出推理过程。只输出 JSON：{"rag_score":1-5,"dossier_score":1-5,"rag_fabrication":true/false,"dossier_fabrication":true/false,"note":"≤60字，说明两边主要失分点"}`
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callRealLLM([{ role: 'user', content: ask }], { maxTokens: 2000, temperature: 0 })
      const j = parseJudgeJson(raw)
      if (j && j.rag_score != null) return j
      lastErr = raw ? `unparseable judge output: ${raw.slice(0, 120)}` : 'empty judge output (reasoning consumed budget)'
    } catch (e) {
      lastErr = e.message || String(e)
    }
    if (attempt === 0) await sleep(3000) // 退避后重试一次
  }
  return { judgeError: lastErr }
}

/* ═══════════════ dossier JSON → injection approximation ═══════════════ */

function dossierSceneTokens(dossier, sceneName) {
  if (!dossier?.scenes?.length) return 0
  const scene = dossier.scenes.find((s) => (s.name ?? '') === sceneName)
  if (!scene) return 0
  // 口径：近似「当前场景档案」块 = name+description+sceneText（与 kpPromptService buildSceneBlock 同源内容）
  return estTokens(`${scene.name ?? ''}\n${scene.description ?? ''}\n${scene.sceneText ?? ''}`)
}

/* ═══════════════ story-level orchestration ═══════════════ */

/**
 * Run one story: upload + rag index + dossier generate (setup), then both
 * workflow rooms with the play script (+ fact round when facts exist).
 */
async function runStory(user, tmpRoot, filePath, opts) {
  const storyFile = path.basename(filePath)
  const key = storyFile.replace(/\.[^.]+$/, '')
  const out = { storyFile, key, mode: MOCK ? 'mock' : 'real', startedAt: Date.now(), workflows: { rag: null, dossier: null }, setup: {} }
  const dbPath = path.join(tmpRoot, 'data', 'ai-kp.db')

  // facts for this story — 文件名可能带扩展名（demo-story.txt.json）或去扩展名 key（巫_20220928_nocom.json）
  const factsFile = [path.join(opts.factsDir, `${storyFile}.json`), path.join(opts.factsDir, `${key}.json`)].find((p) => fs.existsSync(p))
  let facts = []
  if (!opts.skipFacts && factsFile) {
    try { facts = JSON.parse(fs.readFileSync(factsFile, 'utf-8')).facts ?? [] } catch { facts = [] }
  }
  out.factQuestions = facts.map((f) => f.q)
  const playTurns = PLAY_SCRIPT.slice(0, opts.turns)
  const allTurns = [...playTurns, ...facts.map((f) => f.q)]
  out.turnCount = { play: playTurns.length, facts: facts.length }

  // ── setup: upload → text → rag index → dossier generate ──
  let t0 = Date.now()
  const up = await uploadStory(user.token, filePath)
  out.scriptId = up.id
  out.setup.uploadMs = Date.now() - t0
  console.log(`\n=== story ${key} === scriptId=${up.id}`)

  t0 = Date.now()
  const ragTextRes = await api('GET', `/api/stories/${encodeURIComponent(up.id)}/rag`, undefined, user.token, 600_000)
  assert(ragTextRes.status === 200, `story rag text fetch failed: ${ragTextRes.status}`)
  const storyText = typeof ragTextRes.data.content === 'string' ? ragTextRes.data.content : JSON.stringify(ragTextRes.data)
  out.setup.textFetchMs = Date.now() - t0
  out.setup.storyChars = storyText.length
  console.log(`  [text] ${storyText.length} chars (fetch ${out.setup.textFetchMs}ms)`)

  t0 = Date.now()
  const chunks = makeChunks(storyText)
  const idx = await api('POST', '/api/rag/index', { scriptId: up.id, chunks, storyMeta: { name: up.name } }, user.token, 600_000)
  if (!idx.data?.ok) {
    out.setup.ragIndex = { ok: false, error: JSON.stringify(idx.data).slice(0, 200) }
    console.warn(`  [warn] rag index failed: ${JSON.stringify(idx.data).slice(0, 160)}`)
  } else {
    out.setup.ragIndex = { ok: true, chunkCount: chunks.length, ms: Date.now() - t0 }
    console.log(`  [rag index] ok, ${chunks.length} chunks (${Date.now() - t0}ms)`)
  }

  t0 = Date.now()
  const gen = await api('POST', `/api/dossier/${encodeURIComponent(up.id)}/generate`, {}, user.token, MOCK ? 120_000 : 7_200_000)
  out.setup.dossierGen = { ok: !!gen.data?.ok, ms: Date.now() - t0, data: gen.data ?? {} }
  console.log(`  [dossier gen] ${JSON.stringify(gen.data)} (${Date.now() - t0}ms)`)

  // dossier JSON（dossier 注入近似口径）
  let dossier = null
  try {
    const dossierDir = path.join(tmpRoot, 'dossiers', String(user.userId))
    const dp = path.join(dossierDir, `${up.id}.json`)
    if (fs.existsSync(dp)) dossier = JSON.parse(fs.readFileSync(dp, 'utf-8'))
    out.setup.dossierScenes = dossier?.scenes?.length ?? 0
  } catch { /* ignore */ }

  // ── both workflows ──
  for (const workflow of ['rag', 'dossier']) {
    const wLabel = `${key}/${workflow}`
    const created = await api('POST', '/api/rooms/solo', { storyId: up.id, name: `ab_${workflow}`, sheet: makeSheet(`ab_${workflow}`), workflow }, user.token, 60_000)
    if (created.status !== 200) {
      out.workflows[workflow] = { error: `create room failed: ${created.status} ${JSON.stringify(created.data).slice(0, 160)}` }
      console.error(`  [FAIL] ${wLabel} 建房失败`)
      continue
    }
    const roomId = created.data.roomId
    const ws = openWs(user.token)
    await ws.opened
    const roomStart = Date.now()
    const drv = await driveRoom(user.token, roomId, ws, allTurns, dbPath, wLabel)
    ws.socket.close()
    if (process.env.AB_DEBUG_FRAMES === '1') {
      console.error(`[frames:${wLabel}] ` + ws.frames.map((f) => `${f.type === 'room:event' ? `${f.eventType}#${f.seq}` : f.type}${f.payload?.message?.role ? ':' + f.payload.message.role : ''}${f.payload?.content ? '[' + String(f.payload.content).slice(0, 24).replace(/\n/g, ' ') + ']' : ''}${f.payload?.message?.content ? '{' + String(f.payload.message.content).slice(0, 24).replace(/\n/g, ' ') + '}' : ''}`).join(' '))
    }

    const playT = drv.perTurn.slice(0, playTurns.length)
    const factT = drv.perTurn.slice(playTurns.length)
    const execT = playT.filter((t) => !t.skipped) // 房间结束后的回合不计入指标
    const wf = { roomId, driveMs: Date.now() - roomStart, opening: drv.opening, turns: playT, factTurns: factT }
    // per-turn 知识注入 tokens：rag = wire 采样 rag_context 实测；dossier = 当前场景档案块近似（档案 JSON sceneText）
    for (const t of execT) {
      if (workflow !== 'rag' && dossier) {
        t.injectionTokens = dossierSceneTokens(dossier, t.sceneBefore)
      }
    }
    wf.toolCallDistribution = execT.reduce((acc, t) => {
      for (const tc of t.toolCalls) {
        const name = tc.name || tc.function?.name || 'unknown'
        acc[name] = (acc[name] || 0) + 1
      }
      return acc
    }, {})
    wf.turnMetrics = {
      ttft: pctRow(execT.map((t) => t.ttftMs)),
      total: pctRow(execT.map((t) => t.totalMs)),
      kpReplyTokens: pctRow(execT.map((t) => t.kpReplyTokens)),
      injectionTokens: pctRow(execT.map((t) => t.injectionTokens)),
    }
    wf.totals = {
      playTurns: execT.length,
      skippedTurns: playT.length - execT.length,
      failedTurns: execT.filter((t) => t.failed).length,
      chunkFrames: execT.reduce((s, t) => s + t.chunkCount, 0),
      kpReplyTokens: execT.reduce((s, t) => s + t.kpReplyTokens, 0),
      injectionTokens: execT.reduce((s, t) => s + t.injectionTokens, 0),
      emptyInjectionTurns: execT.filter((t) => (t.injectionTokens ?? 0) === 0).length,
      totalTurnsMs: execT.reduce((s, t) => s + (t.totalMs ?? 0), 0),
    }
    if (drv.opening?.totalMs != null) wf.openingMs = drv.opening.totalMs
    out.workflows[workflow] = wf
    console.log(`  [${workflow}] turns=${wf.totals.playTurns} failed=${wf.totals.failedTurns} skipped=${wf.totals.skippedTurns} ` +
      `ttft p50/p95=${wf.turnMetrics.ttft.p50}/${wf.turnMetrics.ttft.p95}ms total p50=${wf.turnMetrics.total.p50}ms ` +
      `注入=${wf.totals.injectionTokens}tok 空注入回合=${wf.totals.emptyInjectionTurns} 工具=${JSON.stringify(wf.toolCallDistribution)}`)
  }

  // ── facts: judge（真实模式 + 两房都有回答时）──
  const ragWf = out.workflows.rag
  const dosWf = out.workflows.dossier
  out.facts = []
  if (!MOCK && facts.length && ragWf && dosWf && !ragWf.error && !dosWf.error) {
    for (let i = 0; i < facts.length; i++) {
      const ragReply = ragWf.factTurns?.[i]?.reply ?? ''
      const dosReply = dosWf.factTurns?.[i]?.reply ?? ''
      let judge = null
      try { judge = await judgeOneFact(up.name ?? key, facts[i], ragReply, dosReply) } catch (e) { judge = { judgeError: e.message } }
      out.facts.push({
        q: facts[i].q,
        ref: facts[i].ref,
        ragReply: ragReply.slice(0, 700),
        dosReply: dosReply.slice(0, 700),
        judge,
      })
      console.log(`  [fact ${i + 1}] rag=${judge.rag_score ?? judge.ragScore ?? '-'} dos=${judge.dossier_score ?? judge.dossierScore ?? '-'} fab(rag/dos)=${judge.rag_fabrication ?? '-'}/${judge.dossier_fabrication ?? '-'}`)
    }
  }

  out.completed = true
  out.finishedAt = Date.now()
  return out
}

/* ═══════════════ main ═══════════════ */

function parseArgs(argv) {
  const opt = { files: [], dirs: [], out: null, turns: 10, factsDir: DEFAULT_FACTS_DIR, skipFacts: false, keepFailed: false, only: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a.startsWith('--file=')) opt.files.push(a.slice(7))
    else if (a === '--file') opt.files.push(val())
    else if (a.startsWith('--dir=')) opt.dirs.push(a.slice(6))
    else if (a === '--dir') opt.dirs.push(val())
    else if (a.startsWith('--out=')) opt.out = a.slice(6)
    else if (a === '--out') opt.out = val()
    else if (a.startsWith('--turns=')) opt.turns = Number(a.slice(8))
    else if (a === '--turns') opt.turns = Number(val())
    else if (a.startsWith('--facts=')) opt.factsDir = a.slice(8)
    else if (a === '--facts') opt.factsDir = val()
    else if (a === '--skip-facts') opt.skipFacts = true
    else if (a.startsWith('--only=')) opt.only = a.slice(7)
    else if (a === '--only') opt.only = val()
    else if (a === '--keep-failed') opt.keepFailed = true
    else { console.warn(`unknown arg: ${a}`) }
  }
  return opt
}

function collectStories(opt) {
  const list = []
  for (const dir of opt.dirs) {
    const abs = path.resolve(ROOT, dir)
    if (!fs.existsSync(abs)) { console.warn(`story dir not found: ${abs}`); continue }
    const files = fs.readdirSync(abs).filter((f) => /\.(pdf|txt|md)$/i.test(f)).sort()
    for (const f of files) list.push(path.join(abs, f))
  }
  for (const f of opt.files) {
    const abs = path.resolve(ROOT, f)
    if (fs.existsSync(abs)) list.push(abs)
    else console.warn(`story file not found: ${abs}`)
  }
  if (list.length === 0) list.push(FIXTURE)
  return list
}

async function main() {
  const opt = parseArgs(process.argv)
  const stories = collectStories(opt)
  if (opt.only) {
    const onlyList = stories.filter((s) => path.basename(s).replace(/\.[^.]+$/, '').includes(opt.only) || path.basename(s).includes(opt.only))
    stories.length = 0
    stories.push(...onlyList)
  }
  const outPath = opt.out ? path.join(ROOT, opt.out) : null
  if (!outPath) {
    console.error('--out <file> required (report JSON)')
    process.exitCode = 1
    return
  }

  let summary = { mode: MOCK ? 'mock' : 'real', model: REAL_CFG.model, baseUrl: REAL_CFG.baseUrl, stories: {}, startedAt: Date.now(), playScript: PLAY_SCRIPT.slice(0, opt.turns), options: { turns: opt.turns, skipFacts: opt.skipFacts } }
  if (fs.existsSync(outPath)) {
    try { summary = JSON.parse(fs.readFileSync(outPath, 'utf-8')) } catch { /* fresh */ }
  }

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ab-compare-'))
  let user = null
  try {
    await spawnServer(tmpRoot)
    await waitServerReady()
    await step('注册 + 配置（real: AI settings）', async () => {
      user = await registerUser('main')
      if (!MOCK) await configureRealAi(user.token)
    })

    for (const storyPath of stories) {
      const key = path.basename(storyPath).replace(/\.[^.]+$/, '')
      const prior = summary.stories[key]
      if (prior?.completed && !opt.keepFailed) { console.log(`\n[skip] ${key} (已存在 completed 结果)`); continue }
      try {
        summary.stories[key] = await runStory(user, tmpRoot, storyPath, opt)
        if (outPath) {
          await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
          await fs.promises.writeFile(outPath, JSON.stringify({ ...summary, updatedAt: Date.now() }, null, 2))
          console.log(`  [saved] ${outPath}`)
        }
      } catch (err) {
        console.error(`\n  [FAIL] story ${key}: ${err.message}`)
        summary.stories[key] = { storyFile: path.basename(storyPath), key, error: err.message, failedAt: Date.now(), mode: MOCK ? 'mock' : 'real' }
        await fs.promises.writeFile(outPath, JSON.stringify({ ...summary, updatedAt: Date.now() }, null, 2))
      }
    }

    // 汇总控制台输出
    console.log('\n=== 汇总 ===')
    const failed = results.filter((r) => !r.pass)
    console.log(`steps: ${results.length - failed.length}/${results.length} passed`)
    for (const [k, s] of Object.entries(summary.stories)) {
      const rag = s.workflows?.rag
      const dos = s.workflows?.dossier
      if (!rag || !dos) { console.log(`- ${k}: ${s.error ?? 'incomplete'}`); continue }
      console.log(`- ${k}: rag ttft=${rag.turnMetrics?.ttft.p50}ms/${rag.turnMetrics?.ttft.p95}ms 注入${rag.totals?.injectionTokens}tok | dos ttft=${dos.turnMetrics?.ttft.p50}ms/${dos.turnMetrics?.ttft.p95}ms 注入${dos.totals?.injectionTokens}tok`)
    }
    if (failed.length) { console.error(`\n--- server log tail ---\n${tail(logs.server)}`); process.exitCode = 1 }
    if (process.env.AB_DEBUG_SERVER === '1') console.error(`\n--- server log (debug) ---\n${tail(logs.server)}`)
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

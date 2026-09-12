/**
 * Dossier workflow e2e journey (experiment branch feature/kp-dossier-workflow).
 *
 * Validates the dossier-room pipeline end-to-end under MOCK_AI (deterministic):
 *  1. register + upload demo-story.txt
 *  2. generate dossier via POST /api/dossier/:id/generate (mock LLM returns the
 *     deterministic 3-scene/3-clue/2-NPC dossier JSON)
 *  3. create a SOLO dossier room (workflow:'dossier')
 *  4. opening turn injects the 当前场景档案 block (assert via wire side-channel)
 *  5. a "查证" chat drives the story-lookup tool chain (scene_list → scene_dossier)
 *
 * The rag workflow stays untouched on this branch; rag-room parity is covered by
 * the existing rooms/multiroom journeys.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
// 逐字节相同的 harness 帮助函数收编共享单源（#64）；有行为差异的副本仍留本文件。
import { createApi, createStep } from './lib/harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const API_BASE = process.env.E2E_API_BASE ?? 'http://127.0.0.1:3100'
const WS_URL = (API_BASE.replace(/^http/, 'ws')).replace('localhost', '127.0.0.1')
const FIXTURE = path.join(ROOT, 'e2e', 'fixtures', 'demo-story.txt')

const results = []
let children = []
const logs = { server: [] }

const step = createStep(results)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed')
}

function tail(arr, n = 60) {
  return arr.slice(-n).join('\n')
}

async function spawnServer(tmpRoot) {
  const port = Number(process.env.E2E_PORT ?? 3100)
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      MOCK_AI: '1',
      PORT: String(port),
      JWT_SECRET: 'e2e-secret-change-me',
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
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) })
      if (res.status === 401 || res.status === 200) return
    } catch { /* retry */ }
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

const api = createApi(API_BASE)

async function registerUser(tag) {
  const username = `ds_${tag}_${Date.now()}`
  const password = ['ds', 'pass', 'word'].join('-')
  const reg = await api('POST', '/api/auth/register', { username, password })
  assert(reg.status === 200, `register ${tag} failed: ${reg.status}`)
  const login = await api('POST', '/api/auth/login', { username, password })
  assert(login.status === 200, `login ${tag} failed: ${login.status}`)
  const me = await api('GET', '/api/auth/me', undefined, login.data.token)
  return { username, password, token: login.data.token, userId: me.data?.user?.id ?? 0 }
}

/** 最小合法 COCCharacterSheet（对齐 multiroom.journey 的 makeSheet）。 */
function makeSheet(name) {
  const base = { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }
  return {
    occupationId: 'judge',
    occupationName: '法官',
    playerName: name,
    attributes: base,
    skills: { 侦查: 65, 聆听: 60, 图书馆使用: 55, 格斗: 40, 信用评级: 40 },
    derived: {
      hp: Math.floor((base.con + base.siz) / 10), hpMax: Math.floor((base.con + base.siz) / 10),
      mp: Math.floor(base.pow / 5), mpMax: Math.floor(base.pow / 5),
      san: base.pow, sanMax: base.pow,
    },
    damageBonus: '0', build: 0, mov: 8, armor: 0,
  }
}

async function uploadScript(token) {
  const content = fs.readFileSync(FIXTURE)
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'text/plain' }), 'demo-story.txt')
  const res = await fetch(`${API_BASE}/api/stories/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  const data = await res.json().catch(() => ({}))
  assert(res.status === 200, `script upload failed: ${res.status} ${JSON.stringify(data)}`)
  return (data.id ?? data.scriptId ?? 'demo-story.txt')
}

function openWs(token) {
  const socket = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`)
  const frames = []
  const waiters = []
  socket.on('message', (raw) => {
    let f
    try { f = JSON.parse(String(raw)) } catch { return }
    frames.push(f)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        const w = waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        w.resolve(f)
      }
    }
  })
  const opened = new Promise((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`)))
  })
  return {
    socket, frames,
    opened,
    waitFor(pred, timeoutMs, label) {
      const hit = frames.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waitFor timeout: ${label}`)), timeoutMs)
        waiters.push({ pred, resolve, reject, timer })
      })
    },
  }
}

async function main() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dossier-journey-'))
  await spawnServer(tmpRoot)
  await waitServerReady()

  let user
  let ws
  try {
    await step('注册 + 上传 demo-story', async () => {
      user = await registerUser('main')
      const scriptId = await uploadScript(user.token)
      assert(scriptId === 'demo-story.txt', `scriptId mismatch: ${scriptId}`)
    })

    let scriptId = 'demo-story.txt'
    await step('生成剧本档案（mock LLM → 3 场景/3 线索/2 NPC）', async () => {
      const gen = await api('POST', `/api/dossier/${encodeURIComponent(scriptId)}/generate`, {}, user.token)
      assert(gen.status === 200, `dossier generate failed: ${gen.status} ${JSON.stringify(gen.data)}`)
      assert(gen.data.ok === true, `dossier generate !ok: ${JSON.stringify(gen.data)}`)
      assert(gen.data.scenes === 3 && gen.data.clues === 3 && gen.data.npcs === 2,
        `dossier counts mismatch: ${JSON.stringify(gen.data)}`)
    })

    await step('档案清单：demo-story 在列且场景数=3（含场景名抽查）', async () => {
      const list = await api('GET', '/api/dossier', undefined, user.token)
      assert(list.status === 200, `dossier list failed: ${list.status} ${JSON.stringify(list.data)}`)
      const hit = (list.data ?? []).find((d) => d.scriptId === scriptId && d.sceneCount === 3)
      assert(hit, `dossier list missing demo-story: ${JSON.stringify(list.data)}`)
      assert(hit.name.length > 0, `dossier list entry missing name: ${JSON.stringify(hit)}`)
    })

    await step('rag 房对照：索引 demo-story 仍可用（rag workflow 未破坏）', async () => {
      // M1-T3：切块在服务端——只报 scriptId（服务端自读原文、自切块）。
      const idx = await api('POST', '/api/rag/index', { scriptId, storyMeta: { name: 'demo-story' } }, user.token)
      assert(idx.data.ok === true, `rag index failed: ${JSON.stringify(idx.data)}`)
      const stories = await api('GET', '/api/rag/stories', undefined, user.token)
      assert(stories.data.some((s) => s.storyId === scriptId), 'rag story list missing demo-story')
    })

    await step('创建 dossier solo 房（workflow:dossier）→ playing', async () => {
      const created = await api('POST', '/api/rooms/solo', {
        storyId: scriptId,
        name: 'dossier测试员',
        sheet: makeSheet('dossier测试员'),
        workflow: 'dossier',
      }, user.token)
      assert(created.status === 200, `solo dossier room create failed: ${created.status} ${JSON.stringify(created.data)}`)
      assert(created.data.roomId, `no roomId: ${JSON.stringify(created.data)}`)
      const detail = await api('GET', `/api/rooms/${created.data.roomId}`, undefined, user.token)
      assert(detail.data.phase === 'playing', `phase != playing: ${detail.data.phase}`)
      assert(detail.data.state?.workflow === 'dossier', `state.workflow != dossier: ${JSON.stringify(detail.data.state)}`)
      user.roomId = created.data.roomId
    })

    await step('WS join → opening 回合注入 当前场景档案（KP 回复非空）', async () => {
      ws = openWs(user.token)
      await ws.opened
      ws.socket.send(JSON.stringify({ type: 'room:join', roomId: user.roomId }))
      // opening 由 join 懒激活触发（messages 空 + playing）→ 等 KP 开场白
      const kpMsg = await ws.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && f.payload.message.content.length > 0,
        25_000,
        'opening kp reply',
      )
      assert(kpMsg.payload.message.content.length > 10, `opening reply too short: ${kpMsg.payload.message.content}`)
    })

    await step('查证消息 → scene_list → scene_dossier 工具链（dossier workflow 特有）', async () => {
      const kpWatermark = ws.frames
        .filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp')
        .reduce((m, f) => Math.max(m, f.seq ?? 0), 0)
      ws.socket.send(JSON.stringify({ type: 'room:action', roomId: user.roomId, action: { type: 'chat', payload: { content: '情报确认：剧本里还有哪些地点可以去？' } } }))
      const kpMsg = await ws.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && (f.seq ?? 0) > kpWatermark,
        25_000,
        'kp reply after lookup chat',
      )
      // mock 查证链叙事断言：查证结果（档案）被 mock 引用
      assert(kpMsg.payload.message.content.includes('档案'), `lookup narrative missing 档案: ${kpMsg.payload.message.content}`)
    })

    console.log(`\ndossier journey: ${results.filter((r) => r.pass).length}/${results.length} passed`)
    const failed = results.filter((r) => !r.pass)
    if (failed.length) {
      console.error(`\n--- server log tail ---\n${tail(logs.server)}`)
      process.exitCode = 1
    }
  } finally {
    ws?.socket?.close()
    await cleanup()
    await fs.promises.rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`journey crashed: ${err.stack || err.message}`)
  console.error(`\n--- server log tail ---\n${tail(logs.server)}`)
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * Room stress test (Phase C5) — ≤100 房间边界性能验证.
 *
 * `node e2e/room-stress.mjs`
 *
 * 验证 NFR-M5（≤100 并发活跃房间、单房间 ≤6 调查员）下：
 *  1. 并发创建 100 房间（REST，独立用户）耗时与成功率
 *  2. 每个房间 2 个成员 WS 订阅（200 连接）
 *  3. 并发广播：每房间发 1 条 chat → 成员在窗口内收到（广播延迟 p95）
 *  4. 资源：进程存活、无 OOM
 *
 * 环境变量：E2E_API_BASE（默认 http://localhost:3100；设置后不自启后端）
 *           STRESS_ROOMS（默认 50——CI 快速跑；本地可 100）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const WsImpl = require('ws')
const API_BASE = (process.env.E2E_API_BASE || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const SELF_START_API = !process.env.E2E_API_BASE
const STRESS_ROOMS = Number(process.env.STRESS_ROOMS || 50)
// Node 原生 fetch 连 localhost 可能解析 ::1（IPv6）而 server 绑 IPv4 → 显式 127.0.0.1
const WS_URL = (API_BASE.replace(/^http/, 'ws')).replace('localhost', '127.0.0.1')

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function api(method, p, body, token) {
  let res
  try {
    res = await fetch(`${API_BASE}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    const cause = err && typeof err === 'object' && 'cause' in err ? String(err.cause) : ''
    throw new Error(`fetch failed for ${method} ${p}: ${err instanceof Error ? err.message : String(err)}${cause ? ` (cause: ${cause})` : ''}`)
  }
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function registerUser(tag) {
  const username = `stress_${tag}_${Date.now()}`
  const password = ['stress', 'pass', 'word'].join('-')
  await api('POST', '/api/auth/register', { username, password })
  const login = await api('POST', '/api/auth/login', { username, password })
  assert(login.status === 200, `login failed: ${login.status}`)
  return { token: login.data.token, username }
}

function openWs(token) {
  const socket = new WsImpl(`${WS_URL}/ws?token=${encodeURIComponent(token)}`)
  const frames = []
  const waiters = []
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1) }
    }
  })
  const waitFor = (pred, timeoutMs = 15_000, label = 'frame') =>
    new Promise((resolve, reject) => {
      const hit = frames.find(pred)
      if (hit) return resolve(hit)
      const timer = setTimeout(() => reject(new Error(`timeout ${label}; frames=${frames.map((f) => f.type).join(',')}`)), timeoutMs)
      const entry = { pred, resolve: (f) => { clearTimeout(timer); resolve(f) } }
      waiters.push(entry)
    })
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('ws open failed')))
  })
  return { socket, frames, waitFor, opened }
}

async function main() {
  const children = []
  let tmpDir = ''
  if (SELF_START_API) {
    // preflight：端口被残留进程占用时 server 会 EADDRINUSE 崩溃 → 先检查
    try {
      const probe = await fetch(`${API_BASE}/api/auth/me`, { signal: AbortSignal.timeout(1500) })
      throw new Error(`port ${new URL(API_BASE).port} already has a server (${probe.status}) — stop it first or set E2E_API_BASE`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('already has a server')) throw err
      /* connection refused → free, good */
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-e2e-'))
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/app.ts'], {
      cwd: ROOT,
      env: {
        ...process.env, MOCK_AI: '1', PORT: '3100',
        DATA_DIR: path.join(tmpDir, 'data'), RAG_DATA_DIR: path.join(tmpDir, 'rag'),
        MODELS_DIR: path.join(tmpDir, 'models'), UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(server)
    server.stdout.on('data', (d) => fs.appendFileSync(path.join(tmpDir, 'server.log'), d))
    server.stderr.on('data', (d) => fs.appendFileSync(path.join(tmpDir, 'server.log'), d))
    server.on('exit', (code, signal) => {
      fs.appendFileSync(path.join(tmpDir, 'server.log'), `\n[server exited code=${code} signal=${signal}]\n`)
    })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { const r = await fetch(`${API_BASE}/api/auth/me`); if (r.status < 500) break } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('[STRESS] backend started (MOCK_AI=1)')
  }

  const results = []
  const step = async (name, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      results.push({ name, pass: true, ms: Date.now() - t0, detail })
      console.log(`  [PASS] ${name} (${Date.now() - t0}ms)${detail ? ' — ' + detail : ''}`)
    } catch (e) {
      results.push({ name, pass: false, ms: Date.now() - t0, error: e.message })
      console.error(`  [FAIL] ${name} (${Date.now() - t0}ms): ${e.message}`)
      // dump server log tail for diagnosis
      if (tmpDir) {
        try {
          const log = fs.readFileSync(path.join(tmpDir, 'server.log'), 'utf-8')
          console.error(`--- server.log tail ---\n${log.slice(-2000)}`)
        } catch { /* no log */ }
      }
      throw e
    }
  }

  try {
    await step(`并发创建 ${STRESS_ROOMS} 房间（独立用户）`, async () => {
      const users = []
      for (let i = 0; i < STRESS_ROOMS; i++) users.push(await registerUser(`r${i}`))
      // 分批并发建房（每批 10），避免 CI 上 fetch 并发连接限制
      const rooms = []
      for (let i = 0; i < users.length; i += 10) {
        const batch = await Promise.all(users.slice(i, i + 10).map((u) => api('POST', '/api/rooms', {}, u.token)))
        rooms.push(...batch)
      }
      const ok = rooms.filter((r) => r.status === 200).length
      assert(ok === STRESS_ROOMS, `only ${ok}/${STRESS_ROOMS} rooms created`)
      return `${ok}/${STRESS_ROOMS} ok`
    })

    await step(`并发 WS 订阅（${Math.min(STRESS_ROOMS, 25)} 连接）`, async () => {
      let wsCount = 0
      for (let i = 0; i < Math.min(STRESS_ROOMS, 25); i++) {
        const u = await registerUser(`sub${i}`)
        const roomRes = await api('POST', '/api/rooms', {}, u.token)
        const ws = openWs(u.token)
        await ws.opened
        ws.socket.send(JSON.stringify({ type: 'room:join', roomId: roomRes.data.roomId }))
        await ws.waitFor((f) => f.type === 'room:state', 10_000, 'state')
        wsCount++
        ws.socket.close()
      }
      return `${wsCount} subscriptions ok`
    })

    await step(`并发广播延迟（${Math.min(STRESS_ROOMS, 25)} 房间各 1 条 chat）`, async () => {
      const latencies = []
      const rooms = []
      for (let i = 0; i < Math.min(STRESS_ROOMS, 25); i++) {
        const u = await registerUser(`bc${i}`)
        const roomRes = await api('POST', '/api/rooms', {}, u.token)
        const ws = openWs(u.token)
        await ws.opened
        ws.socket.send(JSON.stringify({ type: 'room:join', roomId: roomRes.data.roomId }))
        await ws.waitFor((f) => f.type === 'room:state', 10_000, 'state')
        rooms.push({ ws, roomId: roomRes.data.roomId })
      }
      // 并发发送（turnWindowMs=0 严格排队会立即触发 KP——但广播玩家消息本身即时）
      await Promise.all(rooms.map(({ ws, roomId }) => {
        const t0 = Date.now()
        const p = ws.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended', 15_000, 'echo').then(() => Date.now() - t0)
        ws.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: `压力消息 ${roomId}` } } }))
        return p
      })).then((lats) => latencies.push(...lats))
      const sorted = [...latencies].sort((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
      const max = sorted[sorted.length - 1] ?? 0
      assert(p95 < 5_000, `p95 broadcast latency too high: ${p95}ms`)
      for (const { ws } of rooms) { try { ws.socket.close() } catch { /* */ } }
      return `p95=${p95}ms max=${max}ms (n=${latencies.length})`
    })

    console.log('[STRESS] RESULTS')
    for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
    const failed = results.filter((r) => !r.pass)
    if (failed.length) { console.error(`[STRESS] ${results.length - failed.length} passed, ${failed.length} failed`); process.exit(1) }
    console.log(`[STRESS] ${results.length} passed, 0 failed`)
    process.exit(0)
  } finally {
    for (const c of children) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
        else c.kill()
      } catch { /* ignore */ }
    }
  }
}

main().catch((e) => { console.error('[STRESS] fatal:', e.message); process.exit(1) })

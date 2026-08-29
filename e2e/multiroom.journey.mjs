#!/usr/bin/env node
/**
 * Multi-client room E2E (Phase B7 双客户端) — `node e2e/multiroom.journey.mjs`
 *
 * 验证服务端房间多人链路（MOCK_AI 后端，两个 WS 客户端）：
 *   1. 注册两个用户 A/B（REST）
 *   2. A 建房（REST）→ 拿邀请码
 *   3. B 用邀请码加入（REST）
 *   4. A/B 各自 WS room:join 订阅同一房间
 *   5. A 发 room:action chat → B 收到 room:event message_appended（全序 seq）
 *   6. B room:sync → 收到全量快照（含刚才的消息）
 *   7. A room:leave / B room:leave → 清理
 *
 * 用法（仓库根）：
 *   node e2e/multiroom.journey.mjs
 * 环境变量：
 *   E2E_API_BASE  后端地址（默认 http://localhost:3100；设置后不自启后端）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Node 24 原生 WebSocket 在 Windows 上连 ws:// 有兼容问题（1006）→ 用 ws 库（server 依赖）。
const require = createRequire(import.meta.url)
const WsImpl = require('ws')
const API_BASE = (process.env.E2E_API_BASE || 'http://localhost:3100').replace(/\/+$/, '')
const SELF_START_API = !process.env.E2E_API_BASE
// vite 服务绑 127.0.0.1；localhost 可能解析到 ::1（IPv6）导致 WS 连不上 → 显式 IPv4。
const WS_URL = (API_BASE.replace(/^http/, 'ws')).replace('localhost', '127.0.0.1')

const results = []
function step(name, fn) {
  const start = Date.now()
  return fn()
    .then(() => {
      results.push({ name, pass: true, ms: Date.now() - start })
      console.log(`  [PASS] ${name} (${Date.now() - start}ms)`)
    })
    .catch((err) => {
      results.push({ name, pass: false, ms: Date.now() - start, error: err.message })
      console.error(`  [FAIL] ${name} (${Date.now() - start}ms): ${err.message}`)
      throw err
    })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed')
}

async function api(method, p, body, token) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function registerUser(tag) {
  const username = `mr_${tag}_${Date.now()}`
  const password = ['mr', 'pass', 'word'].join('-')
  const reg = await api('POST', '/api/auth/register', { username, password })
  assert(reg.status === 200, `register ${tag} failed: ${reg.status}`)
  const login = await api('POST', '/api/auth/login', { username, password })
  assert(login.status === 200, `login ${tag} failed: ${login.status}`)
  const me = await api('GET', '/api/auth/me', undefined, login.data.token)
  return { username, token: login.data.token, userId: me.data?.user?.id ?? 0 }
}

/** 打开 WS（JWT query），返回 { socket, frames, waitFor }。 */
function openWs(token) {
  const socket = new WsImpl(`${WS_URL}/ws?token=${encodeURIComponent(token)}`)
  const frames = []
  const waiters = []
  socket.on('open', () => console.log(`[E2E][ws] open (${token.slice(0, 6)}…)`))
  socket.on('error', (e) => console.error(`[E2E][ws] error: ${e.message || e.type}`))
  socket.on('close', (code, reason) => console.log(`[E2E][ws] close ${code} ${reason?.toString() ?? ''}`))
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        waiters[i].resolve(frame)
        waiters.splice(i, 1)
      }
    }
  })
  const waitFor = (pred, timeoutMs = 15_000, label = 'frame') =>
    new Promise((resolve, reject) => {
      const hit = frames.find(pred)
      if (hit) return resolve(hit)
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`timeout waiting for ${label}; frames: ${frames.map((f) => f.type).join(',')}`))
      }, timeoutMs)
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-e2e-'))
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/app.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MOCK_AI: '1',
        PORT: '3100',
        DATA_DIR: path.join(tmpDir, 'data'),
        RAG_DATA_DIR: path.join(tmpDir, 'rag'),
        MODELS_DIR: path.join(tmpDir, 'models'),
        UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(server)
    server.stdout.on('data', (d) => fs.appendFileSync(path.join(tmpDir, 'server.log'), d))
    server.stderr.on('data', (d) => fs.appendFileSync(path.join(tmpDir, 'server.log'), d))
    // 等后端就绪
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`)
        if (res.status < 500) break
      } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('[E2E] backend started (MOCK_AI=1)')
  } else {
    console.log(`[E2E] using external backend at ${API_BASE}`)
  }

  try {
    let userA, userB, roomId, inviteCode

    await step('注册 A/B 两个用户', async () => {
      userA = await registerUser('a')
      userB = await registerUser('b')
      assert(userA.token && userB.token, 'tokens missing')
    })

    await step('A 建房 → 邀请码', async () => {
      const res = await api('POST', '/api/rooms', {}, userA.token)
      assert(res.status === 200 && res.data.ok, `create room failed: ${JSON.stringify(res.data)}`)
      roomId = res.data.roomId
      inviteCode = res.data.inviteCode
      assert(/^[A-Z0-9]{6}$/.test(inviteCode), `bad invite code: ${inviteCode}`)
    })

    await step('B 邀请码加入', async () => {
      const res = await api('POST', '/api/rooms/join', { inviteCode }, userB.token)
      assert(res.status === 200 && res.data.roomId === roomId, `join failed: ${JSON.stringify(res.data)}`)
      const detail = await api('GET', `/api/rooms/${roomId}`, undefined, userA.token)
      assert(detail.data.members.length === 2, `expected 2 members, got ${detail.data.members.length}`)
    })

    let wsA, wsB
    await step('A/B WS room:join 订阅同一房间', async () => {
      wsA = openWs(userA.token)
      wsB = openWs(userB.token)
      await Promise.all([wsA.opened, wsB.opened])
      wsA.socket.send(JSON.stringify({ type: 'room:join', roomId }))
      wsB.socket.send(JSON.stringify({ type: 'room:join', roomId }))
      await Promise.all([
        wsA.waitFor((f) => f.type === 'room:state' && f.roomId === roomId, 10_000, 'A room:state'),
        wsB.waitFor((f) => f.type === 'room:state' && f.roomId === roomId, 10_000, 'B room:state'),
      ])
    })

    await step('C2：同账号双连接（A 设备2）订阅同房间 → 收到同一广播', async () => {
      // A 用同一 token 开第二个 WS（模拟同账号另一设备）
      const wsA2 = openWs(userA.token)
      await wsA2.opened
      wsA2.socket.send(JSON.stringify({ type: 'room:join', roomId }))
      await wsA2.waitFor((f) => f.type === 'room:state' && f.roomId === roomId, 10_000, 'A2 room:state')
      // A2 发消息 → A1 与 B 都收到同一 seq
      wsA2.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '设备2 发来的消息。' } } }))
      const evA1 = await wsA.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '设备2 发来的消息。', 15_000, 'A1 sees A2 msg')
      const evB2 = await wsB.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '设备2 发来的消息。', 15_000, 'B sees A2 msg')
      assert(evA1.seq === evB2.seq, `seq mismatch across devices: A1=${evA1.seq} B=${evB2.seq}`)
      wsA2.socket.send(JSON.stringify({ type: 'room:leave', roomId }))
      wsA2.socket.close()
    })

    await step('A 发 chat → B 收到 message_appended（同 seq）', async () => {
      wsA.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我调查一下书架。' } } }))
      const evB = await wsB.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我调查一下书架。', 15_000, 'B message event')
      assert(evB.payload.message.content === '我调查一下书架。', `content mismatch: ${evB.payload.message.content}`)
      assert(evB.payload.author.userId === userA.userId, `author mismatch: ${evB.payload.author.userId} != ${userA.userId}`)
      assert(typeof evB.payload.message.id === 'string' && typeof evB.payload.message.timestamp === 'number', '完整 Message（id/timestamp）缺失')
      assert(typeof evB.seq === 'number' && evB.seq > 0, 'seq missing')
      // A 自己也应收到（全序广播）
      const evA = await wsA.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我调查一下书架。', 15_000, 'A message event')
      assert(evA.seq === evB.seq, `seq mismatch: A=${evA.seq} B=${evB.seq}`)
    })

    await step('B room:sync lastSeq=0 → 全量快照兜底', async () => {
      // lastSeq=0（缺口超过事件日志窗口）→ 全量快照兜底
      wsB.socket.send(JSON.stringify({ type: 'room:sync', roomId, lastSeq: 0 }))
      const state = await wsB.waitFor((f) => f.type === 'room:state' && f.roomId === roomId && (f.seq ?? 0) > 0, 10_000, 'B sync full state')
      const msgs = state.snapshot?.messages ?? []
      assert(msgs.some((m) => m.content === '我调查一下书架。'), `snapshot missing chat message; msgs=${JSON.stringify(msgs).slice(0, 120)}`)
    })

    await step('A 发侦查 → B 收到 KP 回合回复（message_appended kp）', async () => {
      wsA.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我侦查一下书架。' } } }))
      // B 应收到：玩家消息 + KP 回复（mock 侦查 → skill_check → grant_clue → 收尾）
      const kpMsg = await wsB.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp',
        20_000,
        'B kp reply',
      )
      assert(kpMsg.payload.message.content.length > 0, 'kp reply empty')
      // A 也应收到同一 KP 回复（全序广播）
      const kpMsgA = await wsA.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp',
        20_000,
        'A kp reply',
      )
      assert(kpMsgA.seq === kpMsg.seq, `kp seq mismatch: A=${kpMsgA.seq} B=${kpMsg.seq}`)
      // 骰子展示消息（skill_check 的 displayMessage）也应广播
      const dice = await wsB.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && typeof f.payload?.message?.content === 'string' && f.payload.message.content.includes('检定'),
        20_000,
        'B dice display',
      )
      assert(dice.payload.message.content.includes('侦查'), `dice content mismatch: ${dice.payload.message.content}`)
    })

    await step('B room:sync 增量补齐（lastSeq 后的事件，非全量）', async () => {
      // B 记当前最新 seq（KP 回合后），A 再发一条消息
      const beforeSeq = wsB.frames.filter((f) => f.type === 'room:event').reduce((m, f) => Math.max(m, f.seq ?? 0), 0)
      wsA.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我检查一下门。' } } }))
      // 等 B 实时收到这条消息（确认 seq 已前进）
      await wsB.waitFor((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我检查一下门。', 15_000, 'B live msg')
      // B 用「错过」的 lastSeq sync → 服务端增量补发（room:event，非全量 state）
      wsB.socket.send(JSON.stringify({ type: 'room:sync', roomId, lastSeq: beforeSeq }))
      await wsB.waitFor((f) => f.type === 'room:sync:done' && f.roomId === roomId, 10_000, 'B sync done')
      // 增量路径验证：sync 后 B 又收到一条「我检查一下门。」（增量补发，与实时那条重复）
      const msgCount = wsB.frames.filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我检查一下门。').length
      assert(msgCount >= 2, `expected >=2 copies (live + incremental), got ${msgCount}`)
      // 且增量 sync 未触发全量 state（增量窗口内）
      const statesAtSyncStart = wsB.frames.filter((f) => f.type === 'room:state').length
      await new Promise((r) => setTimeout(r, 300))
      const statesAtSyncEnd = wsB.frames.filter((f) => f.type === 'room:state').length
      assert(statesAtSyncEnd === statesAtSyncStart, `unexpected full snapshot on incremental sync: ${statesAtSyncEnd} != ${statesAtSyncStart}`)
    })

    await step('A/B 窗口内各发一条 → 合并为一次 KP 回合（D4）', async () => {
      // 记录当前最大 kp 回复 seq（避免与上一回合的回复混淆）
      const kpMaxSeq = wsB.frames
        .filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp')
        .reduce((m, f) => Math.max(m, f.seq ?? 0), 0)
      // A、B 在默认 5s 窗口内先后发消息
      wsA.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我搜索书架。' } } }))
      await new Promise((r) => setTimeout(r, 300))
      wsB.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我查看窗户。' } } }))
      // 等窗口 flush 后的 KP 回合回复（seq 必须大于步骤开始时的水位）
      const kpReply = await wsB.waitFor(
        (f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && (f.seq ?? 0) > kpMaxSeq,
        20_000,
        'merged kp reply',
      )
      assert(kpReply.payload.message.content.length > 0, 'merged kp reply empty')
      // 合并窗口只触发一次 KP 回合（窗口内两条 → 1 次推理）；等窗口稳定后再断言
      await new Promise((r) => setTimeout(r, 6_000))
      const kpAfter = wsB.frames
        .filter((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.role === 'kp' && (f.seq ?? 0) > kpMaxSeq)
        .length
      assert(kpAfter === 1, `expected exactly 1 merged kp reply, got ${kpAfter}`)
      // 两条玩家消息都实时广播了（聊天即时可见）
      const aSeen = wsB.frames.some((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我搜索书架。')
      const bSeen = wsB.frames.some((f) => f.type === 'room:event' && f.eventType === 'message_appended' && f.payload?.message?.content === '我查看窗户。')
      assert(aSeen && bSeen, `both player msgs should be broadcast (A=${aSeen} B=${bSeen})`)
    })

    await step('A/B room:leave 清理', async () => {
      wsA.socket.send(JSON.stringify({ type: 'room:leave', roomId }))
      wsB.socket.send(JSON.stringify({ type: 'room:leave', roomId }))
      wsA.socket.close()
      wsB.socket.close()
    })

    console.log('[E2E] RESULTS')
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
    }
    const failed = results.filter((r) => !r.pass)
    if (failed.length > 0) {
      console.error(`[E2E] ${results.length - failed.length} passed, ${failed.length} failed`)
      process.exitCode = 1
    } else {
      console.log(`[E2E] ${results.length} passed, 0 failed`)
    }
  } finally {
    // 等子进程退出（process.exit 会跳过此处导致残留占用端口）
    const exits = []
    for (const c of children) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          // 递归杀子进程树 + 等退出
          try { spawn('pkill', ['-TERM', '-P', String(c.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
          c.kill()
        }
        exits.push(new Promise((resolve) => {
          const t = setTimeout(resolve, 3000)
          c.once('exit', () => { clearTimeout(t); resolve() })
        }))
      } catch { /* ignore */ }
    }
    await Promise.all(exits)
    // ws 连接等 handle 会阻止进程自然退出 → 显式退出
    process.exit(process.exitCode ?? 0)
  }
}

main().catch((err) => {
  console.error('[E2E] JOURNEY FAILED:', err.message)
  console.error('[E2E] RESULTS')
  for (const r of results) {
    console.error(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
  }
  process.exit(1)
})

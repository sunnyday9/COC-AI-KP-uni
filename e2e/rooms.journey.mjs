#!/usr/bin/env node
/**
 * Rooms browser E2E (Phase C2 客户端接入) — `node e2e/rooms.journey.mjs`
 *
 * Drives the 多人房间 UI in real browsers against a MOCK_AI backend:
 *
 *   context A (房主)  register → create room → copy invite code
 *   context B (成员)  register → join by invite code
 *   A 进入房间 → 成员列表 2 人
 *   A 发聊天 → B 页面实时收到（room:event 广播）
 *   B 发聊天 → A 页面实时收到
 *   A 发「侦查」→ B 收到 KP 回合回复（mock 侦查 → skill_check → grant_clue）
 *   断线重连：B 页面 reload → room:sync 增量补齐（消息仍在）
 *
 * Usage (from the repo root):
 *   node e2e/rooms.journey.mjs
 * Environment overrides: E2E_API_BASE / E2E_WEB_BASE / E2E_BROWSER (same as h5.journey)
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const E2E_DIR = path.join(ROOT, 'e2e')
const SHOTS_DIR = path.join(E2E_DIR, 'screenshots')

const API_BASE = (process.env.E2E_API_BASE || 'http://localhost:3100').replace(/\/+$/, '')
const WEB_BASE = (process.env.E2E_WEB_BASE || 'http://127.0.0.1:5175').replace(/\/+$/, '')
const SELF_START_API = !process.env.E2E_API_BASE
const SELF_START_WEB = !process.env.E2E_WEB_BASE

const apiPort = new URL(API_BASE).port || '80'

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

/* ═══════════════════ Logging / step runner ═══════════════════ */

const results = []
function step(name, fn) {
  const start = Date.now()
  return fn()
    .then(() => {
      results.push({ name, pass: true, ms: Date.now() - start })
      console.log(`  [PASS] ${name} (${Date.now() - start}ms)`)
    })
    .catch(async (err) => {
      results.push({ name, pass: false, ms: Date.now() - start, error: err.message })
      console.error(`  [FAIL] ${name} (${Date.now() - start}ms): ${err.message}`)
      throw err
    })
}

let pageA, pageB

async function waitText(p, text, timeout = 25_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'visible' })
}

async function clickBtn(p, text, opts = {}) {
  const loc = p.locator('uni-button').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

async function fillInput(p, placeholder, value) {
  const box = p
    .locator('uni-input, uni-textarea')
    .filter({ has: p.getByText(placeholder, { exact: false }) })
    .first()
  await box.waitFor({ state: 'visible', timeout: 15_000 })
  await box.locator('input, textarea').first().fill(value)
}

async function clickByText(p, text, opts = {}) {
  const loc = p.getByText(text, { exact: false }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

async function captureFailure(p, name) {
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), ms))])
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    const tag = `${Date.now()}-${name.replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 60)}`
    await withTimeout(p.screenshot({ path: path.join(SHOTS_DIR, `rooms-fail-${tag}.png`), fullPage: true }), 10_000)
    const html = await withTimeout(p.content(), 10_000)
    fs.writeFileSync(path.join(SHOTS_DIR, `rooms-fail-${tag}.html`), html, 'utf-8')
  } catch (e) {
    console.error('  (captureFailure also failed:', e.message, ')')
  }
}

/* ═══════════════════ Services ═══════════════════ */

const children = []
const logs = { server: [], web: [] }

function spawnServer(tmpRoot) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      MOCK_AI: '1',
      PORT: String(apiPort),
      JWT_SECRET: 'e2e-secret-change-me',
      DATA_DIR: path.join(tmpRoot, 'data'),
      RAG_DATA_DIR: path.join(tmpRoot, 'rag'),
      UPLOADS_DIR: path.join(tmpRoot, 'uploads'),
      MODELS_DIR: path.join(tmpRoot, 'models'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.server.push(d.toString()))
  child.stderr.on('data', (d) => logs.server.push(d.toString()))
  children.push(child)
  return child
}

function spawnWeb() {
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')], {
    cwd: path.join(ROOT, 'client'),
    env: { ...process.env, VITE_API_BASE: API_BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.web.push(d.toString()))
  child.stderr.on('data', (d) => logs.web.push(d.toString()))
  children.push(child)
  return child
}

async function pollUrl(url, timeoutMs = 120_000, label = url) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) })
      if (res.status < 600) return true
    } catch (e) {
      lastErr = e.message
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  throw new Error(`Timed out waiting for ${label}\n--- server log ---\n${logs.server.slice(-15).join('')}`)
}

function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        // 递归杀子进程树（tsx/uni wrapper 的 node 子进程不会随 SIGTERM 退出，
        // 残留占用 3100 端口导致后续 E2E 失败）
        try { spawn('pkill', ['-TERM', '-P', String(c.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
        c.kill('SIGTERM')
      }
    } catch { /* ignore */ }
  }
}

async function launchBrowser() {
  const explicit = process.env.E2E_BROWSER
  if (explicit) {
    if (explicit === 'msedge' || explicit === 'chrome') return chromium.launch({ channel: explicit })
    return chromium.launch({ executablePath: explicit })
  }
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel })
    } catch { /* next */ }
  }
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (fs.existsSync(p)) {
      try {
        return await chromium.launch({ executablePath: p })
      } catch { /* next */ }
    }
  }
  throw new Error('No browser found — set E2E_BROWSER=msedge|chrome|<path>')
}

/* ═══════════════════ Auth helper ═══════════════════ */

/** Register a fresh user through the settings page (auto-login). */
async function registerUser(p, tag) {
  await p.goto(`${WEB_BASE}/#/pages/settings/index`, { waitUntil: 'domcontentloaded' })
  // 等注册表单真正渲染（.auth-tab 存在），避免匹配到 AppLayout 底栏「设置」文字
  await p.locator('.auth-tab').first().waitFor({ state: 'visible', timeout: 20_000 })
  console.log(`[E2E][debug] ${tag} settings page loaded, URL=${p.url()}`)
  await p.locator('.auth-tab').filter({ hasText: '注册' }).first().click()
  const username = `room_${tag}_${Date.now() % 1000000}`
  await fillInput(p, '用户名（3-32 字符）', username)
  const pw = ['room', 'secret', '123'].join('-')
  await fillInput(p, '密码（至少 6 位）', pw)
  await fillInput(p, '确认密码', pw)
  await clickBtn(p, '注册并登录')
  // 等待 token 真正写入 localStorage（waitText 的「AI 提供商」会误匹配 page-desc，
  // 注册请求可能仍在飞 → 提前返回导致后续请求 401 + clearToken 竞态）
  await p.waitForFunction(() => {
    const v = localStorage.getItem('aikp_token')
    return typeof v === 'string' && v.length > 20
  }, { timeout: 20_000 })
  await p.waitForTimeout(500) // 等 register 响应完全落盘（token + settings）
  console.log(`[E2E][debug] ${tag} registered+authed, URL=${p.url()}`)
  return username
}

/* ═══════════════════ Journey ═══════════════════ */

async function main() {
  const hardTimeout = setTimeout(() => {
    console.error('[E2E] HARD TIMEOUT — force exiting')
    process.exit(1)
  }, 15 * 60_000)
  hardTimeout.unref()

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-rooms-e2e-'))
  fs.mkdirSync(SHOTS_DIR, { recursive: true })

  if (SELF_START_API) {
    console.log(`[E2E] starting backend (MOCK_AI=1 PORT=${apiPort})`)
    spawnServer(tmpRoot)
  } else {
    console.log(`[E2E] using external backend at ${API_BASE}`)
  }
  if (SELF_START_WEB) {
    console.log(`[E2E] starting H5 dev server (VITE_API_BASE=${API_BASE})`)
    spawnWeb()
  } else {
    console.log(`[E2E] using external web app at ${WEB_BASE}`)
  }

  try {
    await pollUrl(`${API_BASE}/api/auth/me`, 60_000, 'backend')
    await pollUrl(`${WEB_BASE}/`, 120_000, 'H5 dev server')
    console.log('[E2E] services up\n')

    const browser = await launchBrowser()
    // Two isolated contexts (separate localStorage) = two players.
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    pageA = await ctxA.newPage()
    pageB = await ctxB.newPage()
    for (const p of [pageA, pageB]) {
      p.on('pageerror', (e) => console.error('[E2E][pageerror]', e instanceof Error ? e.message : String(e)))
      p.on('console', (m) => {
        if (m.type() === 'error') console.error('[E2E][console:error]', m.text())
      })
      p.on('requestfailed', (req) => console.log('[E2E][reqfailed]', req.url()))
    }

    let roomId = ''

    await step('A 注册并建房 → 拿邀请码', async () => {
      await registerUser(pageA, 'a')
      await pageA.goto(`${WEB_BASE}/#/pages/game/rooms/index`, { waitUntil: 'domcontentloaded' })
      await waitText(pageA, '多人房间')
      await clickBtn(pageA, '创建新房间')
      // 建房后 REST 拿 roomId（不依赖 navigateTo——dev 下 uni.navigateTo 到子包页面可能异步慢）
      await waitText(pageA, '房间已创建', 15_000)
      const notice = await pageA.locator('.notice-text').first().textContent()
      assert(notice && notice.includes('邀请码'), `no invite code in notice: ${notice}`)
      // Node 侧 REST（page.evaluate 的 fetch 走 vite proxy，响应解析不稳）
      const token = await pageA.evaluate(() => localStorage.getItem('aikp_token'))
      const listRes = await fetch(`${API_BASE}/api/rooms`, { headers: { Authorization: 'Bearer ' + token } })
      const list = await listRes.json()
      assert(Array.isArray(list) && list.length > 0, `room list empty: ${JSON.stringify(list)}`)
      roomId = list[0].roomId
      // 直接导航到房间页（绕过 navigateTo 不确定性）
      await pageA.goto(`${WEB_BASE}/#/pages/game/rooms/room?roomId=${roomId}`, { waitUntil: 'domcontentloaded' })
      await waitText(pageA, '成员', 20_000)
    })

    await step('B 注册并用邀请码加入', async () => {
      await registerUser(pageB, 'b')
      await pageB.goto(`${WEB_BASE}/#/pages/game/rooms/index`, { waitUntil: 'domcontentloaded' })
      await waitText(pageB, '多人房间')
      // 读取 A 房间页显示的邀请码
      const codeText = await pageA.locator('.room-code').first().textContent()
      const codeMatch = (codeText ?? '').match(/[A-Z0-9]{6}/)
      assert(codeMatch, `no 6-char invite code in: ${codeText}`)
      const code = codeMatch[0]
      await fillInput(pageB, '输入 6 位邀请码', code)
      await clickBtn(pageB, '加入')
      // join 成功后 uni.navigateTo 在 H5 dev 下不可靠 → 从 Node REST 确认加入后直接 goto
      await pageB.waitForTimeout(1500)
      const tokenB = await pageB.evaluate(() => localStorage.getItem('aikp_token'))
      const detailRes = await fetch(`${API_BASE}/api/rooms/${roomId}`, { headers: { Authorization: 'Bearer ' + tokenB } })
      const detail = await detailRes.json()
      assert(detail.members && detail.members.length === 2, `B not in room: ${JSON.stringify(detail.members ?? detail)}`)
      await pageB.goto(`${WEB_BASE}/#/pages/game/rooms/room?roomId=${roomId}`, { waitUntil: 'domcontentloaded' })
      await waitText(pageB, '成员', 20_000)
    })

    await step('A 与 B 成员列表互相可见（2 人）', async () => {
      // room_meta 广播：A 的成员列表应出现 B
      await waitText(pageA, '成员 (2)', 20_000)
      await waitText(pageB, '成员 (2)', 20_000)
    })

    await step('A 发聊天 → B 实时收到', async () => {
      await fillInput(pageA, '说出你的行动…', '我调查一下书架。')
      await clickBtn(pageA, '发送')
      await waitText(pageB, '我调查一下书架。', 20_000)
      // A 自己也应看到（服务端广播回灌）
      await waitText(pageA, '我调查一下书架。', 20_000)
    })

    await step('B 发聊天 → A 实时收到', async () => {
      await fillInput(pageB, '说出你的行动…', '我去看看那扇门。')
      await clickBtn(pageB, '发送')
      await waitText(pageA, '我去看看那扇门。', 20_000)
    })

    await step('A 发侦查 → 双方收到 KP 回合回复（工具链）', async () => {
      await fillInput(pageA, '说出你的行动…', '我侦查一下房间。')
      await clickBtn(pageA, '发送')
      // mock 侦查 → skill_check(侦查) → grant_clue → 收尾叙事
      await waitText(pageA, '（测试模式）', 30_000)
      await waitText(pageB, '（测试模式）', 30_000)
    })

    await step('B 断线重连（reload）→ room:sync 增量补齐，消息仍在', async () => {
      await pageB.reload({ waitUntil: 'domcontentloaded' })
      // reload 后重新进入房间页（uni 恢复登录，导航到房间 URL 需带参数）
      await pageB.goto(`${WEB_BASE}/#/pages/game/rooms/room?roomId=${roomId}`, { waitUntil: 'domcontentloaded' })
      await waitText(pageB, '成员', 20_000)
      // 增量补齐后历史消息仍在
      await waitText(pageB, '我调查一下书架。', 20_000)
      await waitText(pageB, '我侦查一下房间。', 20_000)
    })

    await step('重连后 B 仍可发消息（会话恢复）', async () => {
      await fillInput(pageB, '说出你的行动…', '我回来了。')
      await clickBtn(pageB, '发送')
      await waitText(pageA, '我回来了。', 20_000)
    })

    console.log('[E2E] RESULTS')
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
    }
    const failed = results.filter((r) => !r.pass)
    if (failed.length > 0) {
      console.error(`[E2E] ${results.length - failed.length} passed, ${failed.length} failed`)
      process.exit(1)
    }
    console.log(`[E2E] ${results.length} passed, 0 failed`)
    process.exit(0)
  } catch (err) {
    console.error(`[E2E] FATAL: ${err.message}`)
    if (pageA) await captureFailure(pageA, 'fatal-A').catch(() => {})
    if (pageB) await captureFailure(pageB, 'fatal-B').catch(() => {})
    console.log('[E2E] RESULTS')
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
    }
    process.exit(1)
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error('[E2E] unhandled:', err)
  process.exit(1)
})

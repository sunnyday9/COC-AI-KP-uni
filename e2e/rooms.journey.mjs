#!/usr/bin/env node
/**
 * Multiplayer-room browser E2E (T5 #32 rewrite; ADR-0005) — `node e2e/rooms.journey.mjs`
 *
 * Drives a COMPLETE multiplayer game in real browsers against a MOCK_AI backend,
 * following the ADR-0005 lobby → 开局门闩 → playing → game 协作 flow:
 *
 *   context A (房主)  register → import+index story (REST) → create room →
 *                     lobby「等待室里一片寂静」empty state
 *   context B (成员)  register → join by invite code (REST 锁房前加入) → 成员 (2)
 *   A 在 lobby 发 chat → B 实时收到（lobby 只广播；不开新 KP 回合）
 *   A 选剧本（已索引 story）→ startHint 更新 → 开局仍被门闩拦（B 未绑卡）
 *   B 等待室「去建卡」→ occupation mode=multi&roomId 向导 → 建卡绑房回等待室
 *   B 就绪 → A 开局成功 → room_meta playing → 双方自动跳 game 页
 *   playing 后 chat → mock KP 回合（含「（测试模式）」回复）双方可见
 *   reload 重连 → 快照续玩（消息仍在）
 *   档案切换（#31）：桌面右栏 member chips → 切 B → B 的角色卡可见
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
const FIXTURE = path.join(E2E_DIR, 'fixtures', 'demo-story.txt')

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
      if (pageA) await captureFailure(pageA, name + '-A').catch(() => {})
      if (pageB) await captureFailure(pageB, name + '-B').catch(() => {})
      throw err
    })
}

let pageA, pageB

async function waitText(p, text, timeout = 25_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'visible' })
}

async function waitTextGone(p, text, timeout = 15_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'hidden' })
}

async function clickBtn(p, text, opts = {}) {
  const loc = p.locator('uni-button').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

async function clickText(p, text, opts = {}) {
  const loc = p.getByText(text, { exact: false }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

async function fillInput(p, placeholder, value) {
  // uni-app H5 renders the placeholder as a div inside uni-input/uni-textarea.
  const box = p
    .locator('uni-input, uni-textarea')
    .filter({ has: p.getByText(placeholder, { exact: false }) })
    .first()
  await box.waitFor({ state: 'visible', timeout: 15_000 })
  await box.locator('input, textarea').first().fill(value)
}

/** 等待 text 出现在 msg-wrap（输入框 placeholder 也是「调查员」——必须收窄到消息区）。 */
async function waitMsg(p, text, timeout = 30_000) {
  const loc = p.locator('.msg-wrap').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout })
}

/** 等一条「等待室一片寂静」级 lobby 空态文本（v-if 内）。 */
async function waitLobbyEmpty(p, timeout = 25_000) {
  await waitText(p, '等待室里一片寂静', timeout)
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

function tail(arr, n = 25) {
  return arr.slice(-n).join('')
}

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
  const uniCli = path.join(ROOT, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')
  const child = spawn(process.execPath, [uniCli], {
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
  throw new Error(`Timed out waiting for ${label}\n--- server log ---\n${tail(logs.server)}\n--- web log ---\n${tail(logs.web)}`)
}

async function cleanup() {
  const exits = []
  for (const c of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        try { spawn('pkill', ['-TERM', '-P', String(c.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
        c.kill('SIGTERM')
      }
      exits.push(new Promise((resolve) => {
        const t = setTimeout(resolve, 3000)
        c.once('exit', () => { clearTimeout(t); resolve() })
      }))
    } catch { /* ignore */ }
  }
  await Promise.all(exits)
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

/* ═══════════════════ REST / auth helpers ═══════════════════ */

async function api(method, p, body, token) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text().catch(() => '')
  let data
  try { data = JSON.parse(text) } catch { data = {} }
  return { status: res.status, data }
}

/** Register a fresh user through the settings page (auto-login). */
async function registerUser(p, tag) {
  await p.goto(`${WEB_BASE}/#/pages/settings/index`, { waitUntil: 'domcontentloaded' })
  await p.locator('.auth-tab').first().waitFor({ state: 'visible', timeout: 20_000 })
  await p.locator('.auth-tab').filter({ hasText: '注册' }).first().click()
  const username = `room_${tag}_${Date.now() % 1000000}`
  await fillInput(p, '用户名（3-32 字符）', username)
  const pw = ['room', 'secret', '123'].join('-')
  await fillInput(p, '密码（至少 6 位）', pw)
  await fillInput(p, '确认密码', pw)
  await clickBtn(p, '注册并登录')
  await p.waitForFunction(() => {
    const v = localStorage.getItem('aikp_token')
    return typeof v === 'string' && v.length > 20
  }, { timeout: 20_000 })
  await p.waitForTimeout(500)
  return username
}

/** 读取页面 localStorage 的 token（Node 侧 REST 用——page.evaluate 的 fetch 走 vite proxy，不稳）。 */
async function tokenOf(p) {
  return p.evaluate(() => localStorage.getItem('aikp_token') ?? '')
}

/** 直接登录另一用户（H5 uni storage 落 localStorage；免 UI 注册，比 registerUser 更稳）。 */
async function loginToken(p, username, password) {
  const res = await api('POST', '/api/auth/login', { username, password })
  assert(res.status === 200 && res.data.token, `login ${username} failed: ${res.status} ${JSON.stringify(res.data)}`)
  await p.evaluate((t) => localStorage.setItem('aikp_token', t), res.data.token)
}

/** 上传并 RAG 索引 demo 故事（房主 token）。返回 { storyId, name }。 */
async function indexDemoStory(token) {
  const uploadRes = await fetch(`${API_BASE}/api/stories/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: (() => {
      const fd = new FormData()
      fd.append('file', new Blob([fs.readFileSync(FIXTURE)], { type: 'text/plain' }), 'demo-story.txt')
      return fd
    })(),
  })
  const up = await uploadRes.json().catch(() => ({}))
  assert(uploadRes.status === 200 && up.ok !== false, `script upload failed: ${uploadRes.status} ${JSON.stringify(up)}`)
  const id = up.id ?? up.scriptId ?? 'demo-story.txt'
  const ragRes = await api('GET', `/api/stories/${encodeURIComponent(id)}/rag`, undefined, token)
  assert(ragRes.status === 200, `rag read failed: ${ragRes.status} ${JSON.stringify(ragRes.data)}`)
  // 索引键 = 含扩展名的文件名 id；整篇作单 chunk（mock 检索只按需取回，够用）。
  const content = typeof ragRes.data.content === 'string' ? ragRes.data.content : JSON.stringify(ragRes.data)
  const idx = await api('POST', '/api/rag/index', {
    scriptId: id,
    chunks: [{ id: 'chunk-0', content }],
    storyMeta: { name: 'demo-story' },
  }, token)
  assert(idx.status === 200 && idx.data.ok, `rag index failed: ${idx.status} ${JSON.stringify(idx.data)}`)
  const stories = await api('GET', '/api/rag/stories', undefined, token)
  assert(stories.status === 200, `rag stories failed: ${stories.status}`)
  const hit = (stories.data ?? []).find((s) => s.storyId === id)
  assert(hit, `indexed story ${id} not in rag list: ${JSON.stringify(stories.data)}`)
  return { storyId: hit.storyId, name: hit.name }
}

/** 等待室就绪判定（每轮 getRoomDetail 需 500ms+ 轮询 → 短轮询）。 */
async function waitMemberReady(roomId, token, username, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const d = await api('GET', `/api/rooms/${roomId}`, undefined, token)
    const m = (d.data.members ?? []).find((x) => x.username === username)
    if (d.status === 200 && m?.ready) return
    if (Date.now() > deadline) throw new Error(`timeout waiting member ready: ${JSON.stringify(d.data?.members ?? d.data)}`)
    await new Promise((r) => setTimeout(r, 600))
  }
}

/**
 * Fill a uni-app H5 <picker> (selector mode): click the trigger view, then
 * click the option matching the label pattern inside the OPEN popup.
 *
 * uni-h5 renders every picker's popup in the DOM (hidden); only the open one
 * has display ≠ none. Items exist in two lists — `uni-picker-content`
 * (scrollable, no click handler) and `.uni-picker-select` (real items whose
 * click commits the value) — so the click is scoped to the select list and
 * dispatched as a DOM click (the popup mask would otherwise intercept a
 * Playwright hit-test).
 */
async function pickUniOption(p, pickerViewSelector, labelPattern, index = 0) {
  await p.locator(pickerViewSelector).nth(index).click()
  await p.waitForTimeout(400)
  const result = await p.evaluate((label) => {
    const container = [...document.querySelectorAll('.uni-picker-container')].find(
      (el) => getComputedStyle(el).display !== 'none',
    )
    if (!container) return 'no-open-container'
    const item = [...container.querySelectorAll('.uni-picker-select .uni-picker-item')].find((el) =>
      el.textContent.includes(label),
    )
    if (!item) return 'no-item'
    item.click()
    return 'clicked'
  }, labelPattern)
  if (result !== 'clicked') {
    throw new Error(`pickUniOption failed (${result}) for label "${labelPattern}"`)
  }
  await p.waitForTimeout(300)
}

/** 最小合法 COCCharacterSheet（服务端只校验 derived 存在）。 */
function makeSheet(name) {
  const base = { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }
  return {
    occupationId: 'judge',
    occupationName: '法官',
    playerName: name,
    attributes: base,
    skills: { 侦查: 65, 聆听: 60, 图书馆使用: 55, 格斗: 40, 信用评级: 40 },
    occupationSkillKeys: ['侦查', '聆听', '图书馆使用', '格斗', '信用评级', '心理学', '法律', '母语', '恐吓'],
    personalInterestKeys: ['侦查', '聆听', '图书馆使用', '潜行'],
    derived: {
      hp: 10, hpMax: 10, mp: 10, mpMax: 10, san: 50, sanMax: 50,
    },
    damageBonus: '0', build: 0, mov: 8, armor: 0,
  }
}

/** occupation 向导多人建卡（mode=multi&roomId）。建卡完成回跳等待室。
 *  expectedMembers：向导完成后等待室应显示的成员数（A 建房先绑卡=1；B 加入后=2）。 */
async function createCharacterInWizard(p, tag, roomId, expectedMembers = 1) {
  await p.goto(`${WEB_BASE}/#/pages/character/occupation/index?mode=multi&roomId=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' })
  await waitText(p, '选择职业', 20_000)
  // 多人入场预检通过后自动弹出「复用既有角色卡」→ 无卡 → 关闭走新建
  const reuseMask = p.locator('.picker-mask').filter({ hasText: '选择要绑定的角色卡' }).first()
  try {
    await reuseMask.waitFor({ state: 'visible', timeout: 8_000 })
    const closeBtn = p.locator('uni-button').filter({ hasText: '关闭，新建角色' }).first()
    await closeBtn.waitFor({ state: 'visible', timeout: 5_000 })
    await closeBtn.click()
  } catch { /* 预检未弹/已关 → 照常继续 */ }
  await clickText(p, '法官')
  await waitText(p, '创建角色')
  await waitText(p, '职业技能')
  await clickBtn(p, '投掷属性')
  await waitText(p, '重新投掷')
  // 4 个兴趣技能 picker（.picker-view.flex-1）——step2 预选后 step3 才可确认
  await pickUniOption(p, '.picker-view.flex-1', '侦查', 0)
  await pickUniOption(p, '.picker-view.flex-1', '聆听', 1)
  await pickUniOption(p, '.picker-view.flex-1', '图书馆使用', 2)
  await pickUniOption(p, '.picker-view.flex-1', '潜行', 3)
  // step2 → step3（按钮文案随 canGoInterest 变：属性已投 + 职业技能配满）
  await clickBtn(p, '下一步：确认调查员', { timeout: 20_000 })
  await waitText(p, '确认调查员')
  await waitText(p, '档案预览')
  const name = `调查员${tag}_${Date.now() % 1000}`
  await fillInput(p, '调查员', name)
  await clickBtn(p, '确认角色并进入游戏')
  await waitText(p, `成员 (${expectedMembers})`, 30_000) // finishMultiMode redirectTo 等待室
  return name
}

/* ═══════════════════ Journey ═══════════════════ */

async function main() {
  const hardTimeout = setTimeout(() => {
    console.error('[E2E] HARD TIMEOUT — force exiting')
    process.exit(1)
  }, 15 * 60_000)
  hardTimeout.unref()

  // Preflight: fail fast if the default ports are taken (same as h5.journey).
  if (SELF_START_API || SELF_START_WEB) {
    for (const [url, label] of [
      [SELF_START_API ? `${API_BASE}/` : null, 'API port'],
      [SELF_START_WEB ? `${WEB_BASE}/` : null, 'web port'],
    ]) {
      if (!url) continue
      try {
        await fetch(url, { signal: AbortSignal.timeout(1500) })
        throw new Error(`${label} ${url} already has a server — stop it first or set E2E_API_BASE / E2E_WEB_BASE`)
      } catch (err) {
        if (err.message.includes('already has a server')) throw err
      }
    }
  }

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
    let tokenA = ''
    let userB = ''
    let sheetBName = ''

    await step('A 注册（settings UI）', async () => {
      await registerUser(pageA, 'a')
      tokenA = await tokenOf(pageA)
    })

    await step('A 导入并索引剧本（demo-story）', async () => {
      const story = await indexDemoStory(tokenA)
      assert(story.storyId, 'story index missing storyId')
    })

    await step('A 建房 → 进入等待室', async () => {
      await pageA.goto(`${WEB_BASE}/#/pages/game/rooms/index`, { waitUntil: 'domcontentloaded' })
      await waitText(pageA, '多人房间')
      await clickBtn(pageA, '创建新房间')
      await waitLobbyEmpty(pageA, 20_000)
      const listRes = await fetch(`${API_BASE}/api/rooms`, { headers: { Authorization: 'Bearer ' + tokenA } })
      const list = await listRes.json()
      assert(Array.isArray(list) && list.length > 0, `room list empty: ${JSON.stringify(list)}`)
      roomId = list[0].roomId
    })

    await step('A 等待室「去建卡」→ occupation multi 向导建卡 → 回等待室已绑卡', async () => {
      await clickBtn(pageA, '去建卡')
      await createCharacterInWizard(pageA, 'a', roomId, 1)
      await waitText(pageA, '已绑定角色卡', 30_000)
    })

    await step('B 注册并用邀请码加入（成员 2）', async () => {
      await registerUser(pageB, 'b')
      // 从 A 房间页读取邀请码
      const codeText = await pageA.locator('.room-code').first().textContent()
      const codeMatch = (codeText ?? '').match(/[A-Z0-9]{6}/)
      assert(codeMatch, `no 6-char invite code in: ${codeText}`)
      const code = codeMatch[0]
      const tokenB = await tokenOf(pageB)
      const joinRes = await api('POST', '/api/rooms/join', { inviteCode: code }, tokenB)
      assert(joinRes.status === 200 && joinRes.data.roomId === roomId, `join failed: ${JSON.stringify(joinRes.data)}`)
      // join 广播 room_meta 后直接 goto 房间页（index 的 navigateTo 在 H5 下不可靠）
      await pageB.goto(`${WEB_BASE}/#/pages/game/rooms/room?roomId=${roomId}`, { waitUntil: 'domcontentloaded' })
      await waitText(pageB, '成员 (2)', 20_000)
      const detailB = await api('GET', `/api/rooms/${roomId}`, undefined, tokenB)
      const me = (detailB.data.members ?? []).find((m) => m.username?.startsWith('room_b_'))
      assert(me?.username, `B member missing: ${JSON.stringify(detailB.data?.members)}`)
      userB = me.username
      // room_meta 广播：A 的成员列表也应出现 B
      await waitText(pageA, '成员 (2)', 20_000)
    })

    await step('lobby 聊天：A→B 实时广播（不开新 KP 回合）', async () => {
      await fillInput(pageA, '说点什么', '欢迎来到调查现场！')
      await clickBtn(pageA, '发送')
      await waitMsg(pageB, '欢迎来到调查现场！', 20_000)
      // lobby 禁 KP：等 6s（回合窗口）断言没有 kp 消息出现
      const before = await pageB.locator('.msg-wrap').count()
      await pageB.waitForTimeout(6_000)
      const after = await pageB.locator('.msg-wrap').count()
      assert(after === before, `lobby chat must not trigger a KP turn (msgs ${before} → ${after})`)
    })

    await step('A 选剧本 → 开局被门闩拦（B 未绑卡）', async () => {
      // 房主侧：等待室剧本区「选择剧本」→ 弹层列出已索引故事
      await clickBtn(pageA, '选择剧本', { timeout: 20_000 })
      await clickText(pageA, 'demo-story', { timeout: 20_000 })
      await clickBtn(pageA, '确定')
      // 已选 → 剧本区显示故事名；开局条显示门闩提示 + 开始按钮禁用（B 未绑卡）
      await waitText(pageA, 'demo-story', 20_000)
      const hint = pageA.locator('.start-hint').first()
      await hint.waitFor({ state: 'visible', timeout: 15_000 })
      const hintText = (await hint.textContent()) ?? ''
      assert(hintText.includes('未绑定角色卡'), `start hint mismatch: "${hintText}"`)
    })

    await step('开局 REST 门闩：服务端 409（带用户名括号文案）', async () => {
      const startRes = await api('POST', `/api/rooms/${roomId}/start`, { storyId: 'demo-story.txt' }, tokenA)
      assert(startRes.status === 409, `start should 409 while unbound, got ${startRes.status}: ${JSON.stringify(startRes.data)}`)
      assert(startRes.data.error?.includes('未绑定角色卡'), `409 copy mismatch: ${startRes.data.error}`)
      // uni-button 是自定义元素：disabled 反映为 attribute（isDisabled() 认不出 host）
      const startBtn = pageA.locator('uni-button.start-game-btn').first()
      await startBtn.waitFor({ state: 'visible', timeout: 10_000 })
      const disabledAttr = await startBtn.getAttribute('disabled')
      assert(disabledAttr !== null, '开始游戏 should be disabled while a member is unbound')
    })

    await step('B 等待室「去建卡」→ occupation multi 向导建卡 → 回等待室已绑卡', async () => {
      await clickBtn(pageB, '去建卡')
      sheetBName = await createCharacterInWizard(pageB, 'b', roomId, 2)
      // 回等待室：我的准备显示已绑 + 可就绪
      await waitText(pageB, '已绑定角色卡', 30_000)
      await waitText(pageB, '就绪', 20_000)
      // REST 确认 B 服务端已绑（members.characterId 非空）
      const detail = await api('GET', `/api/rooms/${roomId}`, undefined, tokenA)
      const bMember = (detail.data.members ?? []).find((m) => m.username === userB)
      assert(bMember?.characterId, `B should be bound server-side after wizard: ${JSON.stringify(detail.data?.members)}`)
      // room_meta 广播：A 侧成员行 B 应变为已绑卡（绑定后门闩提示消失）
      await pageA.locator('.member-row').filter({ hasText: userB }).locator('.member-bind.bind-ok').first().waitFor({ timeout: 20_000 })
    })

    await step('B 就绪 → A 开局成功（双方自动跳 game 页）', async () => {
      await clickBtn(pageB, '就绪')
      await waitMemberReady(roomId, tokenA, userB, 25_000)
      // A 侧门闩解除（B 已绑卡）→ 开局可点
      await pageA.locator('.start-hint').first().waitFor({ state: 'hidden', timeout: 20_000 })
      const startBtn = pageA.locator('uni-button.start-game-btn').first()
      await startBtn.waitFor({ state: 'visible', timeout: 10_000 })
      const disabledAttr = await startBtn.getAttribute('disabled')
      assert(disabledAttr === null, '开始游戏 should be enabled once all bound')
    })

    await step('A 点开局 → 双方 room_meta playing → game 页就绪', async () => {
      await pageA.locator('uni-button.start-game-btn').first().click()
      await waitText(pageA, '描述你的行动...', 30_000)
      await waitText(pageB, '描述你的行动...', 30_000)
    })

    await step('playing 后聊天 → mock KP 回合（双方可见）', async () => {
      await fillInput(pageA, '描述你的行动', '我仔细侦查房间，搜索书架。')
      await clickBtn(pageA, '发送')
      await waitMsg(pageA, '我仔细侦查房间，搜索书架。', 20_000)
      // mock 侦查 → skill_check + grant_clue 链 → 收尾叙事
      await waitText(pageA, '侦查检定', 40_000)
      await waitText(pageB, '侦查检定', 40_000)
      await waitText(pageA, '（测试模式）', 40_000)
      await waitText(pageB, '（测试模式）', 40_000)
    })

    await step('A reload 重连 → 快照续玩，消息仍在', async () => {
      await pageA.reload({ waitUntil: 'domcontentloaded' })
      await pageA.goto(`${WEB_BASE}/#/pages/game/index?roomId=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' })
      await waitText(pageA, '描述你的行动...', 30_000)
      await waitMsg(pageA, '我仔细侦查房间，搜索书架。', 20_000)
      await waitText(pageA, '（测试模式）', 20_000)
    })

    await step('档案切换：默认自己 + 切 B 显示 B 卡（#31）', async () => {
      // 双人局 → MemberSwitcher 渲染（2 chips + 默认自己）
      const chips = pageA.locator('.member-chip')
      await chips.first().waitFor({ state: 'visible', timeout: 15_000 })
      assert((await chips.count()) >= 2, `expected >=2 member chips, got ${await chips.count()}`)
      // 默认选中自己：档案区显示 A 卡（.cs-name = 默认「调查员」）
      const defaultCard = pageA.locator('.right-rail .dossier-block .cs-name').first()
      await defaultCard.waitFor({ state: 'visible', timeout: 15_000 })
      const defaultName = (await defaultCard.textContent()) ?? ''
      assert(defaultName.length > 0, `default sheet name empty`)
      // 切到 B 成员 chip → 显示 B 卡（playerName = sheetBName）
      const chipB = pageA.locator('.member-chip').filter({ hasText: userB }).first()
      await chipB.waitFor({ state: 'visible', timeout: 10_000 })
      await chipB.click()
      const bCard = pageA.locator('.right-rail .dossier-block .cs-name').first()
      await bCard.waitFor({ state: 'visible', timeout: 15_000 })
      const bName = (await bCard.textContent()) ?? ''
      assert(bName.length > 0, 'B sheet name empty after switching')
      // 切回 A（默认自己 chip）
      const chipA = pageA.locator('.member-chip').filter({ hasText: '(我)' }).first()
      await chipA.waitFor({ state: 'visible', timeout: 10_000 })
      await chipA.click()
      const backCard = pageA.locator('.right-rail .dossier-block .cs-name').first()
      await backCard.waitFor({ state: 'visible', timeout: 15_000 })
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
    console.log('--- server log tail ---\n' + tail(logs.server))
    console.log('--- web log tail ---\n' + tail(logs.web))
  } catch (err) {
    console.error(`[E2E] FATAL: ${err.message}`)
    if (pageA) await captureFailure(pageA, 'fatal-A').catch(() => {})
    if (pageB) await captureFailure(pageB, 'fatal-B').catch(() => {})
    console.log('[E2E] RESULTS')
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? `  → ${r.error}` : ''}`)
    }
    process.exitCode = 1
  } finally {
    await cleanup()
    process.exit(process.exitCode ?? 0)
  }
}

main().catch((err) => {
  console.error('[E2E] unhandled:', err)
  process.exit(1)
})

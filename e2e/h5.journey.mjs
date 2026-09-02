#!/usr/bin/env node
/**
 * H5 end-to-end journey (Task 11; ADR-0002 solo-room protocol) — `node e2e/h5.journey.mjs`
 *
 * Drives the full COC solo flow in a real browser against a MOCK_AI backend.
 * 单人 = 单成员房间（ADR-0002）：确认角色卡即 roomCreateSolo 进房，全程房间帧。
 *
 *   register → settings (model auto-filled from mock list + save) → story
 *   import (TXT fixture) → index → home story list → occupation (法官) →
 *   character create (roll + interest skills + name) → roomCreateSolo →
 *   game page joins solo room → server opening (room event) →
 *   message with 侦查 → skill_check + grant_clue tool loop (clue gained) →
 *   message with 战斗 → skill_check → roll_dice → adjust_hp loop (HP 10→8) →
 *   reload → resume from server snapshot (messages + HP restored) →
 *   home 继续游戏 lists the unfinished solo room → screenshots.
 *
 * Usage (from the repo root):
 *   node e2e/h5.journey.mjs
 *   node e2e/h5.journey.mjs --keep       # keep temp data dir + services logs
 *
 * Environment overrides:
 *   E2E_API_BASE  http://localhost:3100  backend base (default; when set the
 *                                        script does NOT spawn the backend)
 *   E2E_WEB_BASE  http://localhost:5175  H5 dev server base (default; when set
 *                                        the script does NOT spawn the web app)
 *   E2E_BROWSER   msedge|chrome|executable-path  (default: auto-detect
 *                                        msedge → chrome → known paths)
 *
 * Dependencies: playwright-core (devDep — NO browser download). The browser is
 * the system Edge or Chrome. If neither is found the script exits with a
 * clear error.
 *
 * Services are spawned and torn down by the script:
 *   backend: node --import tsx server/src/app.ts  (MOCK_AI=1 PORT=3100 …)
 *   web:     npm run dev:h5  (VITE_API_BASE=$E2E_API_BASE, vite port 5175)
 *
 * Output: PASS/FAIL per step with timings; on failure a screenshot + HTML
 * dump are written to e2e/screenshots/.
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

// vite.config.js binds host: '127.0.0.1' (IPv4 loopback, see test-agent REPORT.md
// for the IPv6 EACCES history) — so the web base MUST be 127.0.0.1, not
// localhost (which may resolve to ::1 and fail to connect).
const API_BASE = (process.env.E2E_API_BASE || 'http://localhost:3100').replace(/\/+$/, '')
const WEB_BASE = (process.env.E2E_WEB_BASE || 'http://127.0.0.1:5175').replace(/\/+$/, '')
const SELF_START_API = !process.env.E2E_API_BASE
const SELF_START_WEB = !process.env.E2E_WEB_BASE
const KEEP = process.argv.includes('--keep')

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
      const ms = Date.now() - start
      results.push({ name, pass: true, ms })
      console.log(`  [PASS] ${name} (${ms}ms)`)
    })
    .catch(async (err) => {
      const ms = Date.now() - start
      results.push({ name, pass: false, ms, error: err.message })
      console.error(`  [FAIL] ${name} (${ms}ms): ${err.message}`)
      await captureFailure(page, name)
      throw err
    })
}

let failureSeq = 0
async function captureFailure(p, name) {
  // Guard: a broken page (dev server down mid-run) can make screenshot/content
  // hang forever — race them against a timeout so the journey always exits.
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), ms))])
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    const tag = `${String(++failureSeq).padStart(2, '0')}-${name.replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 60)}`
    await withTimeout(p.screenshot({ path: path.join(SHOTS_DIR, `fail-${tag}.png`), fullPage: true }), 10_000)
    const html = await withTimeout(p.content(), 10_000)
    fs.writeFileSync(path.join(SHOTS_DIR, `fail-${tag}.html`), html, 'utf-8')
  } catch (e) {
    console.error('  (captureFailure also failed:', e.message, ')')
  }
}

async function waitText(p, text, timeout = 25_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'visible' })
}

async function clickText(p, text, opts = {}) {
  const loc = p.getByText(text, { exact: false }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

/** Click a uni-button containing the given text (uni-app compiles <button> → <uni-button>). */
async function clickBtn(p, text, opts = {}) {
  const loc = p.locator('uni-button').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

async function fillInput(p, placeholder, value) {
  // uni-app H5 renders placeholder as a div inside uni-input/uni-textarea;
  // the native input/textarea carries no placeholder attribute.
  const box = p
    .locator('uni-input, uni-textarea')
    .filter({ has: p.getByText(placeholder, { exact: false }) })
    .first()
  await box.waitFor({ state: 'visible', timeout: 15_000 })
  await box.locator('input, textarea').first().fill(value)
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

/* ═══════════════════ Browser launch ═══════════════════ */

async function launchBrowser() {
  const explicit = process.env.E2E_BROWSER
  if (explicit) {
    if (explicit === 'msedge' || explicit === 'chrome') {
      return chromium.launch({ channel: explicit })
    }
    return chromium.launch({ executablePath: explicit })
  }
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel })
    } catch {
      /* try next */
    }
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return await chromium.launch({ executablePath: p })
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(
    'No browser found. playwright-core does not download browsers — install ' +
      'Microsoft Edge or Google Chrome, or set E2E_BROWSER=msedge|chrome|<executable path>.',
  )
}

/* ═══════════════════ Service spawning ═══════════════════ */

const children = []
const logs = { server: [], web: [] }

function tail(arr, n = 25) {
  return arr.slice(-n).join('')
}

function spawnServer(tmpRoot) {
  const serverDir = path.join(ROOT, 'server')
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: serverDir,
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
  child.on('exit', (code) => logs.server.push(`\n[server exited code=${code}]\n`))
  children.push(child)
  return child
}

function spawnWeb() {
  const clientDir = path.join(ROOT, 'client')
  // Spawn the uni CLI directly with node (no npm shell chain — clean kill on
  // Windows). vite-plugin-uni's uni.js runs the vite dev server in-process.
  const uniCli = path.join(ROOT, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')
  const child = spawn(process.execPath, [uniCli], {
    cwd: clientDir,
    env: { ...process.env, VITE_API_BASE: API_BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.web.push(d.toString()))
  child.stderr.on('data', (d) => logs.web.push(d.toString()))
  child.on('exit', (code) => logs.web.push(`\n[web exited code=${code}]\n`))
  children.push(child)
  return child
}

async function pollUrl(url, timeoutMs = 120_000, label = url) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) })
      if (res.status < 600) return true // any HTTP response means the server is up
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
        // npm runs through a shell → kill the whole process tree.
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        // 递归杀子进程树 + 等退出（残留占用端口导致后续 E2E 失败）
        try { spawn('pkill', ['-TERM', '-P', String(c.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
        c.kill('SIGTERM')
      }
      exits.push(new Promise((resolve) => {
        const t = setTimeout(resolve, 3000)
        c.once('exit', () => { clearTimeout(t); resolve() })
      }))
    } catch {
      /* ignore */
    }
  }
  await Promise.all(exits)
}

/* ═══════════════════ Journey ═══════════════════ */

let page

async function main() {
  // Hard guard: never leave a zombie journey behind.
  const hardTimeout = setTimeout(() => {
    console.error('[E2E] HARD TIMEOUT — force exiting')
    process.exit(1)
  }, 20 * 60_000)
  hardTimeout.unref()

  // Preflight: fail fast with a clear message if the default ports are taken.
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
        /* connection refused → free, good */
      }
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-e2e-'))
  fs.mkdirSync(SHOTS_DIR, { recursive: true })

  if (SELF_START_API) {
    console.log(`[E2E] starting backend  (MOCK_AI=1 PORT=${apiPort})`)
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    page = await context.newPage()
    page.on('pageerror', (e) =>
      console.error('[E2E][pageerror]', e instanceof Error ? e.message : JSON.stringify(e) || String(e)),
    )
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('[E2E][console:error]', m.text())
    })
    page.on('requestfailed', (req) => {
      console.error('[E2E][reqfailed]', req.url(), '→', req.failure()?.errorText ?? '')
    })
    page.on('response', (res) => {
      if (res.url().includes('/api/')) console.error('[E2E][api]', res.status(), res.url())
    })

    /* ── 1. Home loads ── */
    await step('home loads', async () => {
      await page.goto(`${WEB_BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' })
      await waitText(page, 'AI COC Keeper')
      // T1 令牌地基：CSS 变量层须生效 —— page/body 背景应解析为 --c-bg（$c-void
      // = hsl(220,20%,4%) = rgb(8,10,12)），而不是回退到 UA 默认白底。
      await page.waitForFunction(() => {
        const bg = getComputedStyle(document.body).backgroundColor
        const rgb = bg.match(/\d+/g)?.slice(0, 3).map(Number) ?? []
        const voidRgb = [8, 10, 12]
        return rgb.length === 3 && rgb.every((v, i) => Math.abs(v - voidRgb[i]) <= 2)
      }, { timeout: 10_000 })
    })

    /* ── 2. Settings: register (new user) ── */
    await step('settings page + register', async () => {
      await page.goto(`${WEB_BASE}/#/pages/settings/index`, { waitUntil: 'domcontentloaded' })
      await waitText(page, '设置')
      await pLoc('.auth-tab').filter({ hasText: '注册' }).first().click()
      await fillInput(page, '用户名（3-32 字符）', `e2e_user_${Date.now() % 100000}`)
      // Regression: uni-h5 gives uni-input hosts a fixed height:1.4em default;
      // .gothic-input's border-box padding+border once squeezed the native
      // input to 1.6px tall → typed text clipped to an invisible sliver.
      // The native input must be tall enough to paint its own glyphs.
      await page.waitForFunction(
        () => {
          const host = [...document.querySelectorAll('uni-input')].find((el) =>
            (el.textContent || '').includes('用户名'),
          )
          const native = host && host.querySelector('input')
          if (!native || !native.value) return false
          return native.getBoundingClientRect().height >= parseFloat(getComputedStyle(native).fontSize)
        },
        { timeout: 10_000 },
      )
      await fillInput(page, '密码（至少 6 位）', 'secret123')
      await fillInput(page, '确认密码', 'secret123')
      await clickBtn(page, '注册并登录')
      // registration auto-logs-in → the settings form (AI 提供商 section) renders
      await waitText(page, 'AI 提供商', 20_000)
    })

    /* ── 3. Settings: protocol card select → model auto-filled + save ── */
    await step('settings AI form (protocol card + mock model + save)', async () => {
      // ADR-0003 protocol-first UI: four protocol cards; pick Anthropic
      // Messages and assert the active card switches (mock mode keeps the
      // model list deterministic).
      await pLoc('.provider-card').filter({ hasText: 'Anthropic Messages' }).first().click()
      await pLoc('.provider-card.provider-active').filter({ hasText: 'Anthropic Messages' }).first().waitFor({ timeout: 10_000 })
      // 切回 OpenAI Chat（默认 mock-model 列表来自 openai_chat 分支）
      await pLoc('.provider-card').filter({ hasText: 'OpenAI Chat' }).first().click()
      await pLoc('.provider-card.provider-active').filter({ hasText: 'OpenAI Chat' }).first().waitFor({ timeout: 10_000 })
      // The picker popup keeps all options in the DOM (hidden) — assert the
      // visible trigger value (.picker-value) instead of the option text.
      await pLoc('.picker-value').filter({ hasText: 'mock-model' }).first().waitFor({ timeout: 15_000 })
      await clickBtn(page, '保存设置')
      await waitText(page, '设置已保存')
      await clickBtn(page, '测试连接')
      await waitText(page, '连接正常', 15_000)
    })

    /* ── 4. Stories: import TXT fixture ── */
    await step('import story TXT fixture', async () => {
      await page.goto(`${WEB_BASE}/#/pages/scripts/index`, { waitUntil: 'domcontentloaded' })
      await waitText(page, '故事管理')
      const fcPromise = page.waitForEvent('filechooser', { timeout: 15_000 })
      await clickBtn(page, '导入故事')
      const fc = await fcPromise
      await fc.setFiles(FIXTURE)
      await waitText(page, '故事文件导入成功', 20_000)
      await waitText(page, 'demo-story')
      await waitText(page, '未索引')
    })

    /* ── 5. Index the story (TF-IDF path in mock mode; no model download) ── */
    await step('index story (RAG)', async () => {
      const indexBtn = pLoc('.file-card')
        .filter({ hasText: 'demo-story' })
        .locator('uni-button')
        .filter({ hasText: '索引' })
        .first()
      await indexBtn.waitFor({ state: 'visible', timeout: 15_000 })
      await indexBtn.click()
      await waitText(page, '索引成功', 60_000)
      await waitText(page, '已索引')
      await waitText(page, '个信息块')
    })

    /* ── 6. Home shows the indexed story ── */
    await step('home lists indexed story', async () => {
      await page.goto(`${WEB_BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' })
      // uni-app H5 reuses the already-mounted first-page instance from its
      // page stack (onMounted does NOT re-run → no re-fetch). A full reload
      // recreates the app: onLaunch restores the session, home onMounted
      // re-fetches the indexed story list.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitText(page, 'demo-story', 20_000)
    })

    /* ── 7. Start game → occupation (法官, all-fixed skill slots) ── */
    await step('occupation selection (法官)', async () => {
      await clickText(page, 'demo-story')
      await waitText(page, '选择职业')
      await fillInput(page, '搜索职业名称（中文 / 英文）…', '法官')
      await waitText(page, '法官')
      await pLoc('.occ-card').filter({ hasText: '法官' }).first().click()
      await waitText(page, '创建角色')
      await waitText(page, '职业技能')
    })

    /* ── 8. Character create (单页 step2 技能属性 → step3 兴趣姓名预览) → roomCreateSolo ── */
    await step('character create → roomCreateSolo → 进入 solo 房间', async () => {
      await clickBtn(page, '投掷属性')
      await waitText(page, '重新投掷')
      // 4 interest skill pickers (.picker-view.flex-1) — pick deterministic skills
      await pickUniOption(page, '.picker-view.flex-1', '侦查', 0)
      await pickUniOption(page, '.picker-view.flex-1', '聆听', 1)
      await pickUniOption(page, '.picker-view.flex-1', '图书馆使用', 2)
      await pickUniOption(page, '.picker-view.flex-1', '潜行', 3)
      // T6 单页向导：step2 配满后进入 step3（姓名 + 档案预览）
      await clickBtn(page, '下一步：确认调查员')
      await waitText(page, '确认调查员')
      await waitText(page, '档案预览')
      await fillInput(page, '调查员', 'E2E 调查员')
      await clickBtn(page, '确认角色并进入游戏')
      // ADR-0002：确认 = 服务端一体动作（落角色卡 + 建 solo 房 + 绑卡 + start）→ 直接进游戏页
      await waitText(page, '描述你的行动...', 30_000)
      // 房间已连接（输入框从「正在连接房间...」切换为可用）
      await page.waitForFunction(
        () => {
          const el = document.querySelector('uni-textarea textarea')
          return el && !el.disabled
        },
        { timeout: 60_000 },
      )
    })

    /* ── 9. Server opening (room event, mock KP) ── */
    await step('opening 叙述经房间事件流到达（服务端触发）', async () => {
      await waitText(page, '（测试模式）守秘人回应：你听到了远处的脚步声。', 30_000)
    })

    /* ── 10. Investigate message → skill_check + grant_clue tool loop ── */
    await step('侦查 message → skill_check + grant_clue loop', async () => {
      await fillInput(page, '描述你的行动...', '我仔细侦查房间，搜索书架。')
      await clickBtn(page, '发送')
      await waitText(page, '我仔细侦查房间，搜索书架。')
      await waitText(page, '侦查检定', 30_000)
      // T4 clue 渲染剥离「获得线索:」前缀（视觉更干净，设计稿对齐）——断言语义内容
      await waitText(page, '书架后的暗格里藏着一把铜钥匙', 30_000)
      await waitText(page, '（测试模式）线索已记录。', 30_000)
      // T5 桌面三栏：线索簿左栏常显（state_patch → roomStore.clues → 左栏 clue-card + badge）
      await pLoc('.left-rail .clue-badge').first().waitFor({ timeout: 10_000 })
      await pLoc('.left-rail .clue-card').filter({ hasText: '书架后的暗格里藏着一把铜钥匙' }).first().waitFor({ timeout: 10_000 })
    })

    /* ── 11. Combat message → skill_check → roll_dice → adjust_hp (HP -2) ── */
    await step('战斗 message → skill_check → roll_dice → adjust_hp (HP -2)', async () => {
      const hpBefore = Number((await pLoc('.stat-current').nth(1).textContent()).trim())
      assert(Number.isFinite(hpBefore) && hpBefore > 0, `invalid HP before combat: ${hpBefore}`)
      await fillInput(page, '描述你的行动...', '我发动攻击！')
      await clickBtn(page, '发送')
      await waitText(page, '我发动攻击！')
      await waitText(page, '投骰 d6', 30_000)
      await waitText(page, 'HP -2', 30_000)
      await waitText(page, '（测试模式）你受到了伤害，HP 下降。', 30_000)
      const hpAfter = Number((await pLoc('.stat-current').nth(1).textContent()).trim())
      assert(hpAfter === hpBefore - 2, `HP should drop by exactly 2 (${hpBefore} → ${hpAfter})`)
    })

    /* ── 12. Reload → resume from server snapshot（存读档已由服务端快照取代） ── */
    await step('reload → 服务端快照续玩（消息 + HP 恢复）', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      // onLoad 带 roomId 参数 → joinRoom → 全量快照恢复
      await waitText(page, '我发动攻击！', 30_000)
      await waitText(page, '（测试模式）你受到了伤害，HP 下降。', 30_000)
      const hp = Number((await pLoc('.stat-current').nth(1).textContent()).trim())
      assert(Number.isFinite(hp) && hp > 0, `HP should be restored (> 0), got "${hp}"`)
    })

    /* ── 13. Home: 未结束 solo 局以「继续」角标出现在故事卡上（T7 移除独立续玩块） ── */
    await step('首页故事卡「继续」角标（续玩入口）', async () => {
      await page.goto(`${WEB_BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitText(page, 'demo-story', 20_000)
      // 进行中局的故事卡带「继续」角标；点击续玩（回游戏页）
      await pLoc('.story-card').filter({ hasText: 'demo-story' }).locator('.story-resume-badge').first().waitFor({ timeout: 15_000 })
      await pLoc('.story-card').filter({ hasText: 'demo-story' }).first().click()
      await waitText(page, '描述你的行动...', 30_000)
    })

    /* ── 14. Screenshot ── */
    await step('screenshot output', async () => {
      fs.mkdirSync(SHOTS_DIR, { recursive: true })
      const shot = path.join(SHOTS_DIR, 'final-game.png')
      await page.screenshot({ path: shot, fullPage: false })
      assert(fs.existsSync(shot), `screenshot not written: ${shot}`)
    })

    await browser.close()
  } catch (err) {
    console.error('\n[E2E] JOURNEY FAILED:', err.message)
    process.exitCode = 1
  } finally {
    const passed = results.filter((r) => r.pass).length
    const failed = results.filter((r) => !r.pass).length
    console.log('\n[E2E] RESULTS')
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.ms}ms${r.error ? '  → ' + r.error : ''}`)
    }
    console.log(`[E2E] ${passed} passed, ${failed} failed`)
    if (failed > 0) {
      console.log(`[E2E] failure artifacts in ${SHOTS_DIR}`)
    }
    console.log('--- server log tail ---\n' + tail(logs.server))
    console.log('--- web log tail ---\n' + tail(logs.web))
    if (!KEEP) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    } else {
      console.log(`[E2E] --keep: temp data kept at ${tmpRoot}`)
    }
    await cleanup()
    if (failed > 0) process.exitCode = 1
    // browser 等 handle 会阻止进程自然退出 → 显式退出
    process.exit(process.exitCode ?? 0)
  }
}

/** Page locator helper bound lazily (page assigned after launch). */
function pLoc(sel) {
  return page.locator(sel)
}

main().catch(async (err) => {
  console.error('[E2E] FATAL', err)
  process.exitCode = 1
  await cleanup()
  process.exit(1)
})

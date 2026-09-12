/**
 * e2e harness 共享帮助函数单源（#64，架构扫描候选 8）。
 *
 * 只收编各 journey 间**逐字节相同**（EOL 归一后）的副本；同名但有行为差异的
 * 副本（registerUser 用户名前缀、openWs 超时/日志、spawnServer env、
 * captureFailure 产物命名等）一律保留在各 journey 本地——不为抽取而统一行为。
 * 逐函数收编/保留对照见 issue #64 票面表格。
 *
 * 闭包依赖用工厂注入（createStep/createApi），内层函数体与被收编副本逐字节相同。
 */

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

export function tail(arr, n = 25) {
  return arr.slice(-n).join('')
}

/* ═══════════════════ Playwright 定位器帮助函数（rooms/h5 journey 共用） ═══════════════════ */

export async function waitText(p, text, timeout = 25_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'visible' })
}

export async function clickText(p, text, opts = {}) {
  const loc = p.getByText(text, { exact: false }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

/** Click a uni-button containing the given text (uni-app compiles <button> → <uni-button>). */
export async function clickBtn(p, text, opts = {}) {
  const loc = p.locator('uni-button').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
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
export async function pickUniOption(p, pickerViewSelector, labelPattern, index = 0) {
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

/* ═══════════════════ 工厂：闭包模块级状态的收编形态 ═══════════════════ */

/**
 * step 依赖各 journey 的模块级 results 数组 → 工厂注入。
 * 内层函数体与 multiroom/dossier 的本地副本逐字节相同。
 */
export function createStep(results) {
  return function step(name, fn) {
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
}

/**
 * api 依赖各文件的模块级 API_BASE → 工厂注入（形参沿用 API_BASE 名，内层函数体
 * 与 multiroom/dossier/byok 的本地副本逐字节相同）。
 */
export function createApi(API_BASE) {
  return async function api(method, p, body, token) {
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
}

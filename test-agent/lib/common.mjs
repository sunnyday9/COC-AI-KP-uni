#!/usr/bin/env node
/**
 * test-agent/lib/common.mjs — 独立测试基建（不依赖项目任何代码）
 *
 * 职责：
 *  1. 读取 mimo/opencode LLM 端点配置（环境变量优先，回退到 ZCode 配置）
 *  2. spawn 项目 server（真实 LLM 模式，非 MOCK）+ H5 dev server
 *  3. HTTP 客户端（注册/登录/settings/导入/索引/存档）
 *  4. WS 客户端（kp:invoke 流式帧监听 + 性能计时）
 *  5. 浏览器启动 + step 运行器 + UI 辅助
 *
 * 使用：`import { ... } from './lib/common.mjs'`
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SHOTS_DIR = path.join(TEST_DIR, 'screenshots')

/* ═══════════════════ LLM 端点配置 ═══════════════════ */

export function getLlmConfig() {
  // 环境变量优先（测试脚本可通过 env 注入）
  const fromEnv = {
    baseUrl: process.env.AW_BASE_URL,
    apiKey: process.env.AW_API_KEY,
    model: process.env.AW_MODEL,
  }
  if (fromEnv.baseUrl && fromEnv.apiKey && fromEnv.model) return fromEnv

  // 回退：从 ZCode 应用配置读取（本机已配置的 opencode/mimo-v2.5）
  // 优先级：dataBaseDir（setting.json）> APPDATA > homedir
  const candidates = []
  try {
    const setting = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'setting.json'), 'utf-8'))
    if (setting.dataBaseDir) candidates.push(path.join(setting.dataBaseDir, '.zcode', 'v2', 'config.json'))
  } catch {
    /* ignore */
  }
  candidates.push(path.join(os.homedir(), '.zcode', 'v2', 'config.json'))
  candidates.push(path.join(process.env.APPDATA || os.homedir(), '.zcode', 'v2', 'config.json'))
  for (const cfgPath of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const provs = cfg.provider || {}
      for (const [id, p] of Object.entries(provs)) {
        const opts = p?.options || {}
        const models = Object.keys(p?.models || {})
        const base = opts.baseURL || opts.baseUrl || '' // 字段实际为 baseURL（大写）
        if (base.includes('opencode') && (models.includes('mimo-v2.5') || models.includes('mimo-v2.5-pro'))) {
          const model = models.includes('mimo-v2.5') ? 'mimo-v2.5' : 'mimo-v2.5-pro'
          return { baseUrl: base, apiKey: opts.apiKey, model, providerId: id }
        }
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(
    '无法获取 LLM 端点配置。请设置 AW_BASE_URL / AW_API_KEY / AW_MODEL 环境变量，' +
      '或在 ~/.zcode/v2/config.json 配置 opencode/mimo-v2.5 provider。',
  )
}

/* ═══════════════════ 服务启动/清理 ═══════════════════ */

const children = []
const logs = { server: [], web: [] }

export function tail(arr, n = 30) {
  return arr.slice(-n).join('')
}

function spawnServer(tmpRoot, port, llm) {
  const serverDir = path.join(ROOT, 'server')
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'test-agent-secret-change-me',
      DATA_DIR: path.join(tmpRoot, 'data'),
      RAG_DATA_DIR: path.join(tmpRoot, 'rag'),
      UPLOADS_DIR: path.join(tmpRoot, 'uploads'),
      MODELS_DIR: path.join(tmpRoot, 'models'),
      // 注意：不设 MOCK_AI — 走真实 LLM 路径
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.server.push(d.toString()))
  child.stderr.on('data', (d) => logs.server.push(d.toString()))
  child.on('exit', (code) => logs.server.push(`\n[server exited code=${code}]\n`))
  children.push(child)
  return child
}

function spawnWeb(apiBase) {
  const clientDir = path.join(ROOT, 'client')
  const uniCli = path.join(ROOT, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')
  const child = spawn(process.execPath, [uniCli], {
    cwd: clientDir,
    env: { ...process.env, VITE_API_BASE: apiBase },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.web.push(d.toString()))
  child.stderr.on('data', (d) => logs.web.push(d.toString()))
  child.on('exit', (code) => logs.web.push(`\n[web exited code=${code}]\n`))
  children.push(child)
  return child
}

export function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        c.kill('SIGTERM')
      }
    } catch {
      /* ignore */
    }
  }
}

export async function pollUrl(url, timeoutMs = 60_000, label = url) {
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
  throw new Error(`Timed out waiting for ${label}\n--- server log ---\n${tail(logs.server)}`)
}

/** 启动全部服务，返回 { apiBase, webBase, tmpRoot }；web=false 时只启动后端 */
export async function startServices(apiPort = 3101, webPort = 5176, { web = true } = {}) {
  const apiBase = `http://localhost:${apiPort}`
  const webBase = `http://localhost:${webPort}`
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'))

  // 预检端口
  for (const [url, label] of [[`${apiBase}/`, 'API'], ...(web ? [[`${webBase}/`, 'web']] : [])]) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) })
      throw new Error(`${label} port ${url} 已被占用 — 请先停止或换端口`)
    } catch (err) {
      if (err.message.includes('已被占用')) throw err
      /* refused → free */
    }
  }

  spawnServer(tmpRoot, apiPort)
  await pollUrl(`${apiBase}/api/auth/me`, 60_000, 'backend')
  if (web) {
    spawnWeb(apiBase)
    await pollUrl(`${webBase}/`, 120_000, 'H5 dev server')
  }

  return { apiBase, webBase, tmpRoot, apiPort, webPort }
}

/* ═══════════════════ HTTP 客户端 ═══════════════════ */

let _token = null
export function setToken(t) {
  _token = t
}

export async function api(apiBase, method, pathname, body, token = _token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text }
}

/** 注册并登录，返回 token */
export async function registerUser(apiBase, username, password) {
  const r = await api(apiBase, 'POST', '/api/auth/register', { username, password })
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`register failed (${r.status}): ${r.text}`)
  }
  const token = r.json?.token
  if (!token) throw new Error(`register ok but no token: ${r.text}`)
  setToken(token)
  return token
}

/** 配置 AI settings（mimo 端点） */
export async function saveAiSettings(apiBase, llm, token) {
  const r = await api(
    apiBase,
    'PUT',
    '/api/settings',
    {
      ai: {
        provider: 'openai_compatible',
        baseUrl: llm.baseUrl,
        model: llm.model,
        temperature: 0.7,
        maxTokens: 4096,
        apiKey: llm.apiKey,
      },
    },
    token,
  )
  if (r.status !== 200) throw new Error(`saveAiSettings failed (${r.status}): ${r.text}`)
  return r.json
}

/** 上传并索引剧本 */
export async function uploadAndIndex(apiBase, fixturePath, token) {
  // multipart 上传 — 用 FormData
  const buf = fs.readFileSync(fixturePath)
  const fd = new FormData()
  fd.append('file', new Blob([buf]), path.basename(fixturePath))
  const res = await fetch(`${apiBase}/api/stories/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`upload failed (${res.status}): ${text}`)
  }
  // 索引
  const idx = await api(apiBase, 'POST', '/api/rag/index', { scriptId: json?.scriptId ?? json?.id }, token)
  if (idx.status !== 200) throw new Error(`index failed (${idx.status}): ${idx.text}`)
  return { upload: json, index: idx.json }
}

/* ═══════════════════ WS 客户端（kp:invoke 流式） ═══════════════════ */

/**
 * 建立 WS 连接并监听 kp:invoke 帧。
 * 返回 { close(), sendInvoke(streamId, messages), onFrame(cb) }
 */
export function connectWs(apiBase, token) {
  // 从 http://host:port 构造 ws://host:port/ws?token=
  const u = new URL(apiBase)
  const wsUrl = `ws://${u.host}/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(wsUrl)

  const frameHandlers = new Set()
  const streamState = new Map() // streamId -> { chunks, traces, end, error, startTs }

  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    const sid = msg.streamId
    if (sid) {
      const st = streamState.get(sid) || { chunks: [], traces: [], toolCalls: [], startTs: Date.now() }
      if (msg.type === 'chunk') st.chunks.push(msg.chunk)
      else if (msg.type === 'trace') st.traces.push(...(msg.traceEvents || []))
      else if (msg.type === 'end') {
        st.end = msg
        st.endTs = Date.now()
      } else if (msg.type === 'error') {
        st.error = msg.error
        st.endTs = Date.now()
      }
      streamState.set(sid, st)
    }
    for (const h of frameHandlers) {
      try {
        h(msg)
      } catch {
        /* handler errors ignored */
      }
    }
  }

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error(`WS connect error: ${e.message || 'unknown'}`))
  })

  return {
    opened,
    /** 发送 kp:invoke，等待 end/error 帧（超时可配） */
    async invoke(messages, { streamId = `sid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timeoutMs = 180_000 } = {}, storyContext = undefined) {
      await opened
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`kp:invoke 超时 (${timeoutMs}ms) — streamId=${streamId}`))
        }, timeoutMs)
        const h = (msg) => {
          if (msg.streamId !== streamId) return
          if (msg.type === 'end') {
            clearTimeout(timer)
            frameHandlers.delete(h)
            resolve({ streamId, content: msg.content, toolCalls: msg.toolCalls || [], traces: st().traces, chunks: st().chunks })
          } else if (msg.type === 'error') {
            clearTimeout(timer)
            frameHandlers.delete(h)
            reject(new Error(`kp:invoke error: ${msg.error}`))
          }
        }
        const st = () => streamState.get(streamId) || { traces: [], chunks: [] }
        frameHandlers.add(h)
        const frame = { type: 'kp:invoke', streamId, messages }
        if (storyContext !== undefined && storyContext !== null) frame.storyContext = storyContext
        ws.send(JSON.stringify(frame))
      })
      return done
    },
    /** 订阅所有帧（用于性能计时/计数） */
    onFrame(cb) {
      frameHandlers.add(cb)
    },
    offFrame(cb) {
      frameHandlers.delete(cb)
    },
    getState(sid) {
      return streamState.get(sid)
    },
    close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
  }
}

/* ═══════════════════ 浏览器 ═══════════════════ */

export async function launchBrowser() {
  const explicit = process.env.E2E_BROWSER
  if (explicit) {
    if (explicit === 'msedge' || explicit === 'chrome') return chromium.launch({ channel: explicit })
    return chromium.launch({ executablePath: explicit })
  }
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel })
    } catch {
      /* next */
    }
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return await chromium.launch({ executablePath: p })
      } catch {
        /* next */
      }
    }
  }
  throw new Error('No browser found — install Edge/Chrome or set E2E_BROWSER')
}

/* ═══════════════════ step 运行器 ═══════════════════ */

const results = []
export function getResults() {
  return results
}

export function step(name, fn, timeoutMs = 120_000) {
  const start = Date.now()
  return Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`step 超时 (${timeoutMs}ms)`)), timeoutMs)),
  ])
    .then(() => {
      const ms = Date.now() - start
      results.push({ name, pass: true, ms })
      console.log(`  [PASS] ${name} (${ms}ms)`)
    })
    .catch(async (err) => {
      const ms = Date.now() - start
      results.push({ name, pass: false, ms, error: err.message })
      console.error(`  [FAIL] ${name} (${ms}ms): ${err.message}`)
      throw err
    })
}

/** 打印结果汇总（供 run-all 收集） */
export function printSummary(scope = '') {
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[${scope || 'TEST'}] RESULTS`)
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.ms}ms${r.error ? '  → ' + r.error : ''}`)
  }
  console.log(`[${scope || 'TEST'}] ${passed} passed, ${failed} failed`)
  return { passed, failed }
}

/* ═══════════════════ UI 辅助（uni-app H5） ═══════════════════ */

export async function waitText(p, text, timeout = 30_000) {
  await p.getByText(text, { exact: false }).first().waitFor({ timeout, state: 'visible' })
}

export async function clickText(p, text, opts = {}) {
  const loc = p.getByText(text, { exact: false }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

export async function clickBtn(p, text, opts = {}) {
  const loc = p.locator('uni-button').filter({ hasText: text }).first()
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 20_000 })
  await loc.click()
}

export async function fillInput(p, placeholder, value) {
  const box = p
    .locator('uni-input, uni-textarea')
    .filter({ has: p.getByText(placeholder, { exact: false }) })
    .first()
  await box.waitFor({ state: 'visible', timeout: 15_000 })
  await box.locator('input, textarea').first().fill(value)
}

export function pLoc(p, sel) {
  return p.locator(sel)
}

#!/usr/bin/env node
/**
 * BYOK 真实 Key 冒烟脚本（#33）——验证「玩家自带 Key」路径端到端可用：
 *   settings 保存真实 key（AES 加密）→ GET 不回传 → /api/ai/models 带 key 实时拉
 *   → /api/ai/chat 真实 LLM 返回。
 *
 * 用法（仓库根，需真实 LLM 环境变量；缺 key 自动跳过 exit 0）：
 *   E2E_REAL_API_KEY=sk-xxx \
 *   E2E_REAL_BASE_URL=https://api.openai.com/v1 \
 *   E2E_REAL_MODEL=gpt-4o-mini \
 *   node e2e/byok-smoke.mjs
 * 环境变量：
 *   E2E_REAL_API_KEY   必填（无则跳过打印说明）
 *   E2E_REAL_BASE_URL  默认 https://api.openai.com/v1
 *   E2E_REAL_MODEL     默认 openai_chat 首个 /models 结果（通常 gpt-4o-mini）
 *   E2E_REAL_PROTOCOL  默认 openai_chat（anthropic_messages/google_compatible 也可）
 *   E2E_API_BASE       后端地址（默认 http://localhost:3100；设了不自启后端）
 *
 * 不进 CI / test:all / 三 journey（它们走 MOCK_AI=1，无需 key）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_BASE = (process.env.E2E_API_BASE || 'http://localhost:3100').replace(/\/+$/, '')
const SELF_START_API = !process.env.E2E_API_BASE

const REAL_KEY = process.env.E2E_REAL_API_KEY || ''
const BASE_URL = process.env.E2E_REAL_BASE_URL || 'https://api.openai.com/v1'
const PROTOCOL = process.env.E2E_REAL_PROTOCOL || 'openai_chat'
const MODEL_OVERRIDE = process.env.E2E_REAL_MODEL || ''

const results = []
function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true })
      console.log(`[PASS] ${name}`)
    })
    .catch((err) => {
      results.push({ name, ok: false })
      console.error(`[FAIL] ${name}: ${err?.message ?? err}`)
      throw err
    })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
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

async function registerUser() {
  const username = `byok_${Date.now()}`
  const password = 'byok-pass-1'
  const reg = await api('POST', '/api/auth/register', { username, password })
  assert(reg.status === 200, `register failed: ${reg.status} ${JSON.stringify(reg.data)}`)
  const login = await api('POST', '/api/auth/login', { username, password })
  assert(login.status === 200, `login failed: ${login.status}`)
  return { username, token: login.data.token }
}

async function main() {
  if (!REAL_KEY) {
    console.log('[SKIP] E2E_REAL_API_KEY 未设置 — BYOK 真实 key 冒烟需自带 key（如 E2E_REAL_API_KEY=sk-... E2E_REAL_BASE_URL=... node e2e/byok-smoke.mjs）。三 journey / CI 走 MOCK_AI=1 不受影响。')
    return { skipped: true }
  }

  let serverProc = null
  if (SELF_START_API) {
    // 非 mock 后端（真实 LLM 路径）。端口冲突时由调用方保证 3100 空闲。
    serverProc = spawn('npm', ['run', 'dev'], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, MOCK_AI: '0' },
      stdio: 'ignore',
      detached: false,
    })
    // 等后端就绪（轮询 /api/health 类探活；无则试 auth/me 401）
    let up = false
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const probe = await fetch(`${API_BASE}/api/auth/me`)
        if (probe.status === 401 || probe.status === 200) { up = true; break }
      } catch { /* not up yet */ }
    }
    assert(up, 'backend did not come up in 15s')
  }

  const user = await registerUser()
  const token = user.token

  try {
    await step('settings 保存真实 key（PUT /api/settings）', async () => {
      const saved = await api('PUT', '/api/settings', {
        ai: {
          protocol: PROTOCOL,
          baseUrl: BASE_URL,
          apiKey: REAL_KEY,
          model: MODEL_OVERRIDE || 'temp-model-to-fill',
          temperature: 0.7,
          maxTokens: 1024,
        },
      }, token)
      assert(saved.status === 200, `save settings failed: ${saved.status} ${JSON.stringify(saved.data)}`)
    })

    await step('GET /api/settings 不回传 apiKey', async () => {
      const got = await api('GET', '/api/settings', undefined, token)
      assert(got.status === 200, `get settings failed: ${got.status}`)
      assert(!('apiKey' in (got.data?.ai ?? {})), 'apiKey must not be returned to client')
    })

    await step('/api/ai/models 带 key 实时拉取', async () => {
      const list = await api('GET', '/api/ai/models', undefined, token)
      assert(list.status === 200, `listModels failed: ${list.status} ${JSON.stringify(list.data)}`)
      const models = list.data?.models ?? list.data ?? []
      assert(Array.isArray(models) && models.length > 0, `no models returned: ${JSON.stringify(list.data).slice(0, 200)}`)
      if (!MODEL_OVERRIDE) {
        // 用首个真实模型覆写 settings（未显式指定时）
        const first = models[0]?.value ?? models[0]?.id
        assert(first, 'models list has no usable id')
        const saved = await api('PUT', '/api/settings', { ai: { protocol: PROTOCOL, baseUrl: BASE_URL, apiKey: REAL_KEY, model: first } }, token)
        assert(saved.status === 200, `save model failed: ${saved.status}`)
      }
    })

    await step('/api/ai/chat 真实 LLM 返回（Say OK）', async () => {
      const chat = await api('POST', '/api/ai/chat', {
        messages: [{ role: 'user', content: 'Say OK in one word.' }],
        stream: false,
      }, token)
      assert(chat.status === 200, `chat failed: ${chat.status} ${JSON.stringify(chat.data).slice(0, 300)}`)
      const content = chat.data?.content ?? chat.data?.message ?? ''
      assert(typeof content === 'string' && content.trim().length > 0, `empty chat content: ${JSON.stringify(chat.data).slice(0, 200)}`)
      console.log(`    → 模型返回: ${String(content).trim().slice(0, 120)}`)
    })

    console.log('\nBYOK 真实 key 冒烟全绿（settings 加密存储 / 不回传 / models / chat）。')
  } finally {
    // 清理临时用户（无 DELETE /api/users —— 留痕可接受：MOCK 后端同款副产物）
    if (serverProc) {
      // Windows 下杀进程树
      spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
      serverProc = null
    }
  }
}

main()
  .then(({ skipped } = {}) => {
    if (!skipped) {
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        console.error(`\n${failed.length} step(s) failed`)
        process.exit(1)
      }
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\n[ERROR] ${err?.message ?? err}`)
    process.exit(1)
  })

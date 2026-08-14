/**
 * Platform config (Task 6) — baseURL resolution + WS URL construction.
 *
 * Convention: `VITE_API_BASE` is the API root (i.e. it already ends at
 * `.../api` or is the bare server origin; the bridge tolerates both via
 * `joinApiUrl`).
 *   - H5:   `import.meta.env.VITE_API_BASE` or `/api` (same-origin; the vite
 *           dev proxy for `/api` + `/ws` is wired in Task 11). Absolute WS
 *           URL is derived from `location` at runtime.
 *   - mp-weixin / app: `import.meta.env.VITE_API_BASE` MUST be an absolute
 *           URL (e.g. `https://your-server.com` or `https://your-server.com/api`).
 *           No sane relative default exists on those platforms — if unset,
 *           requests fail fast with an actionable error. (A manifest.json
 *           field could be wired here later; extension point noted below.)
 *
 * WS endpoint per api-contract §4: `ws(s)://<host>/ws?token=<JWT>` — the
 * token query is appended by ws.ts at connect time (it changes on login).
 */
let cachedBaseUrl: string | null = null

/** Runtime platform from uni.getSystemInfoSync().uniPlatform. */
export function getPlatform(): 'h5' | 'mp-weixin' | 'app' {
  try {
    const up: unknown = uni.getSystemInfoSync()?.uniPlatform
    if (up === 'web' || up === 'h5') return 'h5'
    if (up === 'mp-weixin') return 'mp-weixin'
    if (up === 'app' || up === 'app-plus') return 'app'
    return 'h5'
  } catch {
    return 'h5'
  }
}

function readEnvBaseUrl(): string {
  const env = (import.meta.env?.VITE_API_BASE ?? '') as string
  return env ? env.replace(/\/+$/, '') : ''
}

/** Resolve the API base URL (cached after first call). */
export function getBaseUrl(): string {
  if (cachedBaseUrl !== null) return cachedBaseUrl
  const envUrl = readEnvBaseUrl()
  if (envUrl) {
    cachedBaseUrl = envUrl
    return cachedBaseUrl
  }
  if (getPlatform() === 'h5') {
    cachedBaseUrl = '/api' // same-origin; vite dev proxy (Task 11)
    return cachedBaseUrl
  }
  // mp-weixin / app need an absolute URL — fail fast at request time with a
  // clear message instead of guessing a broken default.
  cachedBaseUrl = ''
  return cachedBaseUrl
}

/** Test hook: forget the cached base URL (also resets in tests between cases). */
export function resetBaseUrlCache(): void {
  cachedBaseUrl = null
}

/**
 * Join an API path onto the base. Tolerates both conventions for
 * VITE_API_BASE (`https://host` vs `https://host/api`).
 */
export function joinApiUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  if (b.endsWith('/api') && p.startsWith('/api')) {
    return b + p.slice('/api'.length)
  }
  return b + p
}

/**
 * WS endpoint base (without the token query), per api-contract §4.
 * `http` → `ws`, `https` → `wss`; a trailing `/api` suffix is stripped so the
 * WS lives at the host root (`/ws`), not under `/api`.
 */
export function getWsBaseUrl(): string {
  const base = getBaseUrl()
  if (!base) throw new Error('Bridge: 未配置后端地址 — 小程序/App 需设置 VITE_API_BASE 为绝对 URL（如 https://your-server.com）')
  if (base.startsWith('/')) {
    // same-origin (H5). Prefer an absolute URL built from location so native
    // WebSocket (which requires absolute URLs) works; fall back to the
    // relative path for dev-proxied setups / tests.
    const loc = typeof location !== 'undefined' ? location : undefined
    if (loc && typeof loc.protocol === 'string' && typeof loc.host === 'string' && loc.host) {
      return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
    }
    return '/ws'
  }
  let host = base.replace(/\/+$/, '')
  if (host.endsWith('/api')) host = host.slice(0, -'/api'.length)
  host = host.replace(/\/+$/, '')
  return `${host.replace(/^http/, 'ws')}/ws`
}

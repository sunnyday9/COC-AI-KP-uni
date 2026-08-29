/**
 * Platform layer entry (Task 6) — Bridge singleton.
 *
 * All Task 7-10 code should access the backend via `getBridge()`.
 * `initBridge()` returns the same singleton and optionally warms the WS
 * connection when a token already exists (preconnect strategy; failures are
 * swallowed — the WSService backoff reconnects on the next connect()).
 */
import { PlatformBridge } from './bridge'
import { getToken } from './token'

let instance: PlatformBridge | null = null

export function getBridge(): PlatformBridge {
  if (!instance) instance = new PlatformBridge()
  return instance
}

export function initBridge(options: { preconnect?: boolean } = {}): PlatformBridge {
  const bridge = getBridge()
  if (options.preconnect && getToken()) {
    bridge.connectWs().catch(() => {
      // warm-up only — connect() failures are already handled inside WSService
    })
  }
  return bridge
}

export type { UploadResult } from './bridge'
export { BridgeError } from './bridge'
export { getBaseUrl, getWsBaseUrl, getPlatform } from './config'
export { getToken, setToken, clearToken, onUnauthorized } from './token'

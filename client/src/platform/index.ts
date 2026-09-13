/**
 * Platform layer entry (Task 6) — Bridge singleton.
 *
 * All Task 7-10 code should access the backend via `getBridge()`.
 * WS 连接是 on-demand 策略：roomStore.joinRoom 按需调 `bridge.connectWs()`
 * （见 ws.ts），无需入口预热。
 */
import { PlatformBridge } from './bridge'

let instance: PlatformBridge | null = null

export function getBridge(): PlatformBridge {
  if (!instance) instance = new PlatformBridge()
  return instance
}

export { getBaseUrl, getWsBaseUrl, getPlatform } from './config'
export { getToken, setToken, clearToken, onUnauthorized } from './token'

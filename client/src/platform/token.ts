/**
 * Token management (Task 6) — uni storage + 401 event bus.
 *
 * - Token persisted under `aikp_token` via uni.setStorageSync so it survives
 *   restarts on every platform (H5 localStorage / mp storage / App storage).
 * - A 401 response clears the token and fires `onUnauthorized` listeners.
 *   The bridge only EMITS the event — page navigation to the login screen is
 *   the page layer's job (Task 8), per task-6-brief decision 2.
 */
export const TOKEN_KEY = 'aikp_token'

export type UnauthorizedListener = () => void

const listeners = new Set<UnauthorizedListener>()

export function getToken(): string | null {
  try {
    const value: unknown = uni.getStorageSync(TOKEN_KEY)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  uni.setStorageSync(TOKEN_KEY, token)
}

export function clearToken(): void {
  try {
    uni.removeStorageSync(TOKEN_KEY)
  } catch {
    // storage may be unavailable (e.g. private mode) — nothing to clear anyway
  }
}

/** Register a 401 handler; returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Clear the stored token and notify all 401 listeners (idempotent). */
export function emitUnauthorized(): void {
  clearToken()
  const snapshot = [...listeners]
  for (const l of snapshot) {
    try {
      l()
    } catch {
      // a listener must never break the event dispatch
    }
  }
}

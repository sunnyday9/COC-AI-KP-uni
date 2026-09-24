interface RetryableBridgeError {
  isBridgeError?: unknown
  networkError?: unknown
  statusCode?: unknown
}

export function isRetryableBridgeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const details = error as RetryableBridgeError
  if (details.isBridgeError !== true) return false
  if (details.networkError === true) return true
  const status = details.statusCode
  return typeof status === 'number' && (status === 408 || status === 425 || status === 429 || status >= 500)
}

export async function retryTransientRequest<T>(
  request: () => Promise<T>,
  options: { maxAttempts?: number; wait?: (delayMs: number) => Promise<void>; random?: () => number } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const random = options.random ?? Math.random

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await request()
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableBridgeError(error)) throw error
      const delayMs = Math.min(500 * (2 ** (attempt - 1)), 2_000)
      await wait(Math.round(delayMs * (0.8 + random() * 0.4)))
    }
  }
  throw new Error('request retry loop exhausted')
}

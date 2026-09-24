import { BadRequestError, UnauthorizedError } from './errors.js'

export function isRetryableFailure(error: unknown): boolean {
  if (error instanceof BadRequestError || error instanceof UnauthorizedError) return false
  if (!error || typeof error !== 'object') return false

  const details = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; name?: unknown }
  const status = typeof details.statusCode === 'number' ? details.statusCode : details.status
  if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500

  const message = typeof details.message === 'string' ? details.message : ''
  const statusInMessage = message.match(/\b([45]\d{2})\b/)
  if (statusInMessage) {
    const code = Number(statusInMessage[1])
    if (code >= 400 && code < 500) return code === 408 || code === 425 || code === 429
    if (code >= 500) return true
  }
  if (/invalid api key|unauthorized|forbidden|model .*not found|请先在设置|请在设置中填写|invalid.*config/i.test(message)) return false

  if (typeof details.code === 'string' && /^(?:E(?:CONN|HOST|NET|AI)_|ETIMEDOUT$|EPIPE$|UND_ERR_CONNECT_TIMEOUT$)/i.test(details.code)) return true
  return details.name === 'UpstreamError' || /network|timeout|timed out|fetch failed|socket|econn|eai_again|temporarily unavailable|upstream|service unavailable/i.test(message)
}

export function retryDelayMs(retryNumber: number, baseDelayMs = 300, maxDelayMs = 2_000, random = Math.random): number {
  const capped = Math.min(baseDelayMs * (2 ** Math.max(0, retryNumber - 1)), maxDelayMs)
  return Math.round(capped * (0.8 + random() * 0.4))
}

export async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

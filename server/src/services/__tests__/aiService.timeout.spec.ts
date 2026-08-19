/**
 * aiService per-request timeout (perf A3):
 *  - non-streaming calls are capped by LLM_REQUEST_TIMEOUT_MS;
 *  - streaming calls are NOT time-limited (chunk activity is the liveness signal).
 * The race helper `withRequestTimeout` is exported and verified here directly;
 * its wiring into chat/chatForAgent/chatForRag is covered by the code path
 * (all three non-streaming branches call it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { LLM_REQUEST_TIMEOUT_MS, withRequestTimeout } from '../aiService.js'

describe('aiService withRequestTimeout (perf A3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('constant is 60s (finite positive)', () => {
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(Number.isFinite(LLM_REQUEST_TIMEOUT_MS)).toBe(true)
  })

  it('resolves when the underlying promise settles first', async () => {
    const result = await withRequestTimeout(Promise.resolve('ok'), 'test')
    expect(result).toBe('ok')
  })

  it('rejects with the label when the promise hangs past the timeout', async () => {
    vi.useFakeTimers()
    const hung = new Promise<never>(() => { /* never settles */ })
    const p = withRequestTimeout(hung, 'kp agent LLM')
    const assertion = expect(p).rejects.toThrow('kp agent LLM timed out after 60000ms')
    await vi.advanceTimersByTimeAsync(LLM_REQUEST_TIMEOUT_MS + 1)
    await assertion
  })

  it('rejects fast when the underlying promise rejects', async () => {
    await expect(withRequestTimeout(Promise.reject(new Error('upstream boom')), 'test')).rejects.toThrow('upstream boom')
  })
})

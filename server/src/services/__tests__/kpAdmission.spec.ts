import { afterEach, expect, it, vi } from 'vitest'
import { acquireKpTurn } from '../kpAdmission.js'

afterEach(() => vi.unstubAllEnvs())

it('preserves FIFO admission and removes disconnected waiters', async () => {
  vi.stubEnv('KP_ACTIVE_TURNS', '1')
  const active = await acquireKpTurn(new AbortController().signal)
  expect(active).not.toBeNull()
  const abandoned = new AbortController()
  const cancelled = acquireKpTurn(abandoned.signal)
  const second = acquireKpTurn(new AbortController().signal)
  const promoted = vi.fn()
  const third = acquireKpTurn(new AbortController().signal).then((release) => {
    promoted()
    return release
  })
  abandoned.abort()
  await expect(cancelled).resolves.toBeNull()
  expect(promoted).not.toHaveBeenCalled()
  active?.()
  const releaseSecond = await second
  expect(promoted).not.toHaveBeenCalled()
  releaseSecond?.()
  const releaseThird = await third
  expect(promoted).toHaveBeenCalledOnce()
  releaseThird?.()
})

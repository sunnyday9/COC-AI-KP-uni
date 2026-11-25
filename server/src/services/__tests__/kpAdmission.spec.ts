import { afterEach, expect, it, vi } from 'vitest'
import { acquireKpTurn, keeperPressureMetrics } from '../kpAdmission.js'

afterEach(() => vi.unstubAllEnvs())

it('preserves FIFO admission and removes disconnected waiters', async () => {
  vi.stubEnv('KP_ACTIVE_TURNS', '1')
  const lane = { ownerId: 1, provider: 'test' }
  const active = await acquireKpTurn(lane, new AbortController().signal)
  expect(active).not.toBeNull()
  const abandoned = new AbortController()
  const cancelled = acquireKpTurn(lane, abandoned.signal)
  const second = acquireKpTurn(lane, new AbortController().signal)
  const promoted = vi.fn()
  const third = acquireKpTurn(lane, new AbortController().signal).then((release) => {
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

it('skips blocked lanes, bounds each lane, and expires older waiters', async () => {
  vi.stubEnv('KP_ACTIVE_TURNS', '3')
  vi.stubEnv('KP_ACTIVE_PER_PROVIDER', '1')
  vi.stubEnv('KP_ACTIVE_PER_ACCOUNT', '1')
  vi.stubEnv('KP_PENDING_PER_PROVIDER', '1')
  vi.stubEnv('KP_PENDING_PER_ACCOUNT', '1')
  vi.stubEnv('KP_QUEUE_TIMEOUT_MS', '100')
  const signal = new AbortController().signal
  const release = await acquireKpTurn({ ownerId: 1, provider: 'first' }, signal)
  const providerWait = acquireKpTurn({ ownerId: 2, provider: 'first' }, signal)
  const accountWait = acquireKpTurn({ ownerId: 1, provider: 'second' }, signal)
  const expiry = expect(providerWait).rejects.toMatchObject({ reason: 'queue_full' })
  const accountExpiry = expect(accountWait).rejects.toMatchObject({ reason: 'queue_full' })
  const independent = await acquireKpTurn({ ownerId: 3, provider: 'third' }, signal)
  try {
    await expect(acquireKpTurn({ ownerId: 4, provider: 'first' }, signal)).rejects.toMatchObject({ reason: 'queue_full' })
    await expect(acquireKpTurn({ ownerId: 1, provider: 'fourth' }, signal)).rejects.toMatchObject({ reason: 'queue_full' })
    expect(keeperPressureMetrics()).toMatchObject({ active: 2, pending: 2 })
    await Promise.all([expiry, accountExpiry])
    expect(keeperPressureMetrics()).toMatchObject({ active: 2, pending: 0 })
  } finally {
    release?.()
    independent?.()
  }
})

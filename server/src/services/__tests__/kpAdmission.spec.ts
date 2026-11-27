import { afterEach, expect, it, vi } from 'vitest'
import { acquireKpTurn, createKeeperExecution, keeperLane, keeperPressureMetrics, requestKeeper } from '../kpAdmission.js'

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
    expect(keeperPressureMetrics('test metrics secret')).toMatchObject({ active: 2, pending: 2 })
    await Promise.all([expiry, accountExpiry])
    expect(keeperPressureMetrics('test metrics secret')).toMatchObject({ active: 2, pending: 0 })
  } finally {
    release?.()
    independent?.()
  }
})

it('propagates Retry-After to the same credentials, with private and stable lane labels', async () => {
  vi.stubEnv('KP_ACTIVE_TURNS', '3')
  vi.stubEnv('KP_ACTIVE_PER_ACCOUNT', '1')
  vi.stubEnv('KP_ACTIVE_PER_PROVIDER', '2')
  const signal = new AbortController().signal
  const owner = 739_174_603
  const ai = {
    baseUrl: 'https://cooldown.example/v1', protocol: 'openai_chat', model: 'fixture-model',
    temperature: 0, maxTokens: 100,
  } as const
  const lane = keeperLane(owner, ai)
  const release = await acquireKpTurn(lane, signal)
  const execution = createKeeperExecution(ai, lane, signal)
  try {
    const queued = acquireKpTurn(keeperLane(owner, { ...ai, baseUrl: 'https://cooldown.example/v2' }), signal)
    const paused = expect(queued).rejects.toMatchObject({ reason: 'provider_limited', retryAt: expect.any(Number) })
    const before = keeperPressureMetrics('test metrics secret')
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error('Synthetic rate limit'), { status: 429, headers: new Headers({ 'retry-after': '86400' }) })
    })
    await expect(requestKeeper(execution, attempt)).rejects.toMatchObject({ reason: 'provider_limited' })
    await paused
    await expect(acquireKpTurn(lane, signal)).rejects.toMatchObject({
      reason: 'provider_limited', retryAt: expect.any(Number),
    })
    expect(attempt).toHaveBeenCalledOnce()
    expect(keeperPressureMetrics('test metrics secret')).toMatchObject({
      cooldowns: { count: 1, maxLanes: 4096, maxMs: 3_600_000 },
    })
    await acquireKpTurn({ ...lane, ownerId: owner + 1 }, signal).then((releaseOther) => {
      expect(releaseOther).not.toBeNull()
      releaseOther?.()
    })
    release?.()
    const otherProvider = await acquireKpTurn({ ...lane, provider: 'https://unrelated.example' }, signal)
    expect(otherProvider).not.toBeNull()
    otherProvider?.()
    const after = keeperPressureMetrics('test metrics secret')
    expect(before.providers.busiest[0]).toMatchObject({ label: after.providers.busiest[0]?.label, active: 1, pending: 1 })
    expect(before.accounts.busiest[0]).toMatchObject({ label: after.accounts.busiest[0]?.label })
    expect(after.providers.busiest[0]).toMatchObject({ cooling: 1, active: 0, pending: 0 })
    expect(after.accounts.busiest[0]?.label).not.toBe(after.providers.busiest[0]?.label)
    expect(keeperPressureMetrics('rotated metrics secret').accounts.busiest[0]?.label).not.toBe(after.accounts.busiest[0]?.label)
    expect(JSON.stringify(after)).not.toMatch(/cooldown\.example|739174603|fixture-model/)
    const afterMaximumCooldown = Date.now() + 3_600_001
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(afterMaximumCooldown)
    const afterExpiry = await acquireKpTurn(lane, signal)
    expect(afterExpiry).not.toBeNull()
    afterExpiry?.()
  } finally {
    vi.useRealTimers()
    execution.close()
    release?.()
  }
})

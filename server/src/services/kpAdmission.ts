import { setTimeout as delay } from 'node:timers/promises'
import { resolveProtocolDefaultBaseUrl } from '../../../shared/constants/providers.js'
import type { KpPauseReason } from '../../../shared/types/room.js'
import type { getAiConfig } from './settingsService.js'

export type KeeperAiSettings = ReturnType<typeof getAiConfig>
interface KeeperLane { ownerId: number; provider: string }
interface Waiter {
  lane: KeeperLane
  begin(): void
}

export class KeeperPressureError extends Error {
  constructor(readonly reason: KpPauseReason, readonly retryAt = 0) {
    super('Keeper paused: ' + reason)
  }
}

function setting(name: string, fallback: number, min: number, max: number): number {
  const number = Number(process.env[name] ?? fallback)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}

function limits() {
  const active = setting('KP_ACTIVE_TURNS', 16, 1, 1024)
  const pending = setting('KP_PENDING_TURNS', 128, 1, 4096)
  return {
    active, pending,
    activeProvider: Math.min(setting('KP_ACTIVE_PER_PROVIDER', 4, 1, 1024), Math.max(1, active - 1)),
    activeAccount: Math.min(setting('KP_ACTIVE_PER_ACCOUNT', 2, 1, 1024), Math.max(1, active - 1)),
    pendingProvider: Math.min(setting('KP_PENDING_PER_PROVIDER', 32, 1, 4096), Math.max(1, pending - 1)),
    pendingAccount: Math.min(setting('KP_PENDING_PER_ACCOUNT', 8, 1, 4096), Math.max(1, pending - 1)),
  }
}

export function keeperLane(ownerId: number, ai: KeeperAiSettings): KeeperLane {
  const url = ai.baseUrl || (ai.protocol ? resolveProtocolDefaultBaseUrl(ai.protocol) : '')
  return { ownerId, provider: URL.parse(url)?.origin ?? 'unconfigured' }
}

let active = 0
const waiting: Waiter[] = []
const activeProviders = new Map<string, number>()
const activeAccounts = new Map<number, number>()
const pendingProviders = new Map<string, number>()
const pendingAccounts = new Map<number, number>()
const queue = { started: 0, rejected: 0, timedOut: 0, totalWaitMs: 0, maxWaitMs: 0 }
const provider = { requests: 0, totalLatencyMs: 0, maxLatencyMs: 0, retries: 0, limited: 0, timedOut: 0 }

function adjust<Key>(counts: Map<Key, number>, key: Key, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

function pending(lane: KeeperLane, delta: number): void {
  adjust(pendingProviders, lane.provider, delta)
  adjust(pendingAccounts, lane.ownerId, delta)
}

function canStart(lane: KeeperLane, cap: ReturnType<typeof limits>): boolean {
  return active < cap.active &&
    (activeProviders.get(lane.provider) ?? 0) < cap.activeProvider &&
    (activeAccounts.get(lane.ownerId) ?? 0) < cap.activeAccount
}

function start(lane: KeeperLane, enteredAt: number): () => void {
  active++
  adjust(activeProviders, lane.provider, 1)
  adjust(activeAccounts, lane.ownerId, 1)
  const waitMs = performance.now() - enteredAt
  queue.started++
  queue.totalWaitMs += waitMs
  queue.maxWaitMs = Math.max(queue.maxWaitMs, waitMs)
  let released = false
  return () => {
    if (released) return
    released = true
    active--
    adjust(activeProviders, lane.provider, -1)
    adjust(activeAccounts, lane.ownerId, -1)
    drain()
  }
}

function drain(): void {
  const cap = limits()
  while (active < cap.active) {
    const index = waiting.findIndex(({ lane }) => canStart(lane, cap))
    if (index < 0) return
    const [next] = waiting.splice(index, 1)
    pending(next!.lane, -1)
    next!.begin()
  }
}

export function acquireKpTurn(lane: KeeperLane, signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null)
  const cap = limits()
  const enteredAt = performance.now()
  if (canStart(lane, cap)) return Promise.resolve(start(lane, enteredAt))
  if (waiting.length >= cap.pending || (pendingProviders.get(lane.provider) ?? 0) >= cap.pendingProvider ||
      (pendingAccounts.get(lane.ownerId) ?? 0) >= cap.pendingAccount) {
    queue.rejected++
    return Promise.reject(new KeeperPressureError('queue_full'))
  }
  return new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
    const waiter = { lane, begin: () => { clear(); resolve(start(lane, enteredAt)) } }
    const remove = () => {
      const index = waiting.indexOf(waiter)
      if (index < 0) return false
      waiting.splice(index, 1)
      pending(lane, -1)
      clear()
      return true
    }
    const cancel = () => { if (remove()) resolve(null) }
    const timer = setTimeout(() => {
      if (!remove()) return
      queue.timedOut++
      reject(new KeeperPressureError('queue_full'))
    }, setting('KP_QUEUE_TIMEOUT_MS', 30_000, 100, 600_000))
    timer.unref()
    pending(lane, 1)
    waiting.push(waiter)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** Background memory work uses an available turn slot without adding queue pressure. */
export function tryAcquireKpTurn(lane: KeeperLane, signal: AbortSignal): (() => void) | null {
  return !signal.aborted && canStart(lane, limits()) ? start(lane, performance.now()) : null
}

/** No host/account labels leave this process. Cardinality is bounded even under churn. */
export function keeperPressureMetrics() {
  const summarize = <Key>(a: Map<Key, number>, p: Map<Key, number>) => {
    const keys = new Set([...a.keys(), ...p.keys()])
    const lanes = [...keys].map((key) => ({ active: a.get(key) ?? 0, pending: p.get(key) ?? 0 }))
      .sort((left, right) => right.pending - left.pending || right.active - left.active)
    return { count: lanes.length, busiest: lanes.slice(0, 32) }
  }
  return {
    active, pending: waiting.length, limits: limits(), queue: { ...queue }, provider: { ...provider },
    providers: summarize(activeProviders, pendingProviders), accounts: summarize(activeAccounts, pendingAccounts),
  }
}

export interface KeeperExecution {
  ai: KeeperAiSettings
  signal: AbortSignal
  retries: number
  close(): void
}

export function createKeeperExecution(ai: KeeperAiSettings, lifetime: AbortSignal): KeeperExecution {
  const deadline = AbortSignal.timeout(setting('KP_TURN_TIMEOUT_MS', 120_000, 100, 1_800_000))
  const completed = new AbortController()
  return {
    ai, signal: AbortSignal.any([lifetime, deadline, completed.signal]),
    retries: setting('KP_PROVIDER_RETRIES', 2, 0, 10),
    close: () => completed.abort(),
  }
}

export async function runKeeperWork<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  let cancel!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([interrupted, work]) }
  finally { signal.removeEventListener('abort', cancel) }
}

function retryDelay(header: Headers | Record<string, string> | undefined): number {
  const value = header instanceof Headers ? header.get('retry-after') : header?.['retry-after']
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds), 8_000_000_000_000) * 1000
  return Math.max(0, Date.parse(value) - Date.now()) || 0
}

/** One budget per turn, including any requests made by classifier or tool continuation. */
export async function requestKeeper<T>(
  execution: KeeperExecution,
  attempt: (signal: AbortSignal) => Promise<T>,
  { retry = true, timeoutMs = 600_000 }: { retry?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  let backoff = 250
  for (;;) {
    execution.signal.throwIfAborted()
    const deadline = AbortSignal.timeout(Math.min(timeoutMs, setting('KP_PROVIDER_REQUEST_MS', 45_000, 100, 600_000)))
    const signal = AbortSignal.any([execution.signal, deadline])
    const startedAt = performance.now()
    provider.requests++
    let retryMs: number
    try {
      return await runKeeperWork(signal, attempt(signal))
    } catch (error) {
      if (execution.signal.aborted) throw execution.signal.reason
      if (deadline.aborted) {
        provider.timedOut++
        throw new KeeperPressureError('timeout')
      }
      const response = error as { status?: number; headers?: Headers | Record<string, string> } | null
      const status = response?.status
      if (status !== 429 && status !== 503) throw error
      provider.limited++
      retryMs = Math.max(backoff, retryDelay(response?.headers))
      if (!retry || execution.retries === 0 || retryMs > 10_000) {
        throw new KeeperPressureError('provider_limited', Date.now() + retryMs)
      }
      execution.retries--
      provider.retries++
      backoff = Math.min(backoff * 2, 4_000)
    } finally {
      const ms = performance.now() - startedAt
      provider.totalLatencyMs += ms
      provider.maxLatencyMs = Math.max(provider.maxLatencyMs, ms)
    }
    await delay(retryMs, undefined, { signal: execution.signal })
  }
}

/** Optional knowledge and memory calls fail fast and leave the primary model's retry budget intact. */
export function keeperAuxiliaryChat(execution: KeeperExecution, ownerId: number, timeoutMs = 1_000) {
  return async (messages: import('./aiService.js').ChatMessage[], maxTokens: number, temperature = 0) => {
    const { chatForRag } = await import('./aiService.js')
    const result = await requestKeeper(execution, (signal) => chatForRag(ownerId, {
      messages, maxTokens, temperature, signal, keeperSettings: execution.ai,
    }), { retry: false, timeoutMs })
    return result.content
  }
}

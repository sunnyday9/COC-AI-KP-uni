import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { isMainThread } from 'node:worker_threads'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { keeperPressureMetrics, requestKeeper } from '../../server/src/services/kpAdmission.ts'

if (isMainThread && (process.env.AIKP_SYNTHETIC_CHILD !== '1' || process.env.MOCK_AI !== '1' || !process.send)) {
  throw new Error('Synthetic preload requires the isolated staging harness')
}

const loop = monitorEventLoopDelay({ resolution: 20 })
if (isMainThread) loop.enable()
if (isMainThread) process.on('message', (message) => {
  if (message === 'drain') process.emit('SIGTERM')
  if (message === 'sample') process.send({
    type: 'sample', rss: process.memoryUsage.rss(), eventLoopP99Ms: loop.percentile(99) / 1e6,
    keeper: process.env.ROOM_RUNTIME === 'worker' ? keeperPressureMetrics('synthetic-fixture') : undefined,
  })
})

const barriers = new Set()
if (isMainThread) process.on('message', (message) => {
  if (message?.type === 'arm') barriers.add(message.id)
  if (message?.type === 'disarm') {
    barriers.delete(message.id)
    process.send({ type: 'disarmed', id: message.id })
  }
})

/** Keep worker admission and request retry logic real. Replace only the model's response and fault barrier. */
export async function runKpTurn(_userId, { messages }, turn) {
  const input = messages.findLast((message) => message.role === 'user')?.content ?? ''
  const ids = [...new Set(Array.from(input.matchAll(/\b(load-[\w-]+)\b/g), ([, id]) => id))]
  const active = ids.at(-1) ?? 'opening'
  const seed = process.env.AIKP_FIXTURE_SEED
  const bucket = createHash('sha256').update(seed + active).digest().readUInt32LE() % 100
  const plannedMs = bucket < 20 ? 40 : bucket < 60 ? 100 : bucket < 94 ? 300 : bucket < 99 ? 800 : 3000
  const execution = turn.execution
  let attempts = 0
  const work = async (signal) => {
    const started = performance.now()
    const injectLimit = active.startsWith('load-limit-') && ++attempts === 1
    const hold = active.startsWith('load-ack-') && barriers.delete(active)
    try {
      if (hold) {
        process.send({ type: 'fault', stage: 'ack', id: active })
        await delay(120_000, undefined, { signal })
      }
      await delay(injectLimit ? 40 : plannedMs, undefined, { signal })
      if (injectLimit) {
        throw Object.assign(new Error('synthetic origin rate limit'), {
          status: 429, headers: { 'retry-after': '1' },
        })
      }
    } finally {
      if (!hold) process.send({ type: 'provider', id: active, ms: performance.now() - started, rateLimit: injectLimit })
    }
  }
  if (execution) await requestKeeper(execution, work)
  else await work()
  if (active.startsWith('load-effect-')) {
    turn.mutatorFactory(turn.activeCharacterId).updateCharacterHP(-2)
    if (barriers.delete(active)) {
      process.send({ type: 'fault', stage: 'effect', id: active })
      await delay(120_000, undefined, { signal: execution?.signal })
    }
  }
  turn.handlers.onEnd({ content: 'Synthetic Keeper: ' + ids.join(' '), displayMessages: [] })
}


/** Echo a deterministic, original-source-anchored extraction for synthetic preparation. */
export async function chatForRag(_userId, { messages, signal }) {
  signal?.throwIfAborted()
  const marker = '=== 剧本内容（本节）===\n'
  const prompt = messages.at(-1)?.content
  if (typeof prompt !== 'string' || !prompt.includes(marker)) throw new Error('Invalid synthetic dossier prompt')
  const raw = prompt.slice(prompt.indexOf(marker) + marker.length).trim()
  await delay(60, undefined, { signal })
  return { content: JSON.stringify({
    meta: { title: 'Synthetic Archive' },
    scenes: [{ id: 'archive', name: 'The archive', sceneText: raw, description: 'A library archive.' }],
    clues: [{ id: 'ledger', description: 'The ledger records the missing sailors.', location: 'The archive' }],
    npcs: [],
    truths: [{ id: 'records', title: 'The archived records', detail: 'Names are recorded in the ledger.', revealScene: 'The archive' }],
    endings: [],
  }) }
}

if (isMainThread) registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../services/storyPreparationClaims.js' && context.parentURL?.endsWith('/workers/storyPreparation.ts')) {
      return { url: new URL('./preparation-ready.mjs', import.meta.url).href, shortCircuit: true }
    }
    if ((specifier === './kpTurnService.js' && context.parentURL?.endsWith('/roomService.ts')) ||
        (specifier === '../../services/aiService.js' && context.parentURL?.endsWith('/dossierGenerate.ts'))) {
      return { url: import.meta.url, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

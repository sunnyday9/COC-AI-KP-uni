import { randomUUID } from 'node:crypto'
import { addAbortSignal } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { StoryPreparationStage } from '../../../shared/types/bridge.js'
import { assertRuntimeConfig, DEPLOYMENT_MODE, MAX_UPLOAD_BYTES } from '../config.js'
import { getPostgresPool, initializePostgres } from '../db/postgres.js'
import { generateDossier, MAX_DOSSIER_SOURCE_CHARS } from '../rag/dossier/dossierGenerate.js'
import { indexStoryForRag } from '../services/indexOrchestration.js'
import { isCoherentPreparedStory, writePreparedStory, type PreparedStoryArtifacts } from '../services/preparedStoryStorage.js'
import { buildGetEmbeddingForUser } from '../services/ragService.js'
import { sourceKey } from '../services/sharedStoryCatalog.js'
import { STORY_PREPARATION_ENABLED } from '../services/sharedStoryPreparation.js'
import { getStoryObjectStore } from '../services/storyObjectStorage.js'
import { claimStoryPreparation, failStoryPreparation, publishStoryPreparation, renewStoryPreparation, reportStoryPreparation, type PreparationClaim } from '../services/storyPreparationClaims.js'
import { parseStoryContentForPreparation } from '../services/storyService.js'
import { logger } from '../utils/logging.js'

type ObjectStore = NonNullable<ReturnType<typeof getStoryObjectStore>>

async function prepare(claim: PreparationClaim, store: ObjectStore, leaseMs: number) {
  const controller = new AbortController()
  // Fences work whose provider or parser keeps running after a lease is lost.
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)])
  let heartbeatBusy = false
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || signal.aborted) return
    heartbeatBusy = true
    try {
      if (!await renewStoryPreparation(claim, leaseMs)) controller.abort()
    } catch {
      controller.abort()
    } finally {
      heartbeatBusy = false
    }
  }, Math.floor(leaseMs / 3))
  async function progress(stage: StoryPreparationStage, percent: number) {
    signal.throwIfAborted()
    if (!await reportStoryPreparation(claim, stage, percent)) {
      controller.abort()
      signal.throwIfAborted()
    }
  }

  function phaseProgress(stage: StoryPreparationStage, start: number, end: number) {
    let reported = start
    let updates = Promise.resolve()
    return {
      report({ percent }: { percent: number }) {
        signal.throwIfAborted()
        const totalPercent = start + Math.floor((end - start) * percent / 100)
        if (totalPercent < reported + 5) return
        reported = totalPercent
        updates = updates.then(() => progress(stage, totalPercent)).catch(() => controller.abort())
      },
      async flush() {
        await updates
        signal.throwIfAborted()
      },
    }
  }

  let failure: StoryPreparationStage = 'source_failed'
  try {
    const { rows: [source] } = await getPostgresPool().query<{ name: string; source_size: string; extension: string }>(`
      SELECT name, source_size, extension FROM story_catalog
      WHERE owner_id = $1 AND story_id = $2 AND source_revision = $3 AND deleted_at IS NULL
    `, [claim.owner_id, claim.story_id, claim.source_revision])
    const size = Number(source?.source_size)
    if (!source || !Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new Error('invalid source')
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    const body = await store.get(sourceKey(claim.owner_id, claim.source_revision), size, readSignal)
    addAbortSignal(readSignal, body)
    const bytes = Buffer.from(await body.transformToByteArray())
    const content = (await parseStoryContentForPreparation(source.extension, bytes, true)).trim()
    if (!content || content.length > MAX_DOSSIER_SOURCE_CHARS) throw new Error('source outside preparation limits')

    const userId = Number(claim.owner_id)
    const raw = { name: source.name, content }
    const artifacts: Partial<PreparedStoryArtifacts> = {}
    const revision = randomUUID()
    failure = 'index_failed'
    await progress('index', 20)
    const embed = await buildGetEmbeddingForUser(userId)
    const indexProgress = phaseProgress('index', 20, 50)
    const indexed = await indexStoryForRag(userId, claim.story_id, undefined, {
      source: raw,
      prefetchReranker: false,
      onProgress: indexProgress.report,
      getEmbedding: embed ? async (text) => {
        signal.throwIfAborted()
        return await embed(text)
      } : undefined,
      persistIndex: (index) => { artifacts.index = index },
    })
    await indexProgress.flush()
    if (!indexed.ok || indexed.warning || !artifacts.index?.chunkCount) throw new Error('incomplete index')

    failure = 'dossier_failed'
    await progress('dossier', 52)
    const dossierProgress = phaseProgress('dossier', 52, 87)
    const generated = await generateDossier(userId, claim.story_id, {
      source: { ...raw, preparationRevision: revision },
      onProgress: dossierProgress.report,
      persistArtifacts: (dossier, gaps) => {
        artifacts.dossier = dossier
        artifacts.gaps = gaps
      },
    })
    await dossierProgress.flush()
    if (!generated.ok || generated.degraded) throw new Error('incomplete dossier')
    failure = 'anchors_failed'
    const { index, dossier, gaps } = artifacts
    if (!dossier || !gaps) throw new Error('missing spoiler anchors')
    const complete = { sourceText: content, index, dossier, gaps }
    if (!isCoherentPreparedStory(claim.story_id, revision, complete)) throw new Error('unusable story artifacts')

    failure = 'publish_failed'
    await progress('publish', 90)
    const manifest = await writePreparedStory(store, claim.owner_id, revision, complete, signal)
    signal.throwIfAborted()
    if (!await publishStoryPreparation(claim, revision, index.indexedAt, index.chunkCount, manifest)) {
      throw new Error('publication claim is no longer current')
    }
  } catch {
    if (!controller.signal.aborted) {
      await failStoryPreparation(claim, failure).catch(() => logger.warn('story preparation failure could not be recorded'))
      logger.warn('story preparation did not complete', { jobId: claim.job_id, stage: failure })
    }
  } finally {
    clearInterval(heartbeat)
  }
}

async function runWorker() {
  assertRuntimeConfig()
  if (DEPLOYMENT_MODE !== 'shared-accounts' || !STORY_PREPARATION_ENABLED) {
    throw new Error('Story preparation worker requires shared deployment with STORY_PREPARATION_ENABLED=1')
  }
  const store = getStoryObjectStore()
  if (!store) throw new Error('Story preparation worker requires story object storage')
  const leaseMs = Number(process.env.STORY_PREPARATION_LEASE_MS ?? 30_000)
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) {
    throw new Error('STORY_PREPARATION_LEASE_MS must be an integer from 1000 to 120000')
  }

  await initializePostgres(true, true)
  let stopping = false
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  try {
    while (!stopping) {
      const claim = await claimStoryPreparation(leaseMs).catch(() => {
        logger.warn('story preparation could not claim work')
        return undefined
      })
      if (claim) await prepare(claim, store, leaseMs)
      else await delay(500)
    }
  } finally {
    await getPostgresPool().end()
  }
}

await runWorker()

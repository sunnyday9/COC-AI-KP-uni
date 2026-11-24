import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BadRequestError, CapacityError, ConflictError, NotFoundError, UpstreamError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import type { GenerateResult } from '../rag/dossier/dossierGenerate.js'
import type * as RagService from './ragService.js'

type IndexParams = Parameters<typeof RagService.index>[1]
type IndexResult = Awaited<ReturnType<typeof RagService.index>>
type StoryProgress = NonNullable<Parameters<typeof RagService.index>[2]>

export type StoryPreparationJob =
  | { kind: 'index'; userId: number; storyId: string; params: IndexParams }
  | { kind: 'dossier'; userId: number; storyId: string; model?: string; annex?: boolean }

type PreparationResult = IndexResult | GenerateResult

export type StoryPreparationMessage =
  | { type: 'progress'; progress: Parameters<StoryProgress>[0] }
  | { type: 'result'; result: PreparationResult }
  | { type: 'error'; name: string; message: string }

const activeStories = new Set<string>()
let activePreparation = 0
let activeUploads = 0

function positiveSetting(value: string | undefined, fallback: number): number {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit > 0 ? limit : fallback
}

export function acquireStoryUpload(): () => void {
  if (activeUploads >= positiveSetting(process.env.STORY_UPLOAD_CONCURRENCY, 4)) {
    throw new CapacityError('正在处理其他剧本上传，请稍后重试。')
  }
  activeUploads++
  let released = false
  return () => {
    if (released) return
    released = true
    activeUploads--
  }
}

/** One writer for a story's preparation and delete operations on this host. */
export async function withStoryMutation<T>(userId: number, storyId: string, run: () => T | Promise<T>): Promise<T> {
  const key = `${userId}:${storyId}`
  if (activeStories.has(key)) throw new ConflictError('该剧本正在处理，请稍后重试。')
  activeStories.add(key)
  try {
    return await run()
  } finally {
    activeStories.delete(key)
  }
}

export function prepareStory(
  job: Extract<StoryPreparationJob, { kind: 'index' }>, inline: () => Promise<IndexResult>, onProgress?: StoryProgress,
): Promise<IndexResult>
export function prepareStory(
  job: Extract<StoryPreparationJob, { kind: 'dossier' }>, inline: () => Promise<GenerateResult>, onProgress?: StoryProgress,
): Promise<GenerateResult>
export async function prepareStory(
  job: StoryPreparationJob, inline: () => Promise<PreparationResult>, onProgress?: StoryProgress,
): Promise<PreparationResult> {
  return withStoryMutation(job.userId, job.storyId, async () => {
    if (activePreparation >= positiveSetting(process.env.STORY_PREPARATION_CONCURRENCY, 2)) {
      throw new CapacityError('剧本处理任务已满，请稍后重试。')
    }
    activePreparation++
    try {
      if (process.env.STORY_PREPARATION_WORKERS !== '1') return await inline()
      try {
        return await prepareInWorker(job, onProgress)
      } finally {
        // A failed worker may still have completed an atomic artifact write.
        if (job.kind === 'index') {
          const { invalidateIndexCache } = await import('../rag/vectorStore.js')
          invalidateIndexCache(job.userId, job.storyId)
        } else {
          const { invalidateDossierCache } = await import('../rag/dossier/dossierCore.js')
          invalidateDossierCache(job.userId, job.storyId)
        }
      }
    } finally {
      activePreparation--
    }
  })
}

function restoreWorkerError(name: string, message: string): Error {
  switch (name) {
    case 'BadRequestError': return new BadRequestError(message)
    case 'ConflictError': return new ConflictError(message)
    case 'NotFoundError': return new NotFoundError(message)
    case 'UpstreamError': return new UpstreamError(message)
    default: return new Error(message)
  }
}

function prepareInWorker(job: StoryPreparationJob, onProgress?: StoryProgress): Promise<PreparationResult> {
  const dev = import.meta.url.endsWith('.ts')
  const script = fileURLToPath(new URL(dev ? './storyPreparationWorker.ts' : './storyPreparationWorker.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const worker = fork(script, { execArgv: dev ? ['--import', 'tsx'] : [] })
    let reply: Extract<StoryPreparationMessage, { type: 'result' | 'error' }> | undefined
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      worker.kill()
    }, positiveSetting(process.env.STORY_PREPARATION_TIMEOUT_MS, 10 * 60_000))
    timeout.unref()
    worker.on('message', (message: StoryPreparationMessage) => {
      if (message.type === 'progress') onProgress?.(message.progress)
      else reply = message
    })
    worker.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    worker.once('close', (code) => {
      clearTimeout(timeout)
      if (reply?.type === 'result' && code === 0 && !timedOut) {
        resolve(reply.result)
      } else if (reply?.type === 'error' && !timedOut) {
        reject(restoreWorkerError(reply.name, reply.message))
      } else {
        logger.warn('story preparation worker stopped', { kind: job.kind, code, timedOut })
        reject(new CapacityError('剧本处理任务中断，请稍后重试。'))
      }
    })
    worker.send(job, (error) => {
      if (error) worker.kill()
    })
  })
}

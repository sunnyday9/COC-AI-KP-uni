import type { StoryPreparationJob, StoryPreparationMessage } from './storyPreparation.js'
import { errorMessage } from '../utils/errors.js'

process.once('disconnect', () => process.exit(1))

process.once('message', async (job: StoryPreparationJob) => {
  const send = (message: StoryPreparationMessage) => process.send?.(message)
  const onProgress = (progress: Extract<StoryPreparationMessage, { type: 'progress' }>['progress']) => {
    send({ type: 'progress', progress })
  }
  let reply: StoryPreparationMessage
  try {
    if (job.kind === 'index') {
      const { index } = await import('./ragService.js')
      reply = { type: 'result', result: await index(job.userId, job.params, onProgress) }
    } else {
      const { generateDossier } = await import('../rag/dossier/dossierGenerate.js')
      reply = {
        type: 'result',
        result: await generateDossier(job.userId, job.storyId, { model: job.model, annex: job.annex, onProgress }),
      }
    }
  } catch (error) {
    reply = {
      type: 'error',
      name: error instanceof Error ? error.constructor.name : 'Error',
      message: errorMessage(error),
    }
  }
  // IPC is flushed before exit. Model runtimes can keep native handles open.
  process.send?.(reply, (error) => process.exit(error ? 1 : 0))
})

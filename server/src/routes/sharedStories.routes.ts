import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { MAX_UPLOAD_BYTES } from '../config.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { StoryPreviewTooLargeError, type createSharedStoryCatalog } from '../services/sharedStoryCatalog.js'
import { acquireStoryUpload } from '../services/storyPreparation.js'
import { BadRequestError, CapacityError, sendError } from '../utils/errors.js'
import { assertId } from '../utils/fileNames.js'
import { logger } from '../utils/logging.js'

const MAX_SHARED_STORY_TEXT_READS = 4
let activeTextReads = 0

export function createSharedStoriesRouter(catalog: ReturnType<typeof createSharedStoryCatalog>) {
  const router = Router()
  router.use(requireAuth)

  router.get('/', async (req: AuthRequest, res) => {
    try {
      const { limit, cursor } = req.query
      res.set('Cache-Control', 'private, no-store')
      res.json(limit === undefined && cursor === undefined
        ? await catalog.list(req.userId!)
        : await catalog.listPage(req.userId!, limit, cursor))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/upload', async (req: AuthRequest, res) => {
    let release: (() => void) | undefined
    let dir: string | undefined
    const signal = responseSignal(res)
    try {
      release = acquireStoryUpload()
      dir = await mkdtemp(join(tmpdir(), 'aikp-story-upload-'))
      signal.throwIfAborted()
      await spoolUpload(req, res, join(dir, 'source'), signal)
      if (signal.aborted) return
      res.json(req.file
        ? await catalog.upload(req.userId!, req.file, signal)
        : { ok: false, error: 'no file received' })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` })
        } else {
          res.status(400).json({ error: `upload rejected: ${error.code}` })
        }
        return
      }
      sendError(res, error)
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => logger.warn('story upload spool cleanup failed'))
      release?.()
    }
  })

  router.get('/:id/source', async (req: AuthRequest, res) => {
    const signal = AbortSignal.any([responseSignal(res), AbortSignal.timeout(120_000)])
    try {
      const { name, size, body } = await catalog.openSource(req.userId!, assertId(req.params.id as string, 'story id'), signal)
      res.attachment(name)
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      await pipeline(body, res, { signal })
    } catch (error) {
      if (!res.destroyed && !res.headersSent) sendError(res, error)
    }
  })

  router.get('/:id', async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'private, no-store')
    if (activeTextReads >= MAX_SHARED_STORY_TEXT_READS) {
      sendError(res, new CapacityError('正在读取其他剧本，请稍后重试。'))
      return
    }
    activeTextReads++
    const signal = responseSignal(res)
    try {
      const id = assertId(req.params.id as string, 'story id')
      res.json(await catalog.read(req.userId!, id, signal, req.query.preview === '1'))
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof StoryPreviewTooLargeError) {
        res.status(413).json({ error: error.message })
        return
      }
      sendError(res, error)
    } finally {
      // Keep the slot until parsing and the JSON response have both settled.
      if (res.destroyed || res.writableFinished) activeTextReads--
      else res.once('close', () => { activeTextReads-- })
    }
  })

  router.delete('/:id', async (req: AuthRequest, res) => {
    try {
      await catalog.delete(req.userId!, assertId(req.params.id as string, 'story id'))
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error)
    }
  })
  return router
}

function responseSignal(res: Response): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => { if (!res.writableFinished) controller.abort() })
  return controller.signal
}

async function spoolUpload(req: Request, res: Response, path: string, signal: AbortSignal): Promise<void> {
  let write: Promise<void> | undefined
  const parse = multer({
    storage: {
      _handleFile(_req, file, cb) {
        const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
        write = pipeline(file.stream, output, { signal })
        void write.then(() => cb(null, { path, size: output.bytesWritten }), cb)
      },
      // The request owns this private directory until the write has settled.
      _removeFile(_req, _file, cb) { cb(null) },
    },
    limits: { fileSize: MAX_UPLOAD_BYTES, fields: 0 },
    defParamCharset: 'utf-8',
  }).single('file')
  try {
    await new Promise<void>((resolve, reject) => {
      parse(req, res, (error?: unknown) => {
        if (!error) return resolve()
        if (error instanceof multer.MulterError || (error as NodeJS.ErrnoException).code) return reject(error)
        reject(new BadRequestError('invalid story upload'))
      })
    })
  } finally {
    // Multer may call back on a disconnected request before the write closes.
    await write?.catch(() => undefined)
  }
}

import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { NotFoundError, UpstreamError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

function configuration() {
  const Bucket = process.env.STORY_S3_BUCKET?.trim()
  const region = process.env.STORY_S3_REGION?.trim()
  const endpoint = process.env.STORY_S3_ENDPOINT?.trim()
  const pathStyle = process.env.STORY_S3_FORCE_PATH_STYLE?.trim()
  if (!Bucket && !region && !endpoint && !pathStyle) return
  const url = endpoint ? URL.parse(endpoint) : undefined
  if (!Bucket || !region || (endpoint && (
    !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
  )) || (pathStyle && !['true', 'false'].includes(pathStyle))) {
    throw new Error('Invalid story object storage configuration')
  }
  return { Bucket, region, endpoint, forcePathStyle: pathStyle === 'true' }
}

type ObjectStoreConfig = NonNullable<ReturnType<typeof configuration>>
let storage: ReturnType<typeof createObjectStore> | undefined

export function getStoryObjectStore() {
  if (storage) return storage
  const config = configuration()
  if (config) storage = createObjectStore(config)
  return storage
}

function createObjectStore({ Bucket, ...options }: ObjectStoreConfig) {
  const s3 = new S3Client({
    ...options,
    // PUT streams are consumed once. Retrying is a fresh HTTP upload.
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  return {
    async put(key: string, path: string, size: number, signal: AbortSignal): Promise<void> {
      const stream = createReadStream(path)
      try {
        await s3.send(new PutObjectCommand({
          Bucket, Key: key, ContentLength: size, ContentType: 'application/octet-stream', Body: stream,
        }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
      } catch {
        throw new UpstreamError('story object upload failed')
      } finally {
        stream.destroy()
      }
    },

    async get(key: string, size: number, signal: AbortSignal, prefixBytes?: number) {
      try {
        const Range = prefixBytes === undefined ? undefined : `bytes=0-${prefixBytes - 1}`
        const object = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range }), {
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        })
        if (!(object.Body instanceof Readable) || object.ContentLength !== (prefixBytes ?? size)) {
          if (object.Body instanceof Readable) object.Body.destroy()
          throw new Error('invalid story object response')
        }
        return object.Body
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode
        if (status === 404) throw new NotFoundError('story file missing')
        throw new UpstreamError('story object read failed')
      }
    },

    async discard(key: string): Promise<void> {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }), { abortSignal: AbortSignal.timeout(5_000) })
      } catch {
        logger.warn('story object cleanup failed')
      }
    },
  }
}

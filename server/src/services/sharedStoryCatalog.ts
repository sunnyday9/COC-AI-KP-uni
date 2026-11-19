import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getPostgresPool, postgresError } from '../db/postgres.js'
import { NotFoundError, UpstreamError } from '../utils/errors.js'
import { sanitizeFilename } from '../utils/fileNames.js'
import { STORY_EXTENSIONS, parseStoryContent } from './storyService.js'
import { parseStoryPage, formatStoryPage, type StoryPageRow } from './storyPagination.js'
import { formatPreparationStatus, latestPreparationJoin, STORY_PREPARATION_ENABLED } from './sharedStoryPreparation.js'
import type { getStoryObjectStore } from './storyObjectStorage.js'

type ObjectStore = NonNullable<ReturnType<typeof getStoryObjectStore>>

const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json'])
const STORY_PREVIEW_PREFIX_BYTES = 64 * 1024
const MAX_FORMATTED_PREVIEW_BYTES = 8 * 1024 * 1024
const STORY_PREVIEW_CHARACTERS = 16_000

export class StoryPreviewTooLargeError extends Error {
  constructor() { super('文件过大，无法在此页预览。原始文件可通过验证身份的 API 下载。') }
}

interface StoryRecord {
  story_id: string
  name: string
  source_revision: string
  source_size: string
  extension: string
}

export function sourceKey(ownerId: number | string, revision: string): string {
  return `stories/${ownerId}/sources/${revision}`
}

/**
 * Publish each attempt under an immutable source key. A separate transaction
 * makes it possible to distinguish a failed INSERT (safe to discard) from an
 * uncertain COMMIT (retain the source because a gateway may already see it).
 */
async function publishStory(
  ownerId: number,
  filename: string,
  extension: string,
  revision: string,
  size: number,
  signal: AbortSignal,
  beforeCommit: () => void,
): Promise<string> {
  const client = await getPostgresPool().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    const created = Date.now()
    const insert = async (id: string) => client.query(`
      INSERT INTO story_catalog (owner_id, story_id, name, source_revision, source_size, extension, created_at)
      VALUES ($1, $2, $2, $3, $4, $5, $6) ON CONFLICT (owner_id, story_id) DO NOTHING
    `, [ownerId, id, revision, size, extension, created])
    let id = filename
    if (!(await insert(id)).rowCount) {
      const suffix = `-${revision}${extension}`
      id = filename.slice(0, -extension.length).slice(0, 120 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix
      if (!(await insert(id)).rowCount) throw new Error('could not assign a story ID')
    }
    signal.throwIfAborted()
    beforeCommit()
    const commit = await client.query('COMMIT')
    if (commit.command !== 'COMMIT') throw new Error('story catalog commit did not complete')
    return id
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discard = true
    }
    throw error
  } finally {
    client.release(discard)
  }
}

export function createSharedStoryCatalog(storage: ObjectStore) {
  async function findStory(ownerId: number, storyId: string): Promise<StoryRecord> {
    const result = await getPostgresPool().query<StoryRecord>(`
      SELECT story_id, name, source_revision, source_size, extension
      FROM story_catalog WHERE owner_id = $1 AND story_id = $2 AND deleted_at IS NULL
    `, [ownerId, storyId]).catch((error) => { throw postgresError(error) })
    if (!result.rows[0]) throw new NotFoundError('story not found')
    return result.rows[0]
  }

  async function openSource(ownerId: number, storyId: string, signal: AbortSignal) {
    const story = await findStory(ownerId, storyId)
    const body = await storage.get(sourceKey(ownerId, story.source_revision), Number(story.source_size), signal)
    return { name: story.name, ext: story.extension, size: story.source_size, body }
  }

  return {
    async upload(ownerId: number, file: { originalname: string; path: string; size: number }, signal: AbortSignal) {
      let filename: string
      try {
        filename = sanitizeFilename(file.originalname, 'story')
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'invalid filename' }
      }
      const extension = path.extname(filename).toLowerCase()
      if (!STORY_EXTENSIONS.includes(extension)) return { ok: false, error: `unsupported file type: ${extension || '(none)'}` }

      const revision = randomUUID()
      const key = sourceKey(ownerId, revision)
      let commitStarted = false
      try {
        await storage.put(key, file.path, file.size, signal)
        const id = await publishStory(ownerId, filename, extension, revision, file.size, signal, () => { commitStarted = true })
        return { ok: true, name: id, id }
      } catch (error) {
        if (!commitStarted) await storage.discard(key)
        if (error instanceof UpstreamError) throw error
        throw postgresError(error)
      }
    },

    async list(ownerId: number) {
      const result = await getPostgresPool().query<Pick<StoryRecord, 'story_id' | 'name'>>(`
        SELECT story_id, name FROM story_catalog WHERE owner_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, story_id DESC
      `, [ownerId]).catch((error) => { throw postgresError(error) })
      return result.rows.map(({ story_id, name }) => ({ id: story_id, name }))
    },

    async listPage(ownerId: number, rawLimit: unknown, rawCursor: unknown) {
      const { limit, cursor } = parseStoryPage(rawLimit, rawCursor)
      const prepare = STORY_PREPARATION_ENABLED
      const result = await getPostgresPool().query<StoryPageRow & Parameters<typeof formatPreparationStatus>[0]>(`
        SELECT catalog.story_id, catalog.name, catalog.created_at
          ${prepare ? ', catalog.active_preparation_revision, preparation.*' : ''}
        FROM story_catalog catalog ${prepare ? latestPreparationJoin : ''}
        WHERE catalog.owner_id = $1 AND catalog.deleted_at IS NULL
        ${cursor ? 'AND (catalog.created_at, catalog.story_id) < ($3, $4)' : ''}
        ORDER BY catalog.created_at DESC, catalog.story_id DESC LIMIT $2
      `, cursor ? [ownerId, limit + 1, ...cursor] : [ownerId, limit + 1]).catch((error) => { throw postgresError(error) })
      const page = formatStoryPage(result.rows, limit)
      if (!prepare) return { ...page, canPrepare: false }
      return {
        ...page,
        canPrepare: true,
        preparationMode: 'durable',
        stories: page.stories.map((story, index) => ({ ...story, preparation: formatPreparationStatus(result.rows[index]!) })),
      }
    },

    openSource,

    async read(ownerId: number, storyId: string, signal: AbortSignal, preview: boolean) {
      const story = await findStory(ownerId, storyId)
      const size = Number(story.source_size)
      const plainText = PLAIN_TEXT_EXTENSIONS.has(story.extension)
      if (preview && !plainText && size > MAX_FORMATTED_PREVIEW_BYTES) {
        throw new StoryPreviewTooLargeError()
      }
      const prefix = preview && plainText && size > STORY_PREVIEW_PREFIX_BYTES ? STORY_PREVIEW_PREFIX_BYTES : undefined
      const body = await storage.get(sourceKey(ownerId, story.source_revision), size, signal, prefix)
      let bytes: Uint8Array
      try {
        bytes = await body.transformToByteArray()
      } catch {
        throw new UpstreamError('story object read failed')
      }
      const content = await parseStoryContent(story.extension, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      const name = story.name
      if (!preview) return { name, content }
      return {
        name,
        content: content.slice(0, STORY_PREVIEW_CHARACTERS).replace(/[\uD800-\uDBFF]$/, ''),
        truncated: prefix !== undefined || content.length > STORY_PREVIEW_CHARACTERS,
      }
    },

    async delete(ownerId: number, storyId: string) {
      const result = await getPostgresPool().query(`
        UPDATE story_catalog SET deleted_at = $3 WHERE owner_id = $1 AND story_id = $2 AND deleted_at IS NULL
      `, [ownerId, storyId, Date.now()]).catch((error) => { throw postgresError(error) })
      if (!result.rowCount) throw new NotFoundError('story not found')
    },
  }
}

import { createHash } from 'node:crypto'
import { addAbortSignal } from 'node:stream'
import type { IndexedStory } from '../../../shared/types/bridge.js'
import { getPostgresPool, postgresError } from '../db/postgres.js'
import { isCurrentGapsVersion, type CoverageGapsFile } from '../rag/dossier/coverageGaps.js'
import { getSpoilerMetadataFailureReason } from '../rag/supplementAssembly.js'
import type { StoryDossier } from '../rag/dossier/schema.js'
import type { StoredIndex } from '../rag/vectorStore.js'
import { NotFoundError, UpstreamError } from '../utils/errors.js'
import { getStoryObjectStore } from './storyObjectStorage.js'
import { encodeStoryCursor, parseStoryPage } from './storyPagination.js'

const MAX_OBJECT_BYTES = 32 * 1024 * 1024
const ARTIFACTS = ['sourceText', 'index', 'dossier', 'gaps'] as const

type Artifact = typeof ARTIFACTS[number]
type ObjectStore = NonNullable<ReturnType<typeof getStoryObjectStore>>

export interface PreparedStoryArtifacts {
  sourceText: string
  index: StoredIndex
  dossier: StoryDossier
  gaps: CoverageGapsFile
}

export type PreparedStoryManifest = Record<Artifact, { size: number; sha256: string }>

interface PreparedRevision {
  revision: string
  source_revision: string
  prepared_at: string
  chunk_count: number
  objects: PreparedStoryManifest
}

function artifactKey(ownerId: string | number, revision: string, artifact: Artifact): string {
  return `stories/${ownerId}/prepared/${revision}/${artifact}`
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function writePreparedStory(
  store: ObjectStore,
  ownerId: string,
  revision: string,
  artifacts: PreparedStoryArtifacts,
  signal: AbortSignal,
): Promise<PreparedStoryManifest> {
  const manifest = {} as PreparedStoryManifest
  for (const artifact of ARTIFACTS) {
    const payload = artifacts[artifact]
    const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
    if (bytes.length > MAX_OBJECT_BYTES) throw new Error('prepared story object exceeds size limit')
    const metadata = { size: bytes.length, sha256: digest(bytes) }
    await store.putArtifact(artifactKey(ownerId, revision, artifact), bytes, metadata.sha256, signal)
    manifest[artifact] = metadata
  }
  return manifest
}

export function isCoherentPreparedStory(storyId: string, revision: string, { sourceText, index, dossier, gaps }: PreparedStoryArtifacts): boolean {
  return index?.scriptId === storyId
    && Array.isArray(index.docs) && index.docs.length > 0 && index.chunkCount === index.docs.length
    && index.docs.every((doc) => {
      const start = doc?.metadata?.start
      return typeof start === 'number' && Number.isSafeInteger(start) && start >= 0
        && doc.metadata.storyId === storyId && typeof doc.content === 'string' && doc.content.length > 0
        && sourceText.slice(start, start + doc.content.length) === doc.content
    })
    && dossier?.scriptId === storyId && dossier.sourceRevision === revision && dossier.quality?.degraded === false
    && gaps?.scriptId === storyId && gaps.sourceRevision === revision && gaps.storyChars === sourceText.length
    && isCurrentGapsVersion(gaps) && getSpoilerMetadataFailureReason(gaps, dossier) === null
}

/** Load the complete active revision for an authorized story owner. Artifact contents are server-only. */
export async function loadActivePreparedStory(ownerId: number, storyId: string, signal: AbortSignal) {
  const { rows: [prepared] } = await getPostgresPool().query<PreparedRevision>(`
    SELECT prepared.revision, prepared.source_revision, prepared.prepared_at, prepared.chunk_count, prepared.objects
    FROM story_catalog catalog
    JOIN story_preparation_revisions prepared ON prepared.revision = catalog.active_preparation_revision
      AND prepared.owner_id = catalog.owner_id AND prepared.story_id = catalog.story_id
      AND prepared.source_revision = catalog.source_revision
    WHERE catalog.owner_id = $1 AND catalog.story_id = $2 AND catalog.deleted_at IS NULL
  `, [ownerId, storyId]).catch((error) => { throw postgresError(error) })
  if (!prepared) throw new NotFoundError('prepared story not found')
  const store = getStoryObjectStore()
  if (!store) throw new UpstreamError('prepared story storage unavailable')
  const load = async (artifact: Artifact) => {
    const metadata = prepared.objects?.[artifact]
    if (!metadata || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_OBJECT_BYTES) {
      throw new UpstreamError('invalid prepared story manifest')
    }
    const key = artifactKey(ownerId, prepared.revision, artifact)
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    try {
      const body = await store.get(key, metadata.size, readSignal)
      addAbortSignal(readSignal, body)
      const bytes = Buffer.from(await body.transformToByteArray())
      if (digest(bytes) !== metadata.sha256) throw new Error('artifact hash mismatch')
      return bytes.toString('utf8')
    } catch {
      throw new UpstreamError('prepared story object read failed')
    }
  }
  const [sourceText, indexJson, dossierJson, gapsJson] = await Promise.all([
    load('sourceText'), load('index'), load('dossier'), load('gaps'),
  ])
  try {
    const artifacts: PreparedStoryArtifacts = {
      sourceText,
      index: JSON.parse(indexJson),
      dossier: JSON.parse(dossierJson),
      gaps: JSON.parse(gapsJson),
    }
    if (artifacts.index?.indexedAt === Number(prepared.prepared_at) &&
      artifacts.index.chunkCount === prepared.chunk_count &&
      isCoherentPreparedStory(storyId, prepared.revision, artifacts)) {
      return { revision: prepared.revision, sourceRevision: prepared.source_revision, ...artifacts }
    }
  } catch {
    // A corrupt payload is unavailable to the investigation start gate.
  }
  throw new UpstreamError('prepared story objects are inconsistent')
}

export async function listPreparedStories(ownerId: number, rawLimit: unknown, rawCursor: unknown) {
  const unpaged = rawLimit === undefined && rawCursor === undefined
  const { limit, cursor } = parseStoryPage(rawLimit, rawCursor)
  const values = unpaged ? [ownerId] : cursor ? [ownerId, limit + 1, ...cursor] : [ownerId, limit + 1]
  const { rows } = await getPostgresPool().query<Omit<IndexedStory, 'indexedAt'> & { indexedAt: string }>(`
    SELECT catalog.story_id AS "storyId", catalog.name, prepared.chunk_count AS "chunkCount",
      catalog.active_prepared_at AS "indexedAt"
    FROM story_catalog catalog
    JOIN story_preparation_revisions prepared ON prepared.revision = catalog.active_preparation_revision
      AND prepared.owner_id = catalog.owner_id AND prepared.story_id = catalog.story_id
      AND prepared.source_revision = catalog.source_revision
    WHERE catalog.owner_id = $1 AND catalog.deleted_at IS NULL AND catalog.active_preparation_revision IS NOT NULL
    ${cursor ? 'AND (catalog.active_prepared_at, catalog.story_id) < ($3, $4)' : ''}
    ORDER BY catalog.active_prepared_at DESC, catalog.story_id DESC ${unpaged ? '' : 'LIMIT $2'}
  `, values).catch((error) => { throw postgresError(error) })
  const stories = rows.map((row) => ({ ...row, indexedAt: Number(row.indexedAt) }))
  if (unpaged) return stories
  const last = stories[limit - 1]
  return {
    stories: stories.slice(0, limit),
    canStartInvestigation: false,
    nextCursor: stories.length > limit && last ? encodeStoryCursor(last.indexedAt, last.storyId) : null,
  }
}

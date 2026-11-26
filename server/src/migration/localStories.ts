import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DOSSIER_DATA_DIR, MAX_UPLOAD_BYTES, RAG_DATA_DIR, UPLOADS_DIR } from '../config.js'
import type { CoverageGapsFile } from '../rag/dossier/coverageGaps.js'
import { DOSSIER_MIN_COVERAGE_PCT, type StoryDossier } from '../rag/dossier/schema.js'
import type { StoredIndex } from '../rag/vectorStore.js'
import { encodePreparedStory, isCoherentPreparedStory } from '../services/preparedStoryStorage.js'
import { sourceKey } from '../services/sharedStoryCatalog.js'
import { scanStoryArtifacts, type ArtifactKind } from '../services/storyArtifacts.js'
import { parseStoryContentForPreparation, STORY_EXTENSIONS } from '../services/storyService.js'
import { assertStoredFilePath, isInternalUuidFileName } from '../utils/fileNames.js'
import { assertPathInDir, assertSafeId } from '../utils/pathSafety.js'

interface LocalStory {
  user_id: number
  story_id: string
  name: string
  file_path: string
  created_at: number
}

export interface MigrationObject {
  key: string
  file: string
  size: number
  sha256: string
}

const kinds = ['index', 'dossier', 'gaps', 'annex'] as const
const maxArtifactBytes = 32 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Stable UUID-shaped identifiers in a namespace specific to this import. */
function migrationId(...parts: unknown[]): string {
  const hash = sha256(JSON.stringify(['sqlite-migration-v1', ...parts]))
  return [hash.slice(0, 8), hash.slice(8, 12), '8' + hash.slice(13, 16),
    '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-')
}

function readBytes(file: string, limit: number): Buffer {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > limit) throw new Error('Source or artifact exceeds its supported size or is not a regular file')
  return fs.readFileSync(file)
}

function extension(file: string): string {
  return path.extname(file).toLowerCase()
}

function ownerOriginals(ownerId: number): string {
  return assertPathInDir(UPLOADS_DIR, path.join(UPLOADS_DIR, String(ownerId), 'stories'), 'original directory')
}

function originalRows(db: DatabaseSync, ownerIds: number[]): LocalStory[] {
  const rows = db.prepare('SELECT user_id, story_id, name, file_path, created_at FROM stories ORDER BY user_id, story_id')
    .all() as unknown as LocalStory[]
  const claims = new Set(rows.map(row => JSON.stringify([row.user_id, row.story_id])))
  for (const user_id of ownerIds) {
    const directory = ownerOriginals(user_id)
    if (!fs.existsSync(directory)) continue
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      if ((!file.isFile() && !file.isSymbolicLink()) || !STORY_EXTENSIONS.includes(extension(file.name))
        || isInternalUuidFileName(file.name) || claims.has(JSON.stringify([user_id, file.name]))) continue
      const file_path = assertSafeId(file.name, 'legacy story filename')
      const { mtimeMs } = fs.statSync(assertPathInDir(directory, path.join(directory, file_path), 'legacy original'))
      rows.push({ user_id, story_id: file_path, name: file_path, file_path, created_at: Math.trunc(mtimeMs) })
    }
  }
  return rows.sort((left, right) => left.user_id - right.user_id
    || Buffer.compare(Buffer.from(left.story_id), Buffer.from(right.story_id)))
}

function localArtifacts(db: DatabaseSync, ownerId: number, storyId: string, kind: ArtifactKind): Buffer | undefined {
  const root = kind === 'index' ? RAG_DATA_DIR : DOSSIER_DATA_DIR
  const directory = assertPathInDir(root, kind === 'index'
    ? path.join(root, String(ownerId), 'rag_index') : path.join(root, String(ownerId)), 'artifact directory')
  const location = db.prepare('SELECT file_name FROM story_artifact_locations WHERE user_id = ? AND story_id = ? AND kind = ?')
    .get(ownerId, storyId, kind) as { file_name: string } | undefined
  if (location) {
    const registered = assertPathInDir(directory, path.join(directory, assertSafeId(location.file_name, 'artifact filename')), 'registered artifact')
    if (fs.existsSync(registered)) return readBytes(registered, maxArtifactBytes)
  }
  const files = scanStoryArtifacts(kind, directory, storyId)
  if (files.length > 1) throw new Error(`Ambiguous ${kind} artifacts in a source story`)
  return files[0] === undefined ? undefined : readBytes(files[0], maxArtifactBytes)
}

function decodeArtifact<T extends { scriptId: string }>(bytes: Buffer | undefined, scriptId: string): T | undefined {
  if (!bytes) return
  let value: T | null
  try { value = JSON.parse(bytes.toString('utf8')) as T | null }
  catch { throw new Error('A registered story artifact is not valid JSON') }
  if (value?.scriptId !== scriptId) throw new Error('Registered artifact belongs to a different story')
  return value
}

export async function planStories(db: DatabaseSync, owners: number[], staging: string) {
  const ownerSet = new Set(owners)
  const catalog = []
  const jobs = []
  const revisions = []
  const objects: MigrationObject[] = []
  const stageObject = (key: string, bytes: Buffer, hash = sha256(bytes)) => {
    const file = path.join(staging, hash)
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
    objects.push({ key, file, size: bytes.length, sha256: hash })
  }
  const pins = new Map<string, { preparationRevision: string; sourceRevision: string }>()
  const unprepared = []
  for (const { user_id: ownerId, story_id: storyId, name, file_path, created_at } of originalRows(db, owners)) {
    if (!ownerSet.has(ownerId)) throw new Error('Story owner is missing from source accounts')
    assertSafeId(storyId, 'story ID')
    const storedName = !file_path || file_path === storyId
      ? assertSafeId(storyId, 'legacy filename') : assertStoredFilePath(file_path, 'story')
    const directory = ownerOriginals(ownerId)
    const ext = extension(storedName)
    if (!STORY_EXTENSIONS.includes(ext)) throw new Error('Unsupported story file extension')
    const original = readBytes(assertPathInDir(directory, path.join(directory, storedName), 'story original'), MAX_UPLOAD_BYTES)
    const sourceRevision = migrationId('source', ownerId, storyId, sha256(original))
    stageObject(sourceKey(ownerId, sourceRevision), original)

    const local = Object.fromEntries(kinds.map(kind => [kind, localArtifacts(db, ownerId, storyId, kind)]))
    const localHashes = []
    for (const kind of kinds) {
      const bytes = local[kind]
      if (!bytes) continue
      const hash = sha256(bytes)
      localHashes.push([kind, hash])
      stageObject(`stories/${ownerId}/sqlite-archive/${sourceRevision}/${kind}-${hash}`, bytes, hash)
    }
    decodeArtifact(local.annex, storyId)
    const index = decodeArtifact<StoredIndex>(local.index, storyId)
    const dossier = decodeArtifact<StoryDossier>(local.dossier, storyId)
    const gaps = decodeArtifact<CoverageGapsFile>(local.gaps, storyId)
    const scope = JSON.stringify([ownerId, storyId])
    let preparationRevision: string | null = null
    let preparedAt: number | null = null
    if (index && dossier && gaps && dossier.sourceRevision === gaps.sourceRevision) {
      const sourceText = (await parseStoryContentForPreparation(ext, original, true, AbortSignal.timeout(120_000))).trim()
      const localRevision = dossier.sourceRevision
      const revision = localRevision && uuid.test(localRevision)
        ? localRevision : migrationId('prepared', ownerId, storyId, sourceRevision, localHashes)
      // Early dossiers inferred quality from the same persisted gap data used by the local gate.
      const coverage = Math.round((100 - gaps.gapPct) * 10) / 10
      const quality = dossier.quality ?? {
        coveragePct: coverage, degraded: gaps.storyChars > 5_000 && coverage < DOSSIER_MIN_COVERAGE_PCT, at: dossier.generatedAt,
      }
      const artifacts = {
        sourceText, index, dossier: { ...dossier, truths: dossier.truths ?? [], quality, sourceRevision: revision },
        gaps: { ...gaps, sourceRevision: revision },
      }
      if (isCoherentPreparedStory(storyId, revision, artifacts)) {
        const preparedObjects = encodePreparedStory(String(ownerId), revision, artifacts)
        const manifest = Object.fromEntries(preparedObjects.map(entry => [entry.artifact, {
          size: entry.bytes.length, sha256: entry.sha256,
        }]))
        for (const entry of preparedObjects) stageObject(entry.key, entry.bytes, entry.sha256)
        const jobId = migrationId('job', ownerId, storyId, revision)
        preparationRevision = revision
        preparedAt = index.indexedAt
        pins.set(scope, { preparationRevision: revision, sourceRevision })
        jobs.push({
          job_id: jobId, owner_id: ownerId, story_id: storyId, source_revision: sourceRevision, state: 'complete',
          stage: 'complete', percent: 100, attempt: 0, lease_expires_at: null, operation_id: null, retry_of_job_id: null,
        })
        revisions.push({
          revision, job_id: jobId, owner_id: ownerId, story_id: storyId, source_revision: sourceRevision,
          prepared_at: preparedAt, chunk_count: index.chunkCount, objects: manifest,
        })
      }
    }
    if (!preparationRevision) unprepared.push({ ownerId, storyId, archivedArtifacts: localHashes.length })
    catalog.push({
      owner_id: ownerId, story_id: storyId, name, source_revision: sourceRevision, source_size: original.length,
      extension: ext, created_at, deleted_at: null, active_preparation_revision: preparationRevision, active_prepared_at: preparedAt,
    })
  }
  return { catalog, jobs, revisions, objects, pins, unprepared }
}

import { getPostgresPool } from '../db/postgres.js'
import { encodePreparedStory, preparedStoryObjectKeys, type PreparedStoryArtifacts, type PreparedStoryManifest } from './preparedStoryStorage.js'
import { ARTIFACT_REQUEST_TIMEOUT_MS, type getStoryObjectStore } from './storyObjectStorage.js'
import { CURRENT_CLAIM, type PreparationClaim } from './storyPreparationClaims.js'
import { logger } from '../utils/logging.js'

type ObjectStore = NonNullable<ReturnType<typeof getStoryObjectStore>>

// Leave time for the store to finish an unacknowledged PUT after its request times out.
const UNCONFIRMED_WRITE_GRACE_MS = ARTIFACT_REQUEST_TIMEOUT_MS + 30_000

export async function writePreparedStory(
  store: ObjectStore,
  claim: PreparationClaim,
  revision: string,
  artifacts: PreparedStoryArtifacts,
  signal: AbortSignal,
): Promise<PreparedStoryManifest> {
  const encoded = encodePreparedStory(claim.owner_id, revision, artifacts)
  const db = getPostgresPool()
  const claimId = [claim.job_id, claim.attempt] as const
  signal.throwIfAborted()
  const upload = await db.query(`
    INSERT INTO story_preparation_uploads (revision, job_id, attempt)
    SELECT $3, job_id, attempt FROM story_preparation_jobs WHERE ${CURRENT_CLAIM}
  `, [...claimId, revision])
  if (!upload.rowCount) throw new Error('upload claim is no longer current')

  const manifest = {} as PreparedStoryManifest
  for (const { artifact, key, bytes, sha256 } of encoded) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(ARTIFACT_REQUEST_TIMEOUT_MS)])
    requestSignal.throwIfAborted()
    const write = await db.query(`
      UPDATE story_preparation_uploads SET cleanup_after = clock_timestamp() + $4 * interval '1 millisecond'
      WHERE revision = $3 AND NOT discarded
        AND EXISTS (SELECT 1 FROM story_preparation_jobs WHERE ${CURRENT_CLAIM})
    `, [...claimId, revision, UNCONFIRMED_WRITE_GRACE_MS])
    if (!write.rowCount) throw new Error('upload claim is no longer current')
    requestSignal.throwIfAborted()
    await store.putArtifact(key, bytes, sha256, requestSignal, async () => {
      // The PUT completed even if the subsequent HEAD cannot verify the object.
      await db.query(`
        UPDATE story_preparation_uploads SET cleanup_after = clock_timestamp()
        WHERE revision = $1 AND NOT discarded
      `, [revision])
    })
    manifest[artifact] = { size: bytes.length, sha256 }
  }
  return manifest
}

export async function reconcileStoryPreparationUploads(store: ObjectStore): Promise<void> {
  const db = getPostgresPool()
  // Reserve a small batch. A healthy claim can publish while older attempts are cleaned.
  // The discard marker and publication take the same row lock before making their decision.
  const { rows } = await db.query<{ revision: string; owner_id: string }>(`
    WITH eligible AS (
      SELECT upload.revision, job.owner_id
      FROM story_preparation_uploads upload
      JOIN story_preparation_jobs job ON job.job_id = upload.job_id
      WHERE upload.cleanup_after <= statement_timestamp()
        AND (upload.discarded OR job.attempt <> upload.attempt OR job.state <> 'running'
          OR job.lease_expires_at IS NULL OR job.lease_expires_at <= statement_timestamp()
          OR job.deadline_at <= statement_timestamp())
        AND NOT EXISTS (SELECT 1 FROM story_preparation_revisions published WHERE published.revision = upload.revision)
      ORDER BY upload.cleanup_after, upload.revision
      LIMIT 4 FOR UPDATE OF upload, job SKIP LOCKED
    )
    UPDATE story_preparation_uploads upload
    SET discarded = TRUE, cleanup_after = clock_timestamp() + interval '30 seconds'
    FROM eligible WHERE upload.revision = eligible.revision
    RETURNING upload.revision, eligible.owner_id
  `)

  await Promise.all(rows.map(async ({ revision, owner_id }) => {
    const results = await Promise.allSettled(preparedStoryObjectKeys(owner_id, revision).map((key) => store.remove(key)))
    if (results.some((result) => result.status === 'rejected')) {
      logger.warn('unpublished story preparation cleanup failed')
      return
    }
    await db.query('DELETE FROM story_preparation_uploads WHERE revision = $1 AND discarded', [revision])
  }))
}

import type { StoryPreparationStage } from '../../../shared/types/bridge.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import type { PreparedStoryManifest } from './preparedStoryStorage.js'

export interface PreparationClaim {
  job_id: string
  owner_id: string
  story_id: string
  source_revision: string
  attempt: string
}

export async function claimStoryPreparation(leaseMs: number): Promise<PreparationClaim | undefined> {
  const { rows: [claim] } = await getPostgresPool().query<PreparationClaim>(`
    WITH candidate AS (
      SELECT sequence FROM story_preparation_jobs
      WHERE state IN ('queued', 'running')
        AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
      ORDER BY lease_expires_at NULLS LAST, sequence
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE story_preparation_jobs job SET state = 'running', stage = 'read', percent = 5,
      status_version = nextval('story_preparation_status_version'),
      attempt = attempt + 1, lease_expires_at = clock_timestamp() + $1 * interval '1 millisecond'
    FROM candidate WHERE job.sequence = candidate.sequence
    RETURNING job_id, owner_id, story_id, source_revision, attempt
  `, [leaseMs]).catch((error) => { throw postgresError(error) })
  return claim
}

const CURRENT_CLAIM = `job_id = $1 AND attempt = $2 AND state = 'running' AND lease_expires_at > clock_timestamp()`

export async function renewStoryPreparation(claim: PreparationClaim, leaseMs: number): Promise<boolean> {
  const result = await getPostgresPool().query(`
    UPDATE story_preparation_jobs SET lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond'
    WHERE ${CURRENT_CLAIM}
  `, [claim.job_id, claim.attempt, leaseMs])
  return !!result.rowCount
}

export async function reportStoryPreparation(claim: PreparationClaim, stage: StoryPreparationStage, percent: number): Promise<boolean> {
  const result = await getPostgresPool().query(`
    UPDATE story_preparation_jobs SET stage = $3, percent = $4,
      status_version = nextval('story_preparation_status_version') WHERE ${CURRENT_CLAIM}
  `, [claim.job_id, claim.attempt, stage, percent])
  return !!result.rowCount
}

export async function failStoryPreparation(claim: PreparationClaim, stage: StoryPreparationStage): Promise<void> {
  await getPostgresPool().query(`
    UPDATE story_preparation_jobs SET state = 'failed', stage = $3, lease_expires_at = NULL,
      status_version = nextval('story_preparation_status_version')
    WHERE ${CURRENT_CLAIM}
  `, [claim.job_id, claim.attempt, stage])
}

export async function publishStoryPreparation(
  claim: PreparationClaim,
  revision: string,
  indexedAt: number,
  chunkCount: number,
  objects: PreparedStoryManifest,
): Promise<boolean> {
  return await inPostgresTransaction(async (client) => {
    const { rowCount: story } = await client.query(`
      SELECT 1 FROM story_catalog
      WHERE owner_id = $1 AND story_id = $2 AND source_revision = $3 AND deleted_at IS NULL
      FOR UPDATE
    `, [claim.owner_id, claim.story_id, claim.source_revision])
    if (!story) return false

    const completed = await client.query(`
      UPDATE story_preparation_jobs SET state = 'complete', stage = 'complete', percent = 100, lease_expires_at = NULL,
        status_version = nextval('story_preparation_status_version')
      WHERE ${CURRENT_CLAIM}
    `, [claim.job_id, claim.attempt])
    if (!completed.rowCount) return false

    await client.query(`
      INSERT INTO story_preparation_revisions (revision, job_id, owner_id, story_id, source_revision, prepared_at, chunk_count, objects)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [revision, claim.job_id, claim.owner_id, claim.story_id, claim.source_revision, indexedAt, chunkCount, objects])
    await client.query(`
      UPDATE story_catalog SET active_preparation_revision = $3, active_prepared_at = $4
      WHERE owner_id = $1 AND story_id = $2
    `, [claim.owner_id, claim.story_id, revision, indexedAt])
    return true
  })
}

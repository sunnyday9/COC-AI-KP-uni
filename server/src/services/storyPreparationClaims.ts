import type { StoryPreparationStage } from '../../../shared/types/bridge.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { expireStoryPreparationJobs } from './sharedPreparationLimits.js'
import type { PreparedStoryManifest } from './preparedStoryStorage.js'

export interface PreparationClaim {
  job_id: string
  owner_id: string
  story_id: string
  source_revision: string
  attempt: string
  remaining_ms: number
}

export async function claimStoryPreparation(leaseMs: number): Promise<PreparationClaim | undefined> {
  return inPostgresTransaction(async (client) => {
    // Both enqueue order and the owner's last grant use the same clock of queue events.
    // An owner goes behind already-waiting accounts without yielding to future arrivals.
    await client.query('SELECT pg_advisory_xact_lock(17407, 1117)')
    await expireStoryPreparationJobs(client)
    const { rows: [claim] } = await client.query<PreparationClaim>(`
      WITH candidate AS (
        SELECT job.sequence FROM story_preparation_jobs job
        LEFT JOIN story_preparation_dispatch dispatch ON dispatch.owner_id = job.owner_id
        JOIN story_catalog catalog ON catalog.owner_id = job.owner_id AND catalog.story_id = job.story_id
          AND catalog.source_revision = job.source_revision AND catalog.deleted_at IS NULL
        WHERE job.state IN ('queued', 'running') AND job.attempt < job.attempt_limit
          AND job.deadline_at > statement_timestamp()
          AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= statement_timestamp())
        ORDER BY GREATEST(job.sequence, dispatch.last_claim), job.sequence
        LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      )
      UPDATE story_preparation_jobs job SET state = 'running', stage = 'read', percent = 5,
        status_version = nextval('story_preparation_status_version'),
        attempt = attempt + 1, lease_expires_at = LEAST(deadline_at, clock_timestamp() + $1 * interval '1 millisecond')
      FROM candidate WHERE job.sequence = candidate.sequence
      RETURNING job_id, owner_id, story_id, source_revision, attempt,
        GREATEST(0, floor(extract(epoch FROM deadline_at - clock_timestamp()) * 1000))::integer AS remaining_ms
    `, [leaseMs])
    if (claim) await client.query(`
      INSERT INTO story_preparation_dispatch (owner_id, last_claim)
      VALUES ($1, nextval(pg_get_serial_sequence('story_preparation_jobs', 'sequence')::regclass))
      ON CONFLICT (owner_id) DO UPDATE SET last_claim = EXCLUDED.last_claim
    `, [claim.owner_id])
    return claim
  }).catch((error) => { throw postgresError(error) })
}

const CURRENT_CLAIM = `job_id = $1 AND attempt = $2 AND state = 'running' AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()`

export async function renewStoryPreparation(claim: PreparationClaim, leaseMs: number): Promise<boolean> {
  const result = await getPostgresPool().query(`
    UPDATE story_preparation_jobs SET lease_expires_at = LEAST(deadline_at, clock_timestamp() + $3 * interval '1 millisecond')
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

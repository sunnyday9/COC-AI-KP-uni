import type { Pool, PoolClient } from 'pg'

function setting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

export function sharedPreparationLimits() {
  const global = setting('STORY_PREPARATION_PENDING_GLOBAL', 128, 2, 2_048)
  const perAccount = setting('STORY_PREPARATION_PENDING_PER_ACCOUNT', Math.min(4, global - 1), 1, global - 1)
  return {
    global, perAccount,
    deadlineMs: setting('STORY_PREPARATION_DEADLINE_MS', 1_800_000, 1_000, 7_200_000),
    attemptLimit: setting('STORY_PREPARATION_MAX_ATTEMPTS', 3, 1, 10),
  }
}

/** Reap finite jobs even when no worker is available. Callers may target one private story. */
export async function expireStoryPreparationJobs(db: Pool | PoolClient, story?: { ownerId: number; storyId: string }) {
  await db.query(`
    WITH expired AS (
      SELECT job.job_id, CASE
        WHEN catalog.deleted_at IS NOT NULL OR catalog.source_revision <> job.source_revision THEN 'cancelled'
        WHEN job.deadline_at <= statement_timestamp() THEN 'timed_out'
        ELSE 'retry_exhausted'
      END AS stage
      FROM story_preparation_jobs job
      JOIN story_catalog catalog ON catalog.owner_id = job.owner_id AND catalog.story_id = job.story_id
      WHERE job.state IN ('queued', 'running')
        ${story ? 'AND job.owner_id = $1 AND job.story_id = $2' : ''}
        AND (catalog.deleted_at IS NOT NULL OR catalog.source_revision <> job.source_revision
          OR job.deadline_at <= statement_timestamp()
          OR (job.state = 'running' AND job.attempt >= job.attempt_limit AND job.lease_expires_at <= statement_timestamp()))
      ORDER BY job.deadline_at, job.sequence
      LIMIT 256 FOR UPDATE OF job SKIP LOCKED
    )
    UPDATE story_preparation_jobs job SET
      state = CASE WHEN expired.stage = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      stage = expired.stage,
      lease_expires_at = NULL, status_version = nextval('story_preparation_status_version')
    FROM expired WHERE job.job_id = expired.job_id
  `, story ? [story.ownerId, story.storyId] : [])
}

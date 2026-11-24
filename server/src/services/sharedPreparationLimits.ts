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
      SELECT job_id FROM story_preparation_jobs
      WHERE state IN ('queued', 'running')
        ${story ? 'AND owner_id = $1 AND story_id = $2' : ''}
        AND (deadline_at <= statement_timestamp()
          OR (state = 'running' AND attempt >= attempt_limit AND lease_expires_at <= statement_timestamp()))
      ORDER BY deadline_at, sequence
      LIMIT 256 FOR UPDATE SKIP LOCKED
    )
    UPDATE story_preparation_jobs job SET state = 'failed',
      stage = CASE WHEN deadline_at <= clock_timestamp() THEN 'timed_out' ELSE 'retry_exhausted' END,
      lease_expires_at = NULL, status_version = nextval('story_preparation_status_version')
    FROM expired WHERE job.job_id = expired.job_id
  `, story ? [story.ownerId, story.storyId] : [])
}

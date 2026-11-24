import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { StoryPreparationStatus } from '../../../shared/types/bridge.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { CapacityError, ConflictError, NotFoundError } from '../utils/errors.js'
import { expireStoryPreparationJobs, sharedPreparationLimits } from './sharedPreparationLimits.js'

export const STORY_PREPARATION_ENABLED = process.env.STORY_PREPARATION_ENABLED === '1'
const limits = STORY_PREPARATION_ENABLED ? sharedPreparationLimits() : undefined

interface StatusRow {
  active_preparation_revision: string | null
  job_id: string | null
  operation_id: string | null
  status_version: string
  state: NonNullable<StoryPreparationStatus['job']>['state']
  stage: NonNullable<StoryPreparationStatus['job']>['stage']
  percent: number
}

export const latestPreparationJoin = `
  LEFT JOIN LATERAL (
    SELECT job_id, operation_id, status_version, state, stage, percent FROM story_preparation_jobs
    WHERE owner_id = catalog.owner_id AND story_id = catalog.story_id AND source_revision = catalog.source_revision
    ORDER BY sequence DESC LIMIT 1
  ) preparation ON true
`

export function formatPreparationStatus(row: StatusRow): StoryPreparationStatus {
  return {
    activeRevision: row.active_preparation_revision,
    job: row.job_id ? {
      id: row.job_id, version: row.status_version, state: row.state, stage: row.stage, percent: row.percent,
      ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    } : null,
  }
}

export async function readStoryPreparation(ownerId: number, storyId: string): Promise<StoryPreparationStatus> {
  const db = getPostgresPool()
  await expireStoryPreparationJobs(db, { ownerId, storyId }).catch((error) => { throw postgresError(error) })
  const result = await db.query<StatusRow>(`
    SELECT catalog.active_preparation_revision, preparation.*
    FROM story_catalog catalog ${latestPreparationJoin}
    WHERE catalog.owner_id = $1 AND catalog.story_id = $2 AND catalog.deleted_at IS NULL
  `, [ownerId, storyId]).catch((error) => { throw postgresError(error) })
  if (!result.rows[0]) throw new NotFoundError('story not found')
  return formatPreparationStatus(result.rows[0])
}

type JobRow = Omit<StatusRow, 'active_preparation_revision'>
interface PreparationStory {
  source_revision: string
  active_preparation_revision: string | null
}
const JOB_STATUS = 'job_id, operation_id, status_version, state, stage, percent'

async function lockPreparationStory(client: PoolClient, ownerId: number, storyId: string): Promise<PreparationStory> {
  const { rows: [story] } = await client.query<PreparationStory>(`
    SELECT source_revision, active_preparation_revision FROM story_catalog
    WHERE owner_id = $1 AND story_id = $2 AND deleted_at IS NULL FOR UPDATE
  `, [ownerId, storyId])
  if (!story) throw new NotFoundError('story not found')
  return story
}

function preparationMutation<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  return inPostgresTransaction(work).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) throw error
    throw postgresError(error)
  })
}

export async function requestStoryPreparation(ownerId: number, storyId: string, operationId?: string, retryOfJobId?: string): Promise<StoryPreparationStatus> {
  const outcome = await preparationMutation(async (client) => {
    const story = await lockPreparationStory(client, ownerId, storyId)
    await expireStoryPreparationJobs(client, { ownerId, storyId })

    const result = (job: JobRow) =>
      formatPreparationStatus({ ...job, active_preparation_revision: story.active_preparation_revision })
    if (operationId) {
      const { rows: [replay] } = await client.query<JobRow & { retry_of_job_id: string | null }>(`
        SELECT ${JOB_STATUS}, retry_of_job_id FROM story_preparation_jobs
        WHERE owner_id = $1 AND story_id = $2 AND operation_id = $3
      `, [ownerId, storyId, operationId])
      if (replay) {
        if (replay.retry_of_job_id !== (retryOfJobId ?? null)) throw new ConflictError('该操作标识已用于其他准备请求。')
        return result(replay)
      }
    }
    const { rows: [latest] } = await client.query<JobRow>(`
      SELECT ${JOB_STATUS} FROM story_preparation_jobs
      WHERE owner_id = $1 AND story_id = $2 AND source_revision = $3
      ORDER BY sequence DESC LIMIT 1
    `, [ownerId, storyId, story.source_revision])
    if (retryOfJobId) {
      if (latest?.job_id !== retryOfJobId) {
        const known = await client.query(`
          SELECT 1 FROM story_preparation_jobs WHERE job_id = $1 AND owner_id = $2 AND story_id = $3
        `, [retryOfJobId, ownerId, storyId])
        if (!known.rowCount) throw new NotFoundError('story preparation job not found')
      }
      if (latest?.job_id !== retryOfJobId || (latest.state !== 'failed' && latest.state !== 'cancelled')) {
        throw new ConflictError('只能重试最近一次失败或已取消的准备任务。')
      }
    }
    if (latest?.state === 'queued' || latest?.state === 'running') {
      if (operationId) throw new ConflictError('该剧本已有准备任务，请查看当前进度。')
      return result(latest)
    }

    const config = limits ?? sharedPreparationLimits()
    // Only count and insertion are serialized across unrelated stories and owners.
    await client.query('SELECT pg_advisory_xact_lock(17407, 117)')
    // Reap what can commit now. A locked heartbeat may still be renewing its slot.
    await expireStoryPreparationJobs(client)
    const { rows: [pending] } = await client.query<{ account: number; total: number }>(`
      SELECT count(*) FILTER (WHERE owner_id = $1)::int AS account, count(*)::int AS total
      FROM story_preparation_jobs
      WHERE state IN ('queued', 'running')
    `, [ownerId])
    // Commit this batch of expirations even when the queue still has no space.
    if (pending!.account >= config.perAccount) return new CapacityError('你的准备任务已达上限，请取消一个任务或稍后重试。')
    if (pending!.total >= config.global) return new CapacityError('准备队列已满，请稍后重试。')

    const { rows: [job] } = await client.query<JobRow>(`
      INSERT INTO story_preparation_jobs
        (job_id, owner_id, story_id, source_revision, state, stage, percent, operation_id, retry_of_job_id, deadline_at, attempt_limit)
      VALUES ($1, $2, $3, $4, 'queued', 'queued', 0, $5, $6, clock_timestamp() + $7 * interval '1 millisecond', $8)
      RETURNING ${JOB_STATUS}
    `, [randomUUID(), ownerId, storyId, story.source_revision, operationId ?? null, retryOfJobId ?? null,
      config.deadlineMs, config.attemptLimit])
    return result(job!)
  })
  if (outcome instanceof CapacityError) throw outcome
  return outcome
}

export async function cancelStoryPreparation(ownerId: number, storyId: string, jobId: string): Promise<StoryPreparationStatus> {
  return preparationMutation(async (client) => {
    const story = await lockPreparationStory(client, ownerId, storyId)
    await expireStoryPreparationJobs(client, { ownerId, storyId })
    const { rows: [job] } = await client.query<JobRow>(`
      SELECT ${JOB_STATUS} FROM story_preparation_jobs
      WHERE job_id = $1 AND owner_id = $2 AND story_id = $3 AND source_revision = $4 FOR UPDATE
    `, [jobId, ownerId, storyId, story.source_revision])
    if (!job) throw new NotFoundError('story preparation job not found')
    const result = (row: JobRow) => formatPreparationStatus({ ...row, active_preparation_revision: story.active_preparation_revision })
    if (job.state === 'cancelled') return result(job)
    if (job.state !== 'queued' && job.state !== 'running') throw new ConflictError('该准备任务已结束。')
    const { rows: [cancelled] } = await client.query<JobRow>(`
      UPDATE story_preparation_jobs SET state = 'cancelled', stage = 'cancelled', lease_expires_at = NULL,
        status_version = nextval('story_preparation_status_version')
      WHERE job_id = $1 RETURNING ${JOB_STATUS}
    `, [jobId])
    return result(cancelled!)
  })
}

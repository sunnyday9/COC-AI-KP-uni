import { randomUUID } from 'node:crypto'
import type { StoryPreparationStatus } from '../../../shared/types/bridge.js'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { NotFoundError } from '../utils/errors.js'

export const STORY_PREPARATION_ENABLED = process.env.STORY_PREPARATION_ENABLED === '1'

interface StatusRow {
  active_preparation_revision: string | null
  job_id: string | null
  status_version: string
  state: NonNullable<StoryPreparationStatus['job']>['state']
  stage: NonNullable<StoryPreparationStatus['job']>['stage']
  percent: number
}

export const latestPreparationJoin = `
  LEFT JOIN LATERAL (
    SELECT job_id, status_version, state, stage, percent FROM story_preparation_jobs
    WHERE owner_id = catalog.owner_id AND story_id = catalog.story_id AND source_revision = catalog.source_revision
    ORDER BY sequence DESC LIMIT 1
  ) preparation ON true
`

export function formatPreparationStatus(row: StatusRow): StoryPreparationStatus {
  return {
    activeRevision: row.active_preparation_revision,
    job: row.job_id ? { id: row.job_id, version: row.status_version, state: row.state, stage: row.stage, percent: row.percent } : null,
  }
}

export async function readStoryPreparation(ownerId: number, storyId: string): Promise<StoryPreparationStatus> {
  const result = await getPostgresPool().query<StatusRow>(`
    SELECT catalog.active_preparation_revision, preparation.*
    FROM story_catalog catalog ${latestPreparationJoin}
    WHERE catalog.owner_id = $1 AND catalog.story_id = $2 AND catalog.deleted_at IS NULL
  `, [ownerId, storyId]).catch((error) => { throw postgresError(error) })
  if (!result.rows[0]) throw new NotFoundError('story not found')
  return formatPreparationStatus(result.rows[0])
}

export async function requestStoryPreparation(ownerId: number, storyId: string): Promise<StoryPreparationStatus> {
  try {
    return await inPostgresTransaction(async (client) => {
      const { rows: [story] } = await client.query<{ source_revision: string; active_preparation_revision: string | null }>(`
        SELECT source_revision, active_preparation_revision FROM story_catalog
        WHERE owner_id = $1 AND story_id = $2 AND deleted_at IS NULL FOR UPDATE
      `, [ownerId, storyId])
      if (!story) throw new NotFoundError('story not found')

      const { rows: [pending] } = await client.query<Omit<StatusRow, 'active_preparation_revision'>>(`
        SELECT job_id, status_version, state, stage, percent FROM story_preparation_jobs
        WHERE owner_id = $1 AND story_id = $2 AND state IN ('queued', 'running')
      `, [ownerId, storyId])
      if (pending) return formatPreparationStatus({ ...pending, active_preparation_revision: story.active_preparation_revision })

      const { rows: [job] } = await client.query<Omit<StatusRow, 'active_preparation_revision'>>(`
        INSERT INTO story_preparation_jobs (job_id, owner_id, story_id, source_revision, state, stage, percent)
        VALUES ($1, $2, $3, $4, 'queued', 'queued', 0)
        RETURNING job_id, status_version, state, stage, percent
      `, [randomUUID(), ownerId, storyId, story.source_revision])
      return formatPreparationStatus({ ...job!, active_preparation_revision: story.active_preparation_revision })
    })
  } catch (error) {
    if (error instanceof NotFoundError) throw error
    throw postgresError(error)
  }
}

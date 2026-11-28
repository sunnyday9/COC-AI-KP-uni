import { Pool, type PoolClient } from 'pg'
import { PG_POOL_MAX } from '../config.js'
import { logger } from '../utils/logging.js'
import { IncompatiblePostgresAccountSchemaError, initializePostgresAccounts } from './postgresAccountsSchema.js'

import { initializePostgresStories } from './postgresStoriesSchema.js'
import { initializePostgresStoryPreparation } from './postgresStoryPreparationSchema.js'

let pool: Pool | undefined

export class PostgresOperationError extends Error {}

/** Keep connection details, row data, and SQL parameters out of app logs. */
export function postgresError(error: unknown): PostgresOperationError {
  const code = (error as { code?: unknown } | null)?.code
  const reason = typeof code === 'string' && /^[A-Z0-9]{5,20}$/.test(code) ? ` (${code})` : ''
  return new PostgresOperationError(`PostgreSQL operation failed${reason}`)
}

export function getPostgresPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: PG_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      allowExitOnIdle: true,
    })
    pool.on('error', (error) => logger.warn(postgresError(error).message))
  }
  return pool
}

/** The caller owns (and must dispose of) a supplied session client. */
export async function inPostgresTransaction<T>(run: (client: PoolClient) => Promise<T>, session?: PoolClient): Promise<T> {
  const client = session ?? await getPostgresPool().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discard = true
    }
    throw error
  } finally {
    if (!session) client.release(discard)
  }
}

/** Gate concurrent gateway startup on the same transactional schema installation. */
export async function initializePostgres(enableStories = false, enablePreparation = false): Promise<void> {
  try {
    await inPostgresTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(17407, 111)')
      await initializePostgresAccounts(client)
      if (enableStories) await initializePostgresStories(client)
      if (enablePreparation) await initializePostgresStoryPreparation(client)
    })
  } catch (error) {
    if (error instanceof IncompatiblePostgresAccountSchemaError) throw error
    throw postgresError(error)
  }
}

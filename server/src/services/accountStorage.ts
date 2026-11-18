import { DEPLOYMENT_MODE } from '../config.js'
import { getDb } from '../db/index.js'
import { getPostgresPool, postgresError } from '../db/postgres.js'

export interface Account {
  id: number
  username: string
}

interface AccountWithPassword extends Account {
  password_hash: string
}

interface AccountStore {
  findByUsername(username: string): Promise<AccountWithPassword | undefined>
  findById(id: number): Promise<Account | undefined>
  create(username: string, passwordHash: string): Promise<number | undefined>
}

const sqliteAccounts: AccountStore = {
  async findByUsername(username) {
    return getDb()
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as AccountWithPassword | undefined
  },

  async findById(id) {
    return getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(id) as Account | undefined
  },

  async create(username, passwordHash) {
    const info = getDb()
      .prepare(`
        INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
        ON CONFLICT(username) DO NOTHING
      `)
      .run(username, passwordHash, Date.now())
    return info.changes ? Number(info.lastInsertRowid) : undefined
  },
}

function numericId(id: string): number {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid account ID')
  return value
}

const postgresAccounts: AccountStore = {
  async findByUsername(username) {
    try {
      const result = await getPostgresPool().query<Omit<AccountWithPassword, 'id'> & { id: string }>(
        'SELECT id, username, password_hash FROM users WHERE username = $1', [username],
      )
      const row = result.rows[0]
      return row && { ...row, id: numericId(row.id) }
    } catch (error) {
      throw postgresError(error)
    }
  },

  async findById(id) {
    try {
      const result = await getPostgresPool().query<Omit<Account, 'id'> & { id: string }>(
        'SELECT id, username FROM users WHERE id = $1', [id],
      )
      const row = result.rows[0]
      return row && { ...row, id: numericId(row.id) }
    } catch (error) {
      throw postgresError(error)
    }
  },

  async create(username, passwordHash) {
    try {
      const result = await getPostgresPool().query<{ id: string }>(
        `INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3)
         ON CONFLICT(username) DO NOTHING RETURNING id`,
        [username, passwordHash, Date.now()],
      )
      const row = result.rows[0]
      return row && numericId(row.id)
    } catch (error) {
      throw postgresError(error)
    }
  },
}

export const accounts = DEPLOYMENT_MODE === 'shared-accounts' ? postgresAccounts : sqliteAccounts

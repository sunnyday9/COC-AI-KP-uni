import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'

/** undefined denotes a missing account; null denotes settings not saved yet. */
export async function readPostgresSettings(userId: number): Promise<string | null | undefined> {
  try {
    const result = await getPostgresPool().query<{ data: string | null }>(`
      SELECT settings.data FROM users LEFT JOIN settings ON settings.user_id = users.id
      WHERE users.id = $1
    `, [userId])
    return result.rows[0]?.data
  } catch (error) {
    throw postgresError(error)
  }
}

/** Lock the account so even two first-time updates see each other's commits. */
export async function updatePostgresSettings(
  userId: number,
  update: (current: string | null) => string,
): Promise<boolean> {
  try {
    return await inPostgresTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const account = await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId])
      if (!account.rowCount) return false

      const current = await client.query<{ data: string }>('SELECT data FROM settings WHERE user_id = $1', [userId])
      const data = update(current.rows[0]?.data ?? null)
      await client.query(`
        INSERT INTO settings (user_id, data) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data
      `, [userId, data])
      return true
    })
  } catch (error) {
    throw postgresError(error)
  }
}

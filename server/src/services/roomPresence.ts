import { inPostgresTransaction, getPostgresPool } from '../db/postgres.js'

const presenceTtl = "interval '15 seconds'"

export async function initializeRoomPresence(): Promise<void> {
  await inPostgresTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(17407, 123)')
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_gateway_presence (
        room_id TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        subscription_id UUID NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (room_id, user_id, subscription_id),
        FOREIGN KEY (room_id, user_id) REFERENCES room_members (room_id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS room_gateway_presence_expiry ON room_gateway_presence (expires_at);
    `)
  })
}

export async function registerRoomPresence(roomId: string, userId: number, subscriptionId: string): Promise<boolean> {
  return inPostgresTransaction(async (client) => {
    // Serialize a new subscriber with the fenced absence check before succession.
    const room = await client.query('SELECT 1 FROM rooms WHERE room_id = $1 FOR NO KEY UPDATE', [roomId])
    if (!room.rowCount) return false
    const member = await client.query(`
      INSERT INTO room_gateway_presence (room_id, user_id, subscription_id, expires_at)
      SELECT room_id, user_id, $3, clock_timestamp() + ${presenceTtl}
      FROM room_members WHERE room_id = $1 AND user_id = $2
      ON CONFLICT (room_id, user_id, subscription_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `, [roomId, userId, subscriptionId])
    return member.rowCount === 1
  })
}

export async function removeRoomPresence(roomId: string, userId: number, subscriptionId: string): Promise<boolean> {
  const result = await getPostgresPool().query<{ live: boolean }>(`
    DELETE FROM room_gateway_presence WHERE room_id = $1 AND user_id = $2 AND subscription_id = $3
    RETURNING expires_at > clock_timestamp() AS live
  `, [roomId, userId, subscriptionId])
  return result.rows[0]?.live === true
}

export interface RoomPresence {
  roomId: string
  userId: number
  subscriptionId: string
}

export async function renewRoomPresence(entries: RoomPresence[]): Promise<Set<string>> {
  const result = await getPostgresPool().query<{ subscription_id: string }>(`
    UPDATE room_gateway_presence AS presence SET expires_at = clock_timestamp() + ${presenceTtl}
    FROM unnest($1::text[], $2::bigint[], $3::uuid[]) AS local(room_id, user_id, subscription_id)
    WHERE (presence.room_id, presence.user_id, presence.subscription_id) =
      (local.room_id, local.user_id, local.subscription_id)
    RETURNING presence.subscription_id
  `, [entries.map((entry) => entry.roomId), entries.map((entry) => entry.userId), entries.map((entry) => entry.subscriptionId)])
  return new Set(result.rows.map((row) => row.subscription_id))
}

export async function reapRoomPresence(): Promise<void> {
  // Absence alone is inert. A gateway crash only leaves rows that age out.
  await getPostgresPool().query(`
    DELETE FROM room_gateway_presence WHERE (room_id, user_id, subscription_id) IN (
      SELECT room_id, user_id, subscription_id FROM room_gateway_presence
      WHERE expires_at <= clock_timestamp() - interval '15 seconds'
      ORDER BY expires_at LIMIT 4096 FOR UPDATE SKIP LOCKED
    )
  `)
}

import { inPostgresTransaction } from './postgres.js'

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

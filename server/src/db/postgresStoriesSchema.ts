import type { PoolClient } from 'pg'

/** Source revisions are immutable. Tombstones reserve the ID and retain its revision. */
export async function initializePostgresStories(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS story_catalog (
      owner_id BIGINT NOT NULL REFERENCES users(id),
      story_id TEXT COLLATE "C" NOT NULL,
      name TEXT NOT NULL,
      source_revision UUID NOT NULL,
      source_size BIGINT NOT NULL CHECK (source_size >= 0),
      extension TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      deleted_at BIGINT,
      PRIMARY KEY (owner_id, story_id)
    );
    CREATE INDEX IF NOT EXISTS story_catalog_active_owner_keyset ON story_catalog
      (owner_id, created_at DESC, story_id DESC) WHERE deleted_at IS NULL;
  `)
}

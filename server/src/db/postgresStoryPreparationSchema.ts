import type { PoolClient } from 'pg'

export async function initializePostgresStoryPreparation(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE story_catalog ADD COLUMN IF NOT EXISTS active_preparation_revision UUID;
    ALTER TABLE story_catalog ADD COLUMN IF NOT EXISTS active_prepared_at BIGINT;
    CREATE INDEX IF NOT EXISTS story_catalog_prepared_owner_keyset ON story_catalog
      (owner_id, active_prepared_at DESC, story_id DESC)
      WHERE deleted_at IS NULL AND active_preparation_revision IS NOT NULL;

    CREATE TABLE IF NOT EXISTS story_preparation_jobs (
      sequence BIGSERIAL PRIMARY KEY,
      job_id UUID NOT NULL UNIQUE,
      owner_id BIGINT NOT NULL,
      story_id TEXT COLLATE "C" NOT NULL,
      source_revision UUID NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'failed')),
      stage TEXT NOT NULL,
      percent SMALLINT NOT NULL CHECK (percent BETWEEN 0 AND 100),
      attempt BIGINT NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ,
      FOREIGN KEY (owner_id, story_id) REFERENCES story_catalog (owner_id, story_id)
    );
    CREATE SEQUENCE IF NOT EXISTS story_preparation_status_version;
    ALTER TABLE story_preparation_jobs ADD COLUMN IF NOT EXISTS status_version BIGINT NOT NULL
      DEFAULT nextval('story_preparation_status_version');
    ALTER TABLE story_preparation_jobs ADD COLUMN IF NOT EXISTS operation_id TEXT COLLATE "C";
    ALTER TABLE story_preparation_jobs ADD COLUMN IF NOT EXISTS retry_of_job_id UUID REFERENCES story_preparation_jobs(job_id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'story_preparation_jobs'::regclass AND conname = 'story_preparation_job_states'
      ) THEN
        ALTER TABLE story_preparation_jobs DROP CONSTRAINT IF EXISTS story_preparation_jobs_state_check;
        ALTER TABLE story_preparation_jobs ADD CONSTRAINT story_preparation_job_states
          CHECK (state IN ('queued', 'running', 'complete', 'failed', 'cancelled'));
      END IF;
    END
    $$;
    ALTER TABLE story_preparation_jobs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ NOT NULL
      DEFAULT (statement_timestamp() + interval '30 minutes');
    ALTER TABLE story_preparation_jobs ADD COLUMN IF NOT EXISTS attempt_limit SMALLINT NOT NULL DEFAULT 3;
    CREATE INDEX IF NOT EXISTS story_preparation_pending_deadline ON story_preparation_jobs
      (deadline_at, sequence) WHERE state IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS story_preparation_dispatch (
      owner_id BIGINT PRIMARY KEY REFERENCES users(id),
      last_claim BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS story_preparation_operation ON story_preparation_jobs
      (owner_id, story_id, operation_id) WHERE operation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS story_preparation_latest ON story_preparation_jobs
      (owner_id, story_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS story_preparation_claimable ON story_preparation_jobs
      (lease_expires_at NULLS LAST, sequence) WHERE state IN ('queued', 'running');
    CREATE UNIQUE INDEX IF NOT EXISTS story_preparation_one_pending ON story_preparation_jobs
      (owner_id, story_id) WHERE state IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS story_preparation_revisions (
      revision UUID PRIMARY KEY,
      job_id UUID NOT NULL UNIQUE REFERENCES story_preparation_jobs (job_id),
      owner_id BIGINT NOT NULL,
      story_id TEXT COLLATE "C" NOT NULL,
      source_revision UUID NOT NULL,
      prepared_at BIGINT NOT NULL,
      chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
      objects JSONB NOT NULL,
      FOREIGN KEY (owner_id, story_id) REFERENCES story_catalog (owner_id, story_id)
    );

    CREATE TABLE IF NOT EXISTS story_preparation_uploads (
      revision UUID PRIMARY KEY,
      job_id UUID NOT NULL REFERENCES story_preparation_jobs (job_id),
      attempt BIGINT NOT NULL,
      cleanup_after TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      discarded BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (job_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS story_preparation_uploads_cleanup ON story_preparation_uploads (cleanup_after);
  `)
}

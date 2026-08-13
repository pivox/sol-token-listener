ALTER TABLE social_enrichment_jobs
  ADD COLUMN IF NOT EXISTS persistence_retry_cycles INTEGER NOT NULL DEFAULT 0;

ALTER TABLE social_enrichment_jobs
  DROP CONSTRAINT IF EXISTS social_enrichment_jobs_attempts_check;
ALTER TABLE social_enrichment_jobs
  ADD CONSTRAINT social_enrichment_jobs_attempts_check CHECK (
    attempts BETWEEN 0 AND 300
  );

ALTER TABLE social_enrichment_jobs
  DROP CONSTRAINT IF EXISTS social_enrichment_jobs_persistence_retry_cycles_check;
ALTER TABLE social_enrichment_jobs
  ADD CONSTRAINT social_enrichment_jobs_persistence_retry_cycles_check CHECK (
    persistence_retry_cycles BETWEEN 0 AND 2
  );

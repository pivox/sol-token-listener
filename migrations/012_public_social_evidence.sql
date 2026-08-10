ALTER TABLE token_metadata_snapshots
  ADD COLUMN IF NOT EXISTS source_launch_event_id TEXT
    REFERENCES domain_events(event_id);
ALTER TABLE token_metadata_snapshots
  ADD COLUMN IF NOT EXISTS failure_retryable BOOLEAN;

CREATE UNIQUE INDEX IF NOT EXISTS token_metadata_snapshots_source_idx
  ON token_metadata_snapshots(source_launch_event_id, payload_hash)
  WHERE source_launch_event_id IS NOT NULL;

ALTER TABLE token_metadata_snapshots
  DROP CONSTRAINT IF EXISTS token_metadata_snapshots_social_lineage_check;
ALTER TABLE token_metadata_snapshots
  ADD CONSTRAINT token_metadata_snapshots_social_lineage_check CHECK (
    source_launch_event_id IS NULL
    OR (resolution_status = 'resolved' AND failure_retryable IS NULL)
    OR (resolution_status = 'failed' AND failure_retryable IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS social_enrichment_jobs (
  job_id TEXT PRIMARY KEY CHECK (job_id ~ '^social_job_[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  source_launch_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_raw_event_id TEXT NOT NULL REFERENCES raw_chain_events(event_id),
  metadata_uri TEXT CHECK (metadata_uri IS NULL OR OCTET_LENGTH(metadata_uri) BETWEEN 1 AND 16384),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','PROCESSING','RETRYABLE_FAILED','COMPLETED','CANCELLED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  attempts_in_cycle INTEGER NOT NULL DEFAULT 0
    CHECK (attempts_in_cycle BETWEEN 0 AND 100 AND attempts_in_cycle <= attempts),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  base_delay_ms INTEGER NOT NULL CHECK (base_delay_ms BETWEEN 1 AND 60000),
  lease_token TEXT CHECK (lease_token IS NULL OR OCTET_LENGTH(lease_token) BETWEEN 1 AND 256),
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'HTTP_TRANSIENT','PROVIDER_UNAVAILABLE','LEASE_EXPIRED'
  )),
  retry_exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, source_launch_event_id),
  CHECK (
    (status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'RETRYABLE_FAILED' AND next_attempt_at IS NOT NULL AND error_code IS NOT NULL)
    OR (status <> 'RETRYABLE_FAILED' AND next_attempt_at IS NULL)
  ),
  CHECK (
    (status IN ('COMPLETED','CANCELLED') AND terminal_at IS NOT NULL AND purge_after IS NOT NULL)
    OR (status NOT IN ('COMPLETED','CANCELLED') AND terminal_at IS NULL AND purge_after IS NULL)
  ),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS social_enrichment_jobs_claim_idx
  ON social_enrichment_jobs(next_attempt_at, created_at, job_id)
  WHERE status IN ('PENDING','RETRYABLE_FAILED');
CREATE INDEX IF NOT EXISTS social_enrichment_jobs_lease_idx
  ON social_enrichment_jobs(lease_expires_at, job_id)
  WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS social_enrichment_jobs_purge_idx
  ON social_enrichment_jobs(purge_after, job_id)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_evidence_collections (
  collection_id TEXT PRIMARY KEY CHECK (collection_id ~ '^social_collection_[0-9a-f]{64}$'),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  source_launch_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_raw_event_id TEXT NOT NULL REFERENCES raw_chain_events(event_id),
  metadata_snapshot_id TEXT NOT NULL REFERENCES token_metadata_snapshots(snapshot_id),
  collection_status TEXT NOT NULL CHECK (collection_status IN ('COMPLETE','PARTIAL','FAILED')),
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, source_launch_event_id),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS social_evidence_collections_current_idx
  ON social_evidence_collections(mint, observed_at DESC, collection_id)
  WHERE confirmation_status <> 'orphaned' AND terminal_at IS NULL;
CREATE INDEX IF NOT EXISTS social_evidence_collections_purge_idx
  ON social_evidence_collections(purge_after, collection_id)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_links (
  link_id TEXT PRIMARY KEY CHECK (link_id ~ '^social_link_[0-9a-f]{64}$'),
  collection_id TEXT NOT NULL REFERENCES social_evidence_collections(collection_id) ON DELETE CASCADE,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  metadata_snapshot_id TEXT NOT NULL REFERENCES token_metadata_snapshots(snapshot_id),
  link_kind TEXT NOT NULL CHECK (link_kind IN ('WEBSITE','X','TELEGRAM')),
  declared_value_sha256 TEXT NOT NULL CHECK (declared_value_sha256 ~ '^[0-9a-f]{64}$'),
  syntax_status TEXT NOT NULL CHECK (syntax_status IN ('VALID','INVALID')),
  canonical_url TEXT CHECK (canonical_url IS NULL OR OCTET_LENGTH(canonical_url) BETWEEN 1 AND 2048),
  invalid_reason TEXT CHECK (invalid_reason IS NULL OR invalid_reason IN (
    'VALUE_MISSING','VALUE_NOT_TEXT','URL_INVALID','URL_TOO_LONG',
    'SCHEME_UNSUPPORTED','CREDENTIALS_FORBIDDEN','HOST_UNSUPPORTED',
    'PROFILE_PATH_UNSUPPORTED'
  )),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (collection_id, link_kind),
  CHECK (
    (syntax_status = 'VALID' AND canonical_url IS NOT NULL AND invalid_reason IS NULL)
    OR (syntax_status = 'INVALID' AND canonical_url IS NULL AND invalid_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS social_links_mint_idx
  ON social_links(mint, link_kind, link_id);

CREATE TABLE IF NOT EXISTS social_http_observations (
  observation_id TEXT PRIMARY KEY CHECK (observation_id ~ '^social_http_[0-9a-f]{64}$'),
  collection_id TEXT NOT NULL REFERENCES social_evidence_collections(collection_id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES social_links(link_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED')),
  final_canonical_url TEXT CHECK (
    final_canonical_url IS NULL OR OCTET_LENGTH(final_canonical_url) BETWEEN 1 AND 2048
  ),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  redirect_count INTEGER NOT NULL CHECK (redirect_count BETWEEN 0 AND 10),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  failure_reason TEXT CHECK (failure_reason IS NULL OR OCTET_LENGTH(failure_reason) BETWEEN 1 AND 2048),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (collection_id, link_id),
  CHECK (
    (outcome = 'SUCCEEDED' AND final_canonical_url IS NOT NULL
      AND http_status BETWEEN 200 AND 299 AND content_sha256 IS NOT NULL
      AND failure_reason IS NULL)
    OR (outcome = 'FAILED' AND content_sha256 IS NULL AND failure_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS social_verification_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (evidence_id ~ '^social_evidence_[0-9a-f]{64}$'),
  collection_id TEXT NOT NULL REFERENCES social_evidence_collections(collection_id) ON DELETE CASCADE,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  link_id TEXT REFERENCES social_links(link_id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES social_http_observations(observation_id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'URL_SYNTAX_VALID','URL_SYNTAX_INVALID','URL_REACHABLE',
    'CROSS_LINK_CONFIRMED','MINT_PUBLISHED','ACCOUNT_TOO_RECENT',
    'DOMAIN_MISMATCH','CONTENT_UNAVAILABLE','VERIFICATION_UNKNOWN'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('CONFIRMED','REJECTED','UNKNOWN')),
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('WEBSITE','X','TELEGRAM')),
  related_kind TEXT CHECK (related_kind IS NULL OR related_kind IN ('WEBSITE','X','TELEGRAM')),
  reason_code TEXT NOT NULL CHECK (
    reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
  ),
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS social_verification_evidence_collection_idx
  ON social_verification_evidence(collection_id, evidence_type, evidence_id);
CREATE INDEX IF NOT EXISTS social_verification_evidence_mint_idx
  ON social_verification_evidence(mint, evidence_type, outcome);

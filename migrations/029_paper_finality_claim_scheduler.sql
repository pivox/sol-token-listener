CREATE SEQUENCE IF NOT EXISTS paper_decision_claim_scan_generation_seq
  AS BIGINT START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;

ALTER TABLE paper_decision_jobs
  ADD COLUMN IF NOT EXISTS finality_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_scan_generation BIGINT;

DO $migration$
DECLARE
  sequence_value BIGINT;
  existing_value BIGINT;
  next_value BIGINT;
BEGIN
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END
  INTO sequence_value
  FROM paper_decision_claim_scan_generation_seq;

  SELECT COALESCE(MAX(claim_scan_generation),0)
  INTO existing_value
  FROM paper_decision_jobs;

  WITH missing AS MATERIALIZED (
    SELECT job_id,ROW_NUMBER() OVER (ORDER BY created_at,job_id) AS ordinal
    FROM paper_decision_jobs
    WHERE claim_scan_generation IS NULL
  )
  UPDATE paper_decision_jobs job
  SET claim_scan_generation=GREATEST(sequence_value,existing_value)+missing.ordinal
  FROM missing
  WHERE job.job_id=missing.job_id;

  SELECT COALESCE(MAX(claim_scan_generation),0)
  INTO next_value
  FROM paper_decision_jobs;
  next_value:=GREATEST(sequence_value,next_value);
  IF next_value=0 THEN
    PERFORM setval('paper_decision_claim_scan_generation_seq',1,FALSE);
  ELSE
    PERFORM setval('paper_decision_claim_scan_generation_seq',next_value,TRUE);
  END IF;
END
$migration$;

ALTER TABLE paper_decision_jobs
  ALTER COLUMN claim_scan_generation SET DEFAULT
    nextval('paper_decision_claim_scan_generation_seq'),
  ALTER COLUMN claim_scan_generation SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='paper_decision_jobs_claim_scan_generation_check'
      AND conrelid='paper_decision_jobs'::regclass
  ) THEN
    ALTER TABLE paper_decision_jobs
      ADD CONSTRAINT paper_decision_jobs_claim_scan_generation_check
      CHECK (claim_scan_generation>0);
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS paper_decision_jobs_finality_preflight_idx
  ON paper_decision_jobs (
    (CASE status
      WHEN 'PENDING' THEN COALESCE(finality_checked_at,created_at)
      WHEN 'RETRYABLE_FAILED' THEN GREATEST(
        next_attempt_at,COALESCE(finality_checked_at,created_at)
      )
      WHEN 'PROCESSING' THEN GREATEST(
        lease_expires_at,COALESCE(finality_checked_at,created_at)
      )
    END),
    claim_scan_generation,
    created_at,
    job_id
  )
  WHERE status IN ('PENDING','RETRYABLE_FAILED','PROCESSING');

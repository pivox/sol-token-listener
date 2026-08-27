ALTER TABLE paper_mvp_runs
  ADD COLUMN IF NOT EXISTS runner_owner_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_reason TEXT;

-- Terminal rows are normally immutable. This one compatibility backfill only
-- adds a completion reason; every historical verdict, status and gate remains
-- untouched. The trigger is restored before the migration finishes.
DROP TRIGGER IF EXISTS paper_mvp_runs_immutable_trigger ON paper_mvp_runs;

UPDATE paper_mvp_runs
SET runner_owner_id='legacy:' || md5(run_id)
WHERE state='RUNNING' AND runner_owner_id IS NULL;

UPDATE paper_mvp_runs
SET completion_reason='LEGACY',
    report_payload=jsonb_set(report_payload, '{completionReason}', '"LEGACY"'::jsonb, true)
WHERE state='COMPLETED' AND completion_reason IS NULL;

CREATE TRIGGER paper_mvp_runs_immutable_trigger
  BEFORE UPDATE ON paper_mvp_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_paper_mvp_run_immutable_mutation();

ALTER TABLE paper_mvp_runs
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_runner_owner_id_check,
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_completion_reason_check,
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_runner_lifecycle_check;

ALTER TABLE paper_mvp_runs
  ADD CONSTRAINT paper_mvp_runs_runner_owner_id_check CHECK (
    runner_owner_id IS NULL OR OCTET_LENGTH(runner_owner_id) BETWEEN 1 AND 256
  ),
  ADD CONSTRAINT paper_mvp_runs_completion_reason_check CHECK (
    completion_reason IS NULL OR completion_reason IN
      ('TARGET_REACHED','TIMEOUT','SIGINT','SIGTERM','LEGACY')
  ),
  ADD CONSTRAINT paper_mvp_runs_runner_lifecycle_check CHECK (
    (state='RUNNING' AND runner_owner_id IS NOT NULL AND completion_reason IS NULL)
    OR (state='COMPLETED' AND runner_owner_id IS NULL AND completion_reason IS NOT NULL
      AND (report_payload->>'completionReason'=completion_reason) IS TRUE)
    OR (state='FAILED' AND runner_owner_id IS NULL AND completion_reason IS NULL)
  );

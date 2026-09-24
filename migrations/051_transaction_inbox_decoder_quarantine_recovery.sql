-- Bounded evidence for one explicit replay of a worker snapshot after a
-- decoder upgrade. Catch-up quarantines remain deliberately ineligible.
DO $migration_051$
DECLARE
  receipt_table REGCLASS;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);

  DROP TABLE IF EXISTS pg_temp.migration_051_canonical;
  CREATE TEMP TABLE pg_temp.migration_051_canonical (
    signature TEXT NOT NULL,
    quarantine_kind TEXT NOT NULL,
    worker_reason_code TEXT NOT NULL,
    snapshot_fingerprint TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL,
    recovered_at TIMESTAMPTZ NOT NULL,
    recovery_source TEXT NOT NULL,
    purge_after TIMESTAMPTZ NOT NULL,
    CONSTRAINT transaction_inbox_decoder_recoveries_pkey
      PRIMARY KEY (signature, quarantined_at),
    CONSTRAINT transaction_inbox_decoder_recoveries_evidence_check CHECK (
      signature=BTRIM(signature)
      AND OCTET_LENGTH(signature) BETWEEN 1 AND 128
      AND quarantine_kind='WORKER_SNAPSHOT'
      AND OCTET_LENGTH(quarantine_kind) BETWEEN 1 AND 64
      AND worker_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PUMP_BORSH_TRUNCATED')
      AND OCTET_LENGTH(worker_reason_code) BETWEEN 1 AND 64
      AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
      AND OCTET_LENGTH(snapshot_fingerprint)=64
      AND recovery_source='LOCAL_CLI'
      AND OCTET_LENGTH(recovery_source) BETWEEN 1 AND 64
    ),
    CONSTRAINT transaction_inbox_decoder_recoveries_retention_check CHECK (
      isfinite(quarantined_at)
      AND quarantined_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds',quarantined_at)=quarantined_at
      AND isfinite(recovered_at)
      AND recovered_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds',recovered_at)=recovered_at
      AND isfinite(purge_after)
      AND purge_after<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds',purge_after)=purge_after
      AND recovered_at>=quarantined_at
      AND purge_after=recovered_at+INTERVAL '4 hours'
    )
  ) ON COMMIT DROP;
  CREATE INDEX transaction_inbox_decoder_recoveries_purge_idx
    ON pg_temp.migration_051_canonical (purge_after, signature);

  SELECT to_regclass(format('%I.%I',current_schema(),
    'transaction_inbox_decoder_recoveries')) INTO receipt_table;
  IF receipt_table IS NULL THEN
    CREATE TABLE transaction_inbox_decoder_recoveries (
      signature TEXT NOT NULL,
      quarantine_kind TEXT NOT NULL,
      worker_reason_code TEXT NOT NULL,
      snapshot_fingerprint TEXT NOT NULL,
      quarantined_at TIMESTAMPTZ NOT NULL,
      recovered_at TIMESTAMPTZ NOT NULL,
      recovery_source TEXT NOT NULL,
      purge_after TIMESTAMPTZ NOT NULL,
      CONSTRAINT transaction_inbox_decoder_recoveries_pkey
        PRIMARY KEY (signature, quarantined_at),
      CONSTRAINT transaction_inbox_decoder_recoveries_evidence_check CHECK (
        signature=BTRIM(signature)
        AND OCTET_LENGTH(signature) BETWEEN 1 AND 128
        AND quarantine_kind='WORKER_SNAPSHOT'
        AND OCTET_LENGTH(quarantine_kind) BETWEEN 1 AND 64
        AND worker_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PUMP_BORSH_TRUNCATED')
        AND OCTET_LENGTH(worker_reason_code) BETWEEN 1 AND 64
        AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        AND OCTET_LENGTH(snapshot_fingerprint)=64
        AND recovery_source='LOCAL_CLI'
        AND OCTET_LENGTH(recovery_source) BETWEEN 1 AND 64
      ),
      CONSTRAINT transaction_inbox_decoder_recoveries_retention_check CHECK (
        isfinite(quarantined_at)
        AND quarantined_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
        AND date_trunc('milliseconds',quarantined_at)=quarantined_at
        AND isfinite(recovered_at)
        AND recovered_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
        AND date_trunc('milliseconds',recovered_at)=recovered_at
        AND isfinite(purge_after)
        AND purge_after<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
        AND date_trunc('milliseconds',purge_after)=purge_after
        AND recovered_at>=quarantined_at
        AND purge_after=recovered_at+INTERVAL '4 hours'
      )
    );
    CREATE INDEX transaction_inbox_decoder_recoveries_purge_idx
      ON transaction_inbox_decoder_recoveries (purge_after, signature);
    SELECT 'transaction_inbox_decoder_recoveries'::REGCLASS INTO receipt_table;
  ELSE
    LOCK TABLE transaction_inbox_decoder_recoveries IN ACCESS EXCLUSIVE MODE;
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM pg_class relation
      WHERE relation.oid=receipt_table AND relation.relkind='r' AND relation.relpersistence='p'
    )
    OR (SELECT COUNT(*) FROM pg_attribute attribute
      WHERE attribute.attrelid=receipt_table AND attribute.attnum>0 AND NOT attribute.attisdropped)<>8
    OR EXISTS (
      SELECT 1
      FROM pg_attribute expected
      FULL JOIN pg_attribute actual ON actual.attrelid=receipt_table
        AND actual.attnum>0 AND NOT actual.attisdropped AND actual.attname=expected.attname
      LEFT JOIN pg_attrdef expected_default ON expected_default.adrelid=expected.attrelid
        AND expected_default.adnum=expected.attnum
      LEFT JOIN pg_attrdef actual_default ON actual_default.adrelid=actual.attrelid
        AND actual_default.adnum=actual.attnum
      WHERE expected.attrelid='pg_temp.migration_051_canonical'::REGCLASS
        AND expected.attnum>0 AND NOT expected.attisdropped
        AND (actual.attname IS NULL OR actual.attnum<>expected.attnum
          OR actual.atttypid<>expected.atttypid OR actual.atttypmod<>expected.atttypmod
          OR actual.attnotnull<>expected.attnotnull
          OR actual.attidentity<>expected.attidentity OR actual.attgenerated<>expected.attgenerated
          OR actual.attcollation<>expected.attcollation
          OR pg_get_expr(actual_default.adbin,actual_default.adrelid)
            IS DISTINCT FROM pg_get_expr(expected_default.adbin,expected_default.adrelid))
    ) THEN
    RAISE EXCEPTION 'decoder recovery receipt table definition is incompatible' USING ERRCODE='23514';
  END IF;

  IF (SELECT COUNT(*) FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid=receipt_table)<>3
    OR EXISTS (
      SELECT 1
      FROM pg_constraint expected
      FULL JOIN pg_constraint actual ON actual.conrelid=receipt_table
        AND actual.conname=expected.conname
      WHERE expected.conrelid='pg_temp.migration_051_canonical'::REGCLASS
        AND (actual.oid IS NULL OR actual.contype<>expected.contype
          OR actual.convalidated<>expected.convalidated
          OR actual.condeferrable<>expected.condeferrable
          OR actual.condeferred<>expected.condeferred
          OR actual.connoinherit<>expected.connoinherit
          OR pg_get_constraintdef(actual.oid)<>pg_get_constraintdef(expected.oid))
    ) THEN
    RAISE EXCEPTION 'decoder recovery receipt constraint definition is incompatible' USING ERRCODE='23514';
  END IF;

  IF (SELECT COUNT(*) FROM pg_index index_row WHERE index_row.indrelid=receipt_table)<>2
    OR EXISTS (
      SELECT 1
      FROM pg_class expected_class
      JOIN pg_index expected_index ON expected_index.indexrelid=expected_class.oid
      LEFT JOIN pg_class actual_class ON actual_class.relname=expected_class.relname
        AND actual_class.relnamespace=current_schema()::REGNAMESPACE
      LEFT JOIN pg_index actual_index ON actual_index.indexrelid=actual_class.oid
        AND actual_index.indrelid=receipt_table
      WHERE expected_index.indrelid='pg_temp.migration_051_canonical'::REGCLASS
        AND (actual_index.indexrelid IS NULL
          OR actual_class.relkind<>expected_class.relkind
          OR actual_class.relam<>expected_class.relam
          OR actual_class.reloptions IS DISTINCT FROM expected_class.reloptions
          OR actual_index.indisunique<>expected_index.indisunique
          OR actual_index.indnullsnotdistinct<>expected_index.indnullsnotdistinct
          OR actual_index.indisprimary<>expected_index.indisprimary
          OR actual_index.indisexclusion<>expected_index.indisexclusion
          OR actual_index.indimmediate<>expected_index.indimmediate
          OR actual_index.indisclustered<>expected_index.indisclustered
          OR actual_index.indisvalid<>expected_index.indisvalid
          OR actual_index.indisready<>expected_index.indisready
          OR actual_index.indislive<>expected_index.indislive
          OR actual_index.indisreplident<>expected_index.indisreplident
          OR actual_index.indnatts<>expected_index.indnatts
          OR actual_index.indnkeyatts<>expected_index.indnkeyatts
          OR actual_index.indkey<>expected_index.indkey
          OR actual_index.indcollation<>expected_index.indcollation
          OR actual_index.indclass<>expected_index.indclass
          OR actual_index.indoption<>expected_index.indoption
          OR pg_get_expr(actual_index.indexprs,actual_index.indrelid)
            IS DISTINCT FROM pg_get_expr(expected_index.indexprs,expected_index.indrelid)
          OR pg_get_expr(actual_index.indpred,actual_index.indrelid)
            IS DISTINCT FROM pg_get_expr(expected_index.indpred,expected_index.indrelid))
    ) THEN
    RAISE EXCEPTION 'decoder recovery receipt index definition is incompatible' USING ERRCODE='23514';
  END IF;
END;
$migration_051$;

-- Materialize the exact recovery eligibility once, while the worker still owns
-- and validates the immutable snapshot. Heartbeats can then count one bounded
-- scalar query instead of transferring every retained transaction snapshot.
DO $migration_051_eligibility_preflight$
DECLARE eligibility_columns INTEGER;
BEGIN
  LOCK TABLE chain_transaction_inbox IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO eligibility_columns FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname IN ('decoder_quarantine_eligible_at','decoder_recovery_used');
  IF eligibility_columns NOT IN (0,2) THEN
    RAISE EXCEPTION 'decoder quarantine eligibility column is partially installed' USING ERRCODE='23514';
  END IF;
  IF eligibility_columns=2 AND EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname='decoder_quarantine_eligible_at'
      AND (attribute.atttypid<>'timestamp with time zone'::REGTYPE
        OR attribute.atttypmod<>-1 OR attribute.attnotnull
        OR attribute.attgenerated<>'' OR attribute.attidentity<>''
        OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'decoder quarantine eligibility column is incompatible' USING ERRCODE='23514';
  END IF;
  IF eligibility_columns=2 AND NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname='decoder_recovery_used'
      AND attribute.atttypid='boolean'::REGTYPE AND attribute.atttypmod=-1
      AND attribute.attnotnull AND attribute.attgenerated='' AND attribute.attidentity=''
      AND pg_get_expr(attribute_default.adbin,attribute_default.adrelid)='false'
  ) THEN
    RAISE EXCEPTION 'decoder recovery marker column is incompatible' USING ERRCODE='23514';
  END IF;
  IF eligibility_columns=2 AND (
    NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid='chain_transaction_inbox'::REGCLASS
        AND constraint_row.conname='chain_transaction_inbox_decoder_quarantine_eligibility_check'
        AND constraint_row.contype='c' AND constraint_row.convalidated
        AND md5(pg_get_constraintdef(constraint_row.oid))='7c3cea6e97825ab0759cb5b8d02d25ac')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row JOIN pg_proc routine
      ON routine.oid=trigger_row.tgfoid
      WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
        AND trigger_row.tgname='chain_transaction_inbox_decoder_quarantine_drift_trigger'
        AND trigger_row.tgtype=19 AND trigger_row.tgenabled='O'
        AND trigger_row.tgattr=''::INT2VECTOR AND trigger_row.tgqual IS NULL
        AND routine.proname='transaction_inbox_decoder_quarantine_drift_guard'
        AND routine.pronamespace=current_schema()::REGNAMESPACE
        AND routine.pronargs=0 AND routine.prorettype='trigger'::REGTYPE
        AND md5(routine.prosrc)='b189a45ac83ee1da20b524b9888318de')
  ) THEN
    RAISE EXCEPTION 'decoder quarantine eligibility definition is incompatible' USING ERRCODE='23514';
  END IF;
  DROP TABLE IF EXISTS pg_temp.migration_051_eligibility_preflight;
  CREATE TEMP TABLE pg_temp.migration_051_eligibility_preflight (
    first_install BOOLEAN NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_051_eligibility_preflight(first_install)
    VALUES (eligibility_columns=0);
END;
$migration_051_eligibility_preflight$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS decoder_quarantine_eligible_at TIMESTAMPTZ;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS decoder_recovery_used BOOLEAN NOT NULL DEFAULT FALSE;

DO $migration_051_eligibility_constraint$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_051_eligibility_preflight) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_decoder_quarantine_eligibility_check CHECK (
        (decoder_recovery_used=FALSE OR (
          manual_recovery_count BETWEEN 1 AND 2147483647
          AND last_manual_recovery_at IS NOT NULL
        ))
        AND (decoder_quarantine_eligible_at IS NULL OR (
          decoder_recovery_used=FALSE
          AND
          processing_status='FAILED'
          AND error_code='PIPELINE_STAGE_FAILED'
          AND error_name IN (
            'ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED',
            'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_TRUNCATED'
          )
          AND error_retryable=FALSE
          AND retry_exhausted_at IS NULL
          AND processed_at IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
          AND next_attempt_at IS NULL
          AND terminal_at=decoder_quarantine_eligible_at
          AND purge_after=decoder_quarantine_eligible_at+INTERVAL '4 hours'
          AND normalized_transaction IS NOT NULL
          AND immutable_fingerprint ~ '^[0-9a-f]{64}$'
          AND attempts BETWEEN 1 AND 2147483647
          AND attempts_in_cycle BETWEEN 1 AND 100
          AND manual_recovery_count BETWEEN 0 AND 2147483646
        ))
      );
  END IF;
END;
$migration_051_eligibility_constraint$;

CREATE OR REPLACE FUNCTION transaction_inbox_decoder_quarantine_drift_guard()
RETURNS trigger LANGUAGE plpgsql AS $transaction_inbox_decoder_quarantine_drift_guard$
BEGIN
  -- decoder quarantine eligibility v2: recovery use is monotonic and any later
  -- eligibility evidence drift invalidates the one-shot recovery candidate.
  IF OLD.decoder_recovery_used AND NOT NEW.decoder_recovery_used THEN
    RAISE EXCEPTION 'decoder recovery marker is monotonic' USING ERRCODE='23514';
  END IF;
  IF OLD.decoder_quarantine_eligible_at IS NOT NULL
     AND NEW.decoder_quarantine_eligible_at IS NOT NULL
     AND (
       NEW.processing_status IS DISTINCT FROM OLD.processing_status
       OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.error_name IS DISTINCT FROM OLD.error_name
       OR NEW.error_retryable IS DISTINCT FROM OLD.error_retryable
       OR NEW.retry_exhausted_at IS DISTINCT FROM OLD.retry_exhausted_at
       OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
       OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
       OR NEW.purge_after IS DISTINCT FROM OLD.purge_after
       OR NEW.normalized_transaction IS DISTINCT FROM OLD.normalized_transaction
       OR NEW.immutable_fingerprint IS DISTINCT FROM OLD.immutable_fingerprint
       OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.attempts_in_cycle IS DISTINCT FROM OLD.attempts_in_cycle
       OR NEW.manual_recovery_count IS DISTINCT FROM OLD.manual_recovery_count
     ) THEN
    NEW.decoder_quarantine_eligible_at := NULL;
  END IF;
  RETURN NEW;
END;
$transaction_inbox_decoder_quarantine_drift_guard$;

DO $migration_051_eligibility_trigger$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_051_eligibility_preflight) THEN
    CREATE TRIGGER chain_transaction_inbox_decoder_quarantine_drift_trigger
      BEFORE UPDATE ON chain_transaction_inbox
      FOR EACH ROW EXECUTE FUNCTION transaction_inbox_decoder_quarantine_drift_guard();
  END IF;
END;
$migration_051_eligibility_trigger$;

DO $migration_051_eligibility_verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute attribute
      LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
        AND attribute_default.adnum=attribute.attnum
      WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
        AND attribute.attname='decoder_quarantine_eligible_at'
        AND attribute.atttypid='timestamp with time zone'::REGTYPE
        AND attribute.atttypmod=-1 AND NOT attribute.attnotnull
        AND attribute.attgenerated='' AND attribute.attidentity=''
        AND pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NULL)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute attribute
      LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
        AND attribute_default.adnum=attribute.attnum
      WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
        AND attribute.attname='decoder_recovery_used'
        AND attribute.atttypid='boolean'::REGTYPE AND attribute.atttypmod=-1
        AND attribute.attnotnull AND attribute.attgenerated='' AND attribute.attidentity=''
        AND pg_get_expr(attribute_default.adbin,attribute_default.adrelid)='false')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid='chain_transaction_inbox'::REGCLASS
        AND constraint_row.conname='chain_transaction_inbox_decoder_quarantine_eligibility_check'
        AND constraint_row.contype='c' AND constraint_row.convalidated
        AND md5(pg_get_constraintdef(constraint_row.oid))='7c3cea6e97825ab0759cb5b8d02d25ac')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row JOIN pg_proc routine
      ON routine.oid=trigger_row.tgfoid
      WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
        AND trigger_row.tgname='chain_transaction_inbox_decoder_quarantine_drift_trigger'
        AND trigger_row.tgtype=19 AND trigger_row.tgenabled='O'
        AND trigger_row.tgattr=''::INT2VECTOR AND trigger_row.tgqual IS NULL
        AND routine.proname='transaction_inbox_decoder_quarantine_drift_guard'
        AND routine.pronamespace=current_schema()::REGNAMESPACE
        AND routine.pronargs=0 AND routine.prorettype='trigger'::REGTYPE
        AND md5(routine.prosrc)='b189a45ac83ee1da20b524b9888318de') THEN
    RAISE EXCEPTION 'decoder quarantine eligibility definition is incompatible' USING ERRCODE='23514';
  END IF;
END;
$migration_051_eligibility_verify$;

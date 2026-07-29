CREATE TABLE IF NOT EXISTS api_event_stream (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_event_id TEXT UNIQUE NOT NULL,
  domain_event_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'TokenLaunchDetected',
    'TokenMetadataResolved',
    'TokenMetadataFailed',
    'SocialEvidenceCollected',
    'CreatorProfileUpdated',
    'WalletClusterDetected',
    'BondingCurveTradeObserved',
    'BondingCurveStateUpdated',
    'BondingCurveCompleted',
    'QualificationUpdated',
    'PaperPositionOpened',
    'PaperPositionUpdated',
    'PaperPositionClosed',
    'MigrationObserved',
    'PumpSwapPoolActivated'
  )),
  mint TEXT NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')
  ),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  event JSONB NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL,
  UNIQUE(domain_event_id, revision)
);

CREATE TABLE IF NOT EXISTS api_event_stream_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  backfill_completed BOOLEAN NOT NULL DEFAULT FALSE,
  expired_through_sequence BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT api_event_stream_state_expired_sequence_check CHECK (
    expired_through_sequence >= 0
    AND expired_through_sequence <= last_sequence
  )
);
ALTER TABLE api_event_stream_state
  ADD COLUMN IF NOT EXISTS backfill_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE api_event_stream_state
  ADD COLUMN IF NOT EXISTS expired_through_sequence BIGINT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    JOIN pg_class constrained_table
      ON constrained_table.oid = constraint_definition.conrelid
    JOIN pg_namespace constrained_schema
      ON constrained_schema.oid = constrained_table.relnamespace
    WHERE constraint_definition.conname = 'api_event_stream_state_expired_sequence_check'
      AND constrained_table.relname = 'api_event_stream_state'
      AND constrained_schema.nspname = current_schema()
  ) THEN
    ALTER TABLE api_event_stream_state
      ADD CONSTRAINT api_event_stream_state_expired_sequence_check CHECK (
        expired_through_sequence >= 0
        AND expired_through_sequence <= last_sequence
      );
  END IF;
END;
$$;
INSERT INTO api_event_stream_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION enqueue_api_domain_event_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  public_event JSONB;
  next_revision BIGINT;
  allocated_sequence BIGINT;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
    AND NEW.type IS NOT DISTINCT FROM OLD.type
    AND NEW.mint IS NOT DISTINCT FROM OLD.mint
    AND NEW.source IS NOT DISTINCT FROM OLD.source
    AND NEW.program IS NOT DISTINCT FROM OLD.program
    AND NEW.signature IS NOT DISTINCT FROM OLD.signature
    AND NEW.slot IS NOT DISTINCT FROM OLD.slot
    AND NEW.transaction_index IS NOT DISTINCT FROM OLD.transaction_index
    AND NEW.instruction_index IS NOT DISTINCT FROM OLD.instruction_index
    AND NEW.inner_instruction_index IS NOT DISTINCT FROM OLD.inner_instruction_index
    AND NEW.confirmation_status IS NOT DISTINCT FROM OLD.confirmation_status
    AND NEW.blockchain_time IS NOT DISTINCT FROM OLD.blockchain_time
    AND NEW.observed_at IS NOT DISTINCT FROM OLD.observed_at
    AND NEW.payload_version IS NOT DISTINCT FROM OLD.payload_version
    AND NEW.payload IS NOT DISTINCT FROM OLD.payload
  THEN
    RETURN NEW;
  END IF;

  -- Dedicated API outbox sequencing lock: two signed int32 application constants.
  -- Holding this transaction-scoped lock makes identity allocation follow commit order.
  PERFORM pg_advisory_xact_lock(1095782223, 1163281235);

  public_event := jsonb_build_object(
    'eventId', NEW.event_id,
    'type', NEW.type,
    'mint', NEW.mint,
    'source', NEW.source,
    'program', NEW.program,
    'signature', NEW.signature,
    'slot', NEW.slot::text,
    'transactionIndex', NEW.transaction_index,
    'instructionIndex', NEW.instruction_index,
    'innerInstructionIndex', NEW.inner_instruction_index,
    'confirmationStatus', NEW.confirmation_status,
    'blockchainTime', to_jsonb(to_char(
      NEW.blockchain_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )),
    'observedAt', to_jsonb(to_char(
      NEW.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )),
    'payloadVersion', NEW.payload_version,
    'payload', NEW.payload
  );

  EXECUTE format(
    'SELECT COALESCE(MAX(revision), 0) + 1 FROM %I.api_event_stream WHERE domain_event_id = $1',
    TG_TABLE_SCHEMA
  ) INTO next_revision USING NEW.event_id;

  EXECUTE format(
    $sql$
      INSERT INTO %I.api_event_stream (
        stream_event_id, domain_event_id, revision, event_type, mint, confirmation_status,
        payload_version, event, purge_after
      ) VALUES (
        $1 || ':' || $2::text || ':' || $3 || ':' || $4::text || ':' || md5($5::text),
        $1, $2, $6, $7, $3, $4, $5, clock_timestamp() + INTERVAL '4 hours'
      ) ON CONFLICT (domain_event_id, revision) DO NOTHING
      RETURNING sequence
    $sql$,
    TG_TABLE_SCHEMA
  ) INTO allocated_sequence USING
    NEW.event_id,
    next_revision,
    NEW.confirmation_status,
    NEW.payload_version,
    public_event,
    NEW.type,
    NEW.mint;

  IF allocated_sequence IS NOT NULL THEN
    EXECUTE format(
      'UPDATE %I.api_event_stream_state
       SET last_sequence = GREATEST(last_sequence, $1)
       WHERE id = 1',
      TG_TABLE_SCHEMA
    ) USING allocated_sequence;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_api_domain_event_revision_trigger ON domain_events;
CREATE TRIGGER enqueue_api_domain_event_revision_trigger
AFTER INSERT OR UPDATE ON domain_events
FOR EACH ROW EXECUTE FUNCTION enqueue_api_domain_event_revision();

DO $$
DECLARE
  target_schema TEXT := current_schema();
  backfill_done BOOLEAN;
  backfill_purge_after TIMESTAMPTZ;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'A current schema is required for the API event stream backfill.';
  END IF;

  -- Same key pair as the trigger: backfill and live allocation cannot interleave.
  PERFORM pg_advisory_xact_lock(1095782223, 1163281235);

  EXECUTE format(
    'SELECT backfill_completed FROM %I.api_event_stream_state WHERE id = 1',
    target_schema
  ) INTO backfill_done;

  IF NOT backfill_done THEN
    backfill_purge_after := clock_timestamp() + INTERVAL '4 hours';
    EXECUTE format(
      $sql$
        INSERT INTO %1$I.api_event_stream (
          stream_event_id, domain_event_id, revision, event_type, mint, confirmation_status,
          payload_version, event, purge_after
        )
        SELECT
          event_id || ':' || revision::text || ':' || confirmation_status || ':' || payload_version::text
            || ':' || md5(public_event::text),
          event_id,
          revision,
          type,
          mint,
          confirmation_status,
          payload_version,
          public_event,
          $1
        FROM (
          SELECT
            event_id,
            1::BIGINT AS revision,
            type,
            mint,
            confirmation_status,
            payload_version,
            jsonb_build_object(
              'eventId', event_id,
              'type', type,
              'mint', mint,
              'source', source,
              'program', program,
              'signature', signature,
              'slot', slot::text,
              'transactionIndex', transaction_index,
              'instructionIndex', instruction_index,
              'innerInstructionIndex', inner_instruction_index,
              'confirmationStatus', confirmation_status,
              'blockchainTime', to_jsonb(to_char(
                blockchain_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )),
              'observedAt', to_jsonb(to_char(
                observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )),
              'payloadVersion', payload_version,
              'payload', payload
            ) AS public_event
          FROM %1$I.domain_events
          WHERE (purge_after IS NULL OR purge_after > NOW())
            AND type IN (
              'TokenLaunchDetected',
              'TokenMetadataResolved',
              'TokenMetadataFailed',
              'SocialEvidenceCollected',
              'CreatorProfileUpdated',
              'WalletClusterDetected',
              'BondingCurveTradeObserved',
              'BondingCurveStateUpdated',
              'BondingCurveCompleted',
              'QualificationUpdated',
              'PaperPositionOpened',
              'PaperPositionUpdated',
              'PaperPositionClosed',
              'MigrationObserved',
              'PumpSwapPoolActivated'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM %1$I.api_event_stream existing
              WHERE existing.domain_event_id = domain_events.event_id
            )
          ORDER BY created_at, event_id
        ) AS retained_domain_events
        ON CONFLICT (domain_event_id, revision) DO NOTHING
      $sql$,
      target_schema
    ) USING backfill_purge_after;

    EXECUTE format(
      $sql$
        UPDATE %1$I.api_event_stream_state
        SET last_sequence = GREATEST(
              last_sequence,
              COALESCE((SELECT MAX(sequence) FROM %1$I.api_event_stream), 0)
            ),
            backfill_completed = TRUE
        WHERE id = 1
      $sql$,
      target_schema
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS api_event_stream_mint_sequence_idx
  ON api_event_stream(mint, sequence);
CREATE INDEX IF NOT EXISTS api_event_stream_purge_after_idx
  ON api_event_stream(purge_after);

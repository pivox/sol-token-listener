CREATE TABLE IF NOT EXISTS api_event_stream (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_event_id TEXT UNIQUE NOT NULL,
  domain_event_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  event_type TEXT NOT NULL,
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

CREATE OR REPLACE FUNCTION enqueue_api_domain_event_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  public_event JSONB;
  next_revision BIGINT;
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
        $1, $2, $6, $7, $3, $4, $5, NOW() + INTERVAL '4 hours'
      ) ON CONFLICT (domain_event_id, revision) DO NOTHING
    $sql$,
    TG_TABLE_SCHEMA
  ) USING
    NEW.event_id,
    next_revision,
    NEW.confirmation_status,
    NEW.payload_version,
    public_event,
    NEW.type,
    NEW.mint;

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
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'A current schema is required for the API event stream backfill.';
  END IF;

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
        NOW() + INTERVAL '4 hours'
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
  );
END;
$$;

CREATE INDEX IF NOT EXISTS api_event_stream_mint_sequence_idx
  ON api_event_stream(mint, sequence);
CREATE INDEX IF NOT EXISTS api_event_stream_purge_after_idx
  ON api_event_stream(purge_after);

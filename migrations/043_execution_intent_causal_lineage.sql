ALTER TABLE execution_intents
  ADD COLUMN IF NOT EXISTS candidate_id TEXT;

DO $execution_intents_causal_lineage_schema$
DECLARE
  relation_oid OID;
  candidate_attribute RECORD;
  candidate_fk_count INTEGER;
  decision_fk_count INTEGER;
BEGIN
  SELECT relation.oid INTO relation_oid
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname=pg_catalog.current_schema()
    AND relation.relname='execution_intents'
    AND relation.relkind='r';

  SELECT attribute.atttypid,attribute.attnotnull,default_value.oid AS default_oid
  INTO candidate_attribute
  FROM pg_catalog.pg_attribute attribute
  LEFT JOIN pg_catalog.pg_attrdef default_value
    ON default_value.adrelid=attribute.attrelid
      AND default_value.adnum=attribute.attnum
  WHERE attribute.attrelid=relation_oid
    AND attribute.attname='candidate_id'
    AND attribute.attnum>0
    AND NOT attribute.attisdropped;

  IF relation_oid IS NULL
    OR candidate_attribute.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype::OID
    OR candidate_attribute.attnotnull IS DISTINCT FROM FALSE
    OR candidate_attribute.default_oid IS NOT NULL THEN
    RAISE EXCEPTION 'execution_intents causal lineage column has a malformed schema'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint constraint_value
    WHERE constraint_value.conrelid=relation_oid
      AND constraint_value.conname='execution_intents_candidate_id_fkey'
  ) THEN
    ALTER TABLE execution_intents
      ADD CONSTRAINT execution_intents_candidate_id_fkey
      FOREIGN KEY (candidate_id)
      REFERENCES trading_candidates(candidate_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint constraint_value
    WHERE constraint_value.conrelid=relation_oid
      AND constraint_value.conname='execution_intents_decision_event_id_fkey'
  ) THEN
    ALTER TABLE execution_intents
      ADD CONSTRAINT execution_intents_decision_event_id_fkey
      FOREIGN KEY (decision_event_id)
      REFERENCES domain_events(event_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  SELECT COUNT(*)::INTEGER INTO candidate_fk_count
  FROM pg_catalog.pg_constraint constraint_value
  WHERE constraint_value.conrelid=relation_oid
    AND constraint_value.conname='execution_intents_candidate_id_fkey'
    AND constraint_value.contype='f'
    AND constraint_value.confrelid='trading_candidates'::pg_catalog.regclass
    AND constraint_value.confdeltype='r';

  SELECT COUNT(*)::INTEGER INTO decision_fk_count
  FROM pg_catalog.pg_constraint constraint_value
  WHERE constraint_value.conrelid=relation_oid
    AND constraint_value.conname='execution_intents_decision_event_id_fkey'
    AND constraint_value.contype='f'
    AND constraint_value.confrelid='domain_events'::pg_catalog.regclass
    AND constraint_value.confdeltype='r';

  IF candidate_fk_count<>1 OR decision_fk_count<>1 THEN
    RAISE EXCEPTION 'execution_intents causal lineage constraints have a malformed schema'
      USING ERRCODE='55000';
  END IF;
END
$execution_intents_causal_lineage_schema$;

WITH valid_lineage AS (
  SELECT intent.id,MIN(candidate.candidate_id) AS candidate_id
  FROM execution_intents AS intent
  JOIN domain_events AS decision
    ON decision.event_id=intent.decision_event_id
  JOIN trading_candidates AS candidate
    ON candidate.candidate_id=decision.payload #>> '{session,candidateId}'
  JOIN qualification_reports AS report
    ON report.report_id=candidate.report_id
  JOIN domain_events AS source
    ON source.event_id=candidate.source_event_id
  JOIN domain_events AS candidate_event
    ON candidate_event.event_id=candidate.candidate_event_id
  JOIN domain_events AS qualification
    ON qualification.event_id=report.qualification_event_id
  JOIN raw_chain_events AS source_raw
    ON source_raw.event_id=report.source_raw_event_id
  JOIN paper_positions AS position
    ON position.position_id=intent.position_id
  WHERE intent.candidate_id IS NULL
    AND intent.side='BUY'
    AND intent.venue_policy='PUMP_FUN_ONLY'
    AND decision.type='PaperStrategySessionUpdated'
    AND decision.source='paper-decision'
    AND decision.mint=intent.mint
    AND decision.confirmation_status='finalized'
    AND decision.raw_event_id=report.source_raw_event_id
    AND decision.payload #>> '{session,qualificationReportId}'=report.report_id
    AND decision.payload #>> '{session,positionId}'=intent.position_id
    AND decision.payload #>> '{session,mint}'=intent.mint
    AND candidate.mint=intent.mint
    AND candidate.strategy_id=intent.strategy_id
    AND candidate.strategy_version=intent.strategy_version
    AND candidate.state='ELIGIBLE'
    AND candidate.confirmation_status='finalized'
    AND candidate.superseded_at IS NULL
    AND candidate.payload #>> '{id}'=candidate.candidate_id
    AND candidate.payload #>> '{qualificationReportId}'=report.report_id
    AND candidate.payload #>> '{mint}'=intent.mint
    AND report.mint=intent.mint
    AND report.confirmation_status='finalized'
    AND report.superseded_at IS NULL
    AND source.event_id=report.source_event_id
    AND source.raw_event_id=report.source_raw_event_id
    AND source.mint=intent.mint
    AND source.confirmation_status='finalized'
    AND candidate_event.raw_event_id=report.source_raw_event_id
    AND candidate_event.type='TradingCandidateUpdated'
    AND candidate_event.source='paper-decision'
    AND candidate_event.mint=intent.mint
    AND candidate_event.confirmation_status='finalized'
    AND qualification.raw_event_id=report.source_raw_event_id
    AND qualification.type='QualificationUpdated'
    AND qualification.mint=intent.mint
    AND qualification.confirmation_status='finalized'
    AND source_raw.mint=intent.mint
    AND source_raw.confirmation_status='finalized'
    AND source_raw.processing_status='processed'
    AND position.mint=intent.mint
    AND position.candidate_id=candidate.candidate_id
    AND position.qualification_report_id=report.report_id
    AND position.trigger_event_id=report.qualification_event_id
  GROUP BY intent.id
  HAVING COUNT(*)=1
)
UPDATE execution_intents AS intent
SET candidate_id=candidate.candidate_id
FROM valid_lineage AS candidate
WHERE intent.id=candidate.id
  AND intent.candidate_id IS NULL;

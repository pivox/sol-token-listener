type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ExecutionIntentLineageTransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

export type ExecutionIntentLineageRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'LINEAGE_INVALID'
  | 'DATABASE_FAILURE';

export class ExecutionIntentLineageRepositoryError extends Error {
  public constructor(
    public readonly code: ExecutionIntentLineageRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super('Execution intent causal lineage is invalid.', options);
    this.name = 'ExecutionIntentLineageRepositoryError';
  }
}

export const EXECUTION_INTENT_CURRENT_LINEAGE_SQL = `SELECT EXISTS (
  SELECT 1
  FROM execution_intents AS intent
  JOIN trading_candidates AS candidate
    ON candidate.candidate_id=intent.candidate_id
  JOIN qualification_reports AS report
    ON report.report_id=candidate.report_id
  JOIN domain_events AS decision
    ON decision.event_id=intent.decision_event_id
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
  WHERE intent.id=$1
    AND intent.candidate_id IS NOT NULL
    AND intent.side='BUY'
    AND intent.venue_policy='PUMP_FUN_ONLY'
    AND decision.type='PaperStrategySessionUpdated'
    AND decision.source='paper-decision'
    AND decision.mint=intent.mint
    AND decision.confirmation_status='finalized'
    AND decision.raw_event_id=report.source_raw_event_id
    AND decision.payload #>> '{session,candidateId}'=intent.candidate_id
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
    AND position.candidate_id=intent.candidate_id
    AND position.qualification_report_id=report.report_id
    AND position.trigger_event_id=report.qualification_event_id
) AS lineage_current`;

export async function assertExecutionIntentLineageCurrentInTransaction(
  client: ExecutionIntentLineageTransactionClient,
  intentId: string,
): Promise<void> {
  if (!/^execution_intent_[0-9a-f]{64}$/u.test(intentId)) {
    throw new ExecutionIntentLineageRepositoryError('INVALID_INPUT');
  }
  let result: QueryResult;
  try {
    result = await client.query(EXECUTION_INTENT_CURRENT_LINEAGE_SQL, [intentId]);
  } catch (error: unknown) {
    throw new ExecutionIntentLineageRepositoryError('DATABASE_FAILURE', { cause: error });
  }
  const value = result.rows[0]?.lineage_current;
  if (result.rowCount !== 1 || result.rows.length !== 1 || value !== true) {
    throw new ExecutionIntentLineageRepositoryError('LINEAGE_INVALID');
  }
}

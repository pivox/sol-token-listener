interface EvidenceClient {
  query(sql: string, values?: readonly unknown[]): Promise<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
  }>;
}

/** Called on the repository's existing REPEATABLE READ client, never a new connection. */
export async function loadPaperMvpCausalEvidence(
  client: EvidenceClient, positionId: string,
): Promise<unknown> {
  const result = await client.query(CAUSAL_EVIDENCE_SQL, [positionId]);
  return result.rows[0]?.evidence ?? null;
}

const CAUSAL_EVIDENCE_SQL = `SELECT jsonb_build_object(
  'schemaVersion','paper-mvp-causal-evidence.v1',
  'positionId',p.position_id,'mint',p.mint,'quoteMint',p.quote_mint,
  'creator',launch.creator,'sessionId',s.session_id,
  'qualification',jsonb_build_object(
    'reportId',q.report_id,'profileId',q.profile_id,'profileVersion',q.profile_version,
    'profileFingerprint',q.profile_fingerprint,'verdict',q.verdict,
    'blockers',jsonb_path_query_array(q.payload,'$.blockers[*].code'),
    'reasonCodes',jsonb_path_query_array(q.payload,'$.conditions[*].code'),
    'candidateReasonCodes',candidate.reason_codes
  ),
  'buy',jsonb_build_object(
    'tradeId',buy.trade_id,'quoteId',buy.quote_id,
    'observedSlot',buy.payload #>> '{quote,observedSlot,$solTokenListenerBigInt}',
    'quoteObservedAtMs',(EXTRACT(EPOCH FROM buy.quote_observed_at)*1000)::BIGINT,
    'createdAtMs',(EXTRACT(EPOCH FROM buy.created_at)*1000)::BIGINT,
    'decisionCursor',jsonb_build_object('slot',s.entry_slot::TEXT,
      'transactionIndex',s.entry_transaction_index,'instructionIndex',s.entry_instruction_index,
      'innerInstructionIndex',s.entry_inner_instruction_index),
    'boundary',CASE WHEN s.entry_boundary_slot IS NULL THEN NULL ELSE jsonb_build_object(
      'kind','PAPER_BUY_QUOTE_SLOT','slot',s.entry_boundary_slot::TEXT,
      'quoteId',s.entry_boundary_quote_id,
      'observedAtMs',(EXTRACT(EPOCH FROM s.entry_boundary_observed_at)*1000)::BIGINT
    ) END
  ),
  'externalUniqueBuyers',jsonb_build_object(
    'target',s.external_buy_target,'count',s.external_buy_count,
    'minimumQuoteAmountRaw',s.payload #>> '{externalMinimumBuyAmountRaw,$solTokenListenerBigInt}',
    'minimumConfirmation',s.minimum_confirmation,
    'countedTradeIds',s.payload->'countedTradeIds','countedWallets',s.payload->'countedBuyerWallets',
    'progression',COALESCE(buyers.progression,'[]'::jsonb)
  ),
  'sell',jsonb_build_object(
    'tradeId',sell.trade_id,'quoteId',sell.quote_id,
    'createdAtMs',(EXTRACT(EPOCH FROM sell.created_at)*1000)::BIGINT,
    'closeEvent',jsonb_build_object('id',closed.event_id,'type',closed.type,
      'cursor',jsonb_build_object('slot',closed.slot::TEXT,
        'transactionIndex',closed.transaction_index,'instructionIndex',closed.instruction_index,
        'innerInstructionIndex',closed.inner_instruction_index),
      'confirmationStatus',closed.confirmation_status,
      'observedAtMs',(EXTRACT(EPOCH FROM closed.observed_at)*1000)::BIGINT)
  ),
  'recovery',jsonb_build_object('sessionState',s.state,
    'pendingExitReason',s.payload->>'pendingExitReason','lastErrorCode',s.payload #>> '{lastError,code}',
    'quoteWaitHistory','UNAVAILABLE')
) AS evidence
FROM paper_positions p
JOIN token_launches launch ON launch.mint=p.mint
JOIN paper_strategy_sessions s ON s.session_id=p.strategy_session_id
  AND s.position_id=p.position_id AND s.mint=p.mint AND s.quote_mint=p.quote_mint
  AND s.report_id=p.qualification_report_id AND s.candidate_id=p.candidate_id
  AND s.strategy_id=p.strategy_id AND s.strategy_version=p.strategy_version
  AND s.payload_version=2 AND octet_length(s.payload::TEXT)<=1048576
JOIN trading_candidates candidate ON candidate.candidate_id=s.candidate_id
  AND candidate.report_id=s.report_id AND candidate.mint=p.mint AND candidate.quote_mint=p.quote_mint
  AND candidate.state='ELIGIBLE' AND candidate.confirmation_status IN ('confirmed','finalized')
JOIN qualification_reports q ON q.report_id=s.report_id AND q.mint=p.mint
  AND q.confirmation_status IN ('confirmed','finalized') AND octet_length(q.payload::TEXT)<=262144
  AND q.payload #>> '{ruleSet,id}'=q.profile_id
  AND q.payload #>> '{ruleSet,version}'=q.profile_version::TEXT
  AND q.payload #>> '{ruleSet,fingerprint}'=q.profile_fingerprint
  AND q.payload->>'verdict'=q.verdict
  AND jsonb_typeof(q.payload->'blockers')='array'
  AND jsonb_typeof(q.payload->'conditions')='array'
  AND jsonb_array_length(q.payload->'blockers')
    =jsonb_array_length(jsonb_path_query_array(q.payload,'$.blockers[*].code'))
  AND jsonb_array_length(q.payload->'conditions')
    =jsonb_array_length(jsonb_path_query_array(q.payload,'$.conditions[*].code'))
JOIN domain_events qualification_source ON qualification_source.event_id=q.source_event_id
  AND qualification_source.mint=p.mint
  AND qualification_source.confirmation_status IN ('confirmed','finalized')
JOIN raw_chain_events qualification_raw ON qualification_raw.event_id=q.source_raw_event_id
  AND qualification_raw.confirmation_status IN ('confirmed','finalized')
JOIN paper_trades buy ON buy.trade_id=p.entry_trade_id AND buy.position_id=p.position_id AND buy.side='BUY'
  AND buy.input_mint=p.quote_mint AND buy.output_mint=p.mint
  AND q.evaluated_at<=buy.created_at
JOIN paper_trades sell ON sell.trade_id=p.exit_trade_id AND sell.position_id=p.position_id AND sell.side='SELL'
  AND sell.input_mint=p.mint AND sell.output_mint=p.quote_mint
JOIN domain_events closed ON closed.event_id=p.close_event_id AND closed.mint=p.mint
  AND closed.source='paper-trading'
  AND closed.payload #>> '{position,id}'=p.position_id
  AND closed.payload #>> '{trade,id}'=sell.trade_id
  AND closed.payload #>> '{trade,positionId}'=p.position_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'count',bounded.ordinal,'tradeId',bounded.trade_id,'wallet',bounded.trader,
    'sourceEventId',bounded.source_event_id,
    'cursor',jsonb_build_object('slot',bounded.slot::TEXT,
      'transactionIndex',bounded.transaction_index,'instructionIndex',bounded.instruction_index,
      'innerInstructionIndex',bounded.inner_instruction_index),
    'confirmationStatus',bounded.current_confirmation,'quoteAmountRaw',bounded.quote_amount_raw::TEXT,
    'observedAtMs',(EXTRACT(EPOCH FROM bounded.observed_at)*1000)::BIGINT
  ) ORDER BY bounded.ordinal) AS progression
  FROM (
    SELECT e.*,event.confirmation_status AS current_confirmation,
      ROW_NUMBER() OVER (ORDER BY e.slot,e.transaction_index,e.instruction_index,
        COALESCE(e.inner_instruction_index,-1),e.trade_id) AS ordinal
    FROM paper_external_buy_events e
    JOIN domain_events event ON event.event_id=e.source_event_id AND event.mint=e.mint
      AND event.type='PaperExternalBuyCounted' AND event.source='paper-decision'
      AND event.payload->>'sessionId'=e.session_id AND event.payload->>'tradeId'=e.trade_id
      AND event.slot=e.slot AND event.transaction_index=e.transaction_index
      AND event.instruction_index=e.instruction_index
      AND event.inner_instruction_index IS NOT DISTINCT FROM e.inner_instruction_index
      AND event.confirmation_status IN ('confirmed','finalized')
    JOIN raw_chain_events raw ON raw.event_id=event.raw_event_id AND raw.mint=e.mint
      AND raw.slot=e.slot AND raw.transaction_index=e.transaction_index
      AND raw.instruction_index=e.instruction_index
      AND raw.inner_instruction_index IS NOT DISTINCT FROM e.inner_instruction_index
      AND raw.confirmation_status IN ('confirmed','finalized')
    WHERE e.session_id=s.session_id AND e.mint=p.mint AND e.quote_mint=p.quote_mint
      AND e.strategy_id='creation-entry-v1' AND e.payload_version=2
      AND s.payload->'countedTradeIds' ? e.trade_id
    ORDER BY e.slot,e.transaction_index,e.instruction_index,
      COALESCE(e.inner_instruction_index,-1),e.trade_id
    LIMIT 1001
  ) bounded
) buyers ON TRUE
WHERE p.position_id=$1 AND p.status='PAPER_CLOSED'
  AND p.strategy_id='creation-entry-v1' AND p.strategy_version=1`;

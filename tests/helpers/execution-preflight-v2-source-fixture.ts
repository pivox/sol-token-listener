import type pg from 'pg';
import { createExecutionDryRunAssessment } from '../../src/domain/execution-dry-run.js';
import { createExecutionIntentDraft } from '../../src/domain/execution-intent.js';
import { createExecutionPreflightIntentPairDraft } from '../../src/domain/execution-preflight-intent-pair.js';
import { createExecutionPreflightPreparationIdentity } from '../../src/domain/execution-preflight-preparation.js';
import { createProviderUsageSnapshot } from '../../src/domain/execution-provider-quota.js';
import { createExecutionWalletGeneration } from '../../src/domain/execution-readiness.js';
import { createExecutionSimulationArtifact, createExecutionSimulationArtifactDraft } from '../../src/domain/execution-simulation.js';
import { createExecutionWalletSnapshot } from '../../src/domain/execution-wallet-snapshot.js';

export interface LiveSourceFixture {
  readonly runId: string;
  readonly pairId: string;
  readonly targetIntentId: string;
  readonly simulationIntentId: string;
  readonly candidateId: string;
  readonly artifactFingerprint: string;
  readonly expiresAtMs: number;
}

export async function seedCanonicalV2Source(
  pool: InstanceType<typeof pg.Pool>,
): Promise<LiveSourceFixture> {
  const nowMs = Date.now();
  const createdAtMs = nowMs - 120_000;
  const completedAtMs = nowMs - 2_000;
  const expiresAtMs = nowMs + 120_000;
  const mint = '11111111111111111111111111111111';
  const walletPublicKey = '11111111111111111111111111111111';
  const quoteMint = 'So11111111111111111111111111111111111111112';
  const candidateId = `candidate_${'a'.repeat(64)}`;
  const reportId = `qreport_${'b'.repeat(64)}`;
  const rawEventId = 'raw-h2h-v2-integration';
  const qualificationEventId = 'qualification-h2h-v2-integration';
  const candidateEventId = 'candidate-h2h-v2-integration';
  const decisionEventId = 'decision-h2h-v2-integration';
  const positionId = 'position-h2h-v2-integration';
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey, cluster: 'mainnet-beta', genesisHash: walletPublicKey, generation: 1,
  }));
  const wallet = createExecutionWalletSnapshot(Object.freeze({
    generationId: generation.generationId, providerId: 'primary',
    stateRevision: 0n, slot: 123n, blockTimeMs: completedAtMs - 1_000,
    observedAtMs: completedAtMs, commitment: 'finalized', walletLamports: 1_000_000n,
    tokenBalanceCount: 0, openPositions: Object.freeze([]), realizedNetPnlRaw: 0n,
  }));
  const provider = createProviderUsageSnapshot(Object.freeze({
    providerId: 'primary', planId: 'integration-plan',
    billingPeriodId: 'integration-period', billingPeriodStartedAtMs: createdAtMs - 60_000,
    billingPeriodEndsAtMs: expiresAtMs + 600_000, limitUnits: 1_000n, usedUnits: 1n,
    measuredAtMs: completedAtMs, expiresAtMs, provenance: 'OPERATOR_REPORT',
  }));
  const targetDraft = createExecutionIntentDraft(Object.freeze({
    strategyId: 'creation-entry-v1', strategyVersion: 1, positionId, candidateId,
    logicalCommandId: `paper_open_${'c'.repeat(64)}`, mint, side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY', quoteMint, quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 10_000n, baseAmountRaw: null,
    minimumAmountOutRaw: 1n, decisionEventId, decisionFingerprint: 'd'.repeat(64),
    requestedAtMs: createdAtMs, expiresAtMs,
  }));
  const target = Object.freeze({ ...targetDraft, status: 'PENDING' as const,
    attemptCount: 0, stateRevision: 0n, lastReasonCode: null, terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null, createdAtMs, updatedAtMs: createdAtMs });
  const pair = createExecutionPreflightIntentPairDraft(targetDraft);
  const simulation = Object.freeze({ ...pair.simulationIntent, status: 'SUCCEEDED' as const,
    attemptCount: 1, stateRevision: 3n, lastReasonCode: 'INTENT_SUCCEEDED' as const,
    terminalAtMs: completedAtMs, reconciliationCompletedAtMs: completedAtMs,
    purgeAfterMs: completedAtMs + 14_400_000, createdAtMs, updatedAtMs: completedAtMs });
  const assessmentDraft = createExecutionDryRunAssessment(target);
  const assessment = Object.freeze({ ...assessmentDraft, recordedAtMs: completedAtMs - 1_000 });
  const artifact = createExecutionSimulationArtifact(
    createExecutionSimulationArtifactDraft(Object.freeze({
      intentId: simulation.id, attemptNumber: 1, intentStateRevision: simulation.stateRevision,
      strategyId: simulation.strategyId, strategyVersion: simulation.strategyVersion,
      decisionFingerprint: simulation.decisionFingerprint, resultKind: 'SUCCESS',
      effectiveVenue: 'PUMP_FUN', providerId: provider.providerId, executorPublicKey: walletPublicKey,
      expectedGenesisHash: walletPublicKey, observedGenesisHash: walletPublicKey,
      configurationFingerprint: '1'.repeat(64), quoteFingerprint: '2'.repeat(64),
      snapshotFingerprint: '3'.repeat(64), buildFingerprint: '1'.repeat(64),
      messageHash: '5'.repeat(64), blockhash: walletPublicKey,
      lastValidBlockHeight: 1_000n, blockhashContextSlot: 900n, snapshotSlot: 899n,
      feeContextSlot: 900n, simulationSlot: 901n, amountInRaw: 10_000n,
      expectedAmountOutRaw: 9_000n, protectedAmountOutRaw: 8_500n, feesRaw: 100n,
      estimatedFeeLamports: 5_000n, simulatedFeePayerLamportDebit: 5_100n,
      unitsConsumed: 200_000n, simulatedBaseDeltaRaw: 9_000n,
      simulatedQuoteDeltaRaw: -10_000n, rpcCallsUsed: 5, rpcCallsLimit: 8,
      quoteStatus: 'SUCCEEDED', buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED',
      failureStage: null, failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
      logsFingerprint: '6'.repeat(64), logsLineCount: 1,
    })), completedAtMs,
  );
  const preparation = createExecutionPreflightPreparationIdentity(
    '00000000-0000-4000-8000-000000000001',
  );
  const toDate = (value: number): Date => new Date(value);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await client.query(`INSERT INTO token_launches (
      mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
      created_signature,created_slot,created_transaction_index,created_instruction_index,
      detected_at,updated_at
    ) VALUES ($1,'pumpfun','pumpfun','creator','SPL_TOKEN','[]','OBSERVING',
      'signature-h2h-v2',1,0,0,$2,$2)`, [mint, toDate(createdAtMs)]);
    await client.query(`INSERT INTO raw_chain_events (
      event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload,processing_status
    ) VALUES ($1,'pumpfun','pumpfun',$2,'signature-h2h-v2',1,0,0,'finalized',$3,1,'{}','processed')`,
    [rawEventId, mint, toDate(createdAtMs)]);
    for (const event of [
      [qualificationEventId, 'QualificationUpdated', 'qualification', Object.freeze({})],
      [candidateEventId, 'TradingCandidateUpdated', 'paper-decision', Object.freeze({})],
      [decisionEventId, 'PaperStrategySessionUpdated', 'paper-decision', Object.freeze({
        session: Object.freeze({ candidateId, qualificationReportId: reportId, positionId, mint }),
      })],
    ] as const) {
      await client.query(`INSERT INTO domain_events (
        event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
        instruction_index,confirmation_status,observed_at,payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,'pumpfun','signature-h2h-v2',1,0,0,'finalized',$6,1,$7)`,
      [event[0], rawEventId, event[1], mint, event[2], toDate(createdAtMs),
        JSON.stringify(event[3])]);
    }
    await client.query(`INSERT INTO qualification_reports (
      report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
      profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
      preparation_score,social_score,onchain_score,total_score,as_of_slot,
      as_of_transaction_index,as_of_instruction_index,confirmation_status,evaluated_at,
      purge_after,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$3,'profile',1,repeat('7',64),repeat('8',64),'QUALIFIED',
      15,25,60,100,1,0,0,'finalized',$5,$6,1,'{}')`,
    [reportId, mint, qualificationEventId, rawEventId, toDate(createdAtMs),
      toDate(createdAtMs + 14_400_000)]);
    await client.query(`INSERT INTO trading_candidates (
      candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
      strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
      quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
      purge_after,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,1,repeat('9',64),'finalized','ELIGIBLE',$7,9,
      'SPL_TOKEN','["QUALIFIED_ENTRY"]',$8,$9,$10,1,$11)`, [
      candidateId, mint, reportId, qualificationEventId, candidateEventId,
      target.strategyId, quoteMint, toDate(expiresAtMs), toDate(createdAtMs),
      toDate(createdAtMs + 14_400_000), JSON.stringify({ id: candidateId,
        qualificationReportId: reportId, mint }),
    ]);
    await client.query(`INSERT INTO paper_positions (
      position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
      strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
      round_trip_loss_bps,entry_trade_id,open_command_hash,trigger_event_id,payload_version,
      payload,opened_at,strategy_session_id,qualification_report_id,candidate_id
    ) VALUES ($1,$2,$3,9,'SPL_TOKEN',$4,1,'PAPER_HOLDING',1,1,1,0,$5,$6,$7,1,'{}',$8,$9,$10,$11)`, [
      positionId, mint, quoteMint, target.strategyId, `paper_trade_${'a'.repeat(64)}`,
      `paper_open_command_${'b'.repeat(64)}`, qualificationEventId, toDate(createdAtMs),
      'paper-session-h2h-v2', reportId, candidateId,
    ]);
    await insertLiveIntent(client, target);
    await insertLiveIntent(client, simulation);
    await client.query(`INSERT INTO execution_preflight_intent_pairs (
      pair_id,payload_version,pair_fingerprint,target_intent_id,simulation_intent_id,
      decision_event_id,decision_fingerprint,created_at,expires_at,purge_after
    ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      pair.pairId, pair.pairFingerprint, target.id, simulation.id, decisionEventId,
      target.decisionFingerprint, toDate(createdAtMs), toDate(expiresAtMs),
      toDate(expiresAtMs + 14_400_000),
    ]);
    await client.query(`INSERT INTO execution_preflight_intent_pair_memberships
      (pair_id,intent_id,lane) VALUES ($1,$2,'TARGET'),($1,$3,'SIMULATION')`,
    [pair.pairId, target.id, simulation.id]);
    await client.query(`INSERT INTO execution_dry_run_assessments (
      assessment_id,payload_version,specification_version,evaluator_version,intent_id,
      strategy_id,strategy_version,decision_fingerprint,intent_state_revision,intent_status,
      input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,
      simulation_status,signature_status,submission_status,recorded_at
    ) VALUES ($1,1,$2,1,$3,$4,1,$5,0,'PENDING',$6,$7,'FOUNDATION_VALIDATED',
      'INTENT_AND_LEASE_ONLY','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN',$8)`, [
      assessment.assessmentId, assessment.specificationVersion, target.id, target.strategyId,
      target.decisionFingerprint, assessment.inputFingerprint, assessment.resultFingerprint,
      toDate(assessment.recordedAtMs),
    ]);
    await client.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,effective_venue,provider_id,started_at,completed_at,reason_code
    ) VALUES ($1,1,'COMPLETED','PUMP_FUN',$2,$3,$4,'ATTEMPT_COMPLETED')`, [
      simulation.id, provider.providerId, toDate(completedAtMs - 1_000), toDate(completedAtMs),
    ]);
    await insertSimulationArtifact(client, artifact);
    await client.query(`INSERT INTO execution_wallet_generations (
      generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation,created_at
    ) VALUES ($1,1,$2,'mainnet-beta',$3,1,$4)`, [
      generation.generationId, generation.walletPublicKey, generation.genesisHash,
      toDate(createdAtMs),
    ]);
    await client.query(`INSERT INTO execution_wallet_snapshots (
      snapshot_id,payload_version,snapshot_fingerprint,generation_id,provider_id,state_revision,
      slot,block_time,observed_at,commitment,wallet_lamports,token_balance_count,open_positions,
      realized_net_pnl_raw
    ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,'finalized',$9,0,0,0)`, [
      wallet.snapshotId, wallet.snapshotFingerprint, wallet.generationId, wallet.providerId,
      wallet.stateRevision.toString(), wallet.slot.toString(), toDate(wallet.blockTimeMs ?? 0),
      toDate(wallet.observedAtMs), wallet.walletLamports.toString(),
    ]);
    await client.query(`INSERT INTO execution_provider_usage_snapshots (
      snapshot_id,payload_version,snapshot_fingerprint,provider_id,plan_id,billing_period_id,
      billing_period_started_at,billing_period_ends_at,limit_units,used_units,measured_at,
      expires_at,provenance
    ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      provider.snapshotId, provider.snapshotFingerprint, provider.providerId, provider.planId,
      provider.billingPeriodId, toDate(provider.billingPeriodStartedAtMs),
      toDate(provider.billingPeriodEndsAtMs), provider.limitUnits.toString(),
      provider.usedUnits.toString(), toDate(provider.measuredAtMs), toDate(provider.expiresAtMs),
      provider.provenance,
    ]);
    await client.query(`INSERT INTO execution_preflight_intent_preparation_runs (
      run_id,payload_version,run_fingerprint,state,state_revision,watermark_at,deadline_at,
      pair_id,assessment_id,assessment_fingerprint,artifact_id,artifact_fingerprint,
      manifest_fingerprint,created_at,updated_at,selected_at,completed_at,purge_after
    ) VALUES ($1,1,$2,'PREPARED',4,$3,$4,$5,$6,$7,$8,$9,repeat('e',64),$3,$10,$3,$10,$11)`, [
      preparation.runId, preparation.runFingerprint, toDate(createdAtMs), toDate(expiresAtMs),
      pair.pairId, assessment.assessmentId, assessment.resultFingerprint, artifact.artifactId,
      artifact.resultFingerprint, toDate(completedAtMs), toDate(completedAtMs + 14_400_000),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve primary failure */ }
    throw error;
  } finally { client.release(); }
  return Object.freeze({ runId: preparation.runId, pairId: pair.pairId,
    targetIntentId: target.id, simulationIntentId: simulation.id, candidateId,
    artifactFingerprint: artifact.resultFingerprint, expiresAtMs });
}

async function insertLiveIntent(
  client: pg.PoolClient,
  intent: ReturnType<typeof createExecutionIntentDraft> & Readonly<{
    status: 'PENDING' | 'SUCCEEDED';
    attemptCount: number;
    stateRevision: bigint;
    lastReasonCode: null | 'INTENT_SUCCEEDED';
    terminalAtMs: number | null;
    reconciliationCompletedAtMs: number | null;
    purgeAfterMs: number | null;
    createdAtMs: number;
    updatedAtMs: number;
  }>,
): Promise<void> {
  await client.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,candidate_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,quote_decimals,
    quote_amount_raw,base_amount_raw,minimum_amount_out_raw,decision_event_id,
    decision_fingerprint,requested_at,expires_at,status,attempt_count,state_revision,
    last_reason_code,terminal_at,reconciliation_completed_at,purge_after,created_at,updated_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
    $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`, [
    intent.id, intent.logicalOrderKey, intent.strategyId, intent.strategyVersion,
    intent.positionId, intent.candidateId, intent.logicalCommandId, intent.mint, intent.side,
    intent.venuePolicy, intent.quoteMint, intent.quoteTokenProgram, intent.quoteDecimals,
    bigintText(intent.quoteAmountRaw), bigintText(intent.baseAmountRaw),
    intent.minimumAmountOutRaw.toString(), intent.decisionEventId, intent.decisionFingerprint,
    new Date(intent.requestedAtMs), new Date(intent.expiresAtMs), intent.status,
    intent.attemptCount, intent.stateRevision.toString(), intent.lastReasonCode,
    intent.terminalAtMs === null ? null : new Date(intent.terminalAtMs),
    intent.reconciliationCompletedAtMs === null
      ? null : new Date(intent.reconciliationCompletedAtMs),
    intent.purgeAfterMs === null ? null : new Date(intent.purgeAfterMs),
    new Date(intent.createdAtMs), new Date(intent.updatedAtMs),
  ]);
}

async function insertSimulationArtifact(
  client: pg.PoolClient,
  artifact: ReturnType<typeof createExecutionSimulationArtifact>,
): Promise<void> {
  await client.query(`INSERT INTO execution_simulation_artifacts (
    artifact_id,payload_version,specification_version,evaluator_version,intent_id,
    attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
    result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
    observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
    build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
    snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
    protected_amount_out_raw,fees_raw,estimated_fee_lamports,simulated_fee_payer_lamport_debit,
    units_consumed,simulated_base_delta_raw,simulated_quote_delta_raw,rpc_calls_used,
    rpc_calls_limit,quote_status,build_status,simulation_status,failure_stage,failure_code,
    terminal_reason_code,logs_fingerprint,logs_line_count,result_fingerprint,recorded_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
    $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
    $39,$40,$41,$42,$43,$44,$45,$46,$47,$48)`, [
    artifact.artifactId, artifact.payloadVersion, artifact.specificationVersion,
    artifact.evaluatorVersion, artifact.intentId, artifact.attemptNumber,
    artifact.intentStateRevision.toString(), artifact.strategyId, artifact.strategyVersion,
    artifact.decisionFingerprint, artifact.resultKind, artifact.effectiveVenue,
    artifact.providerId, artifact.executorPublicKey, artifact.expectedGenesisHash,
    artifact.observedGenesisHash, artifact.configurationFingerprint, artifact.quoteFingerprint,
    artifact.snapshotFingerprint, artifact.buildFingerprint, artifact.messageHash,
    artifact.blockhash, bigintText(artifact.lastValidBlockHeight),
    bigintText(artifact.blockhashContextSlot), bigintText(artifact.snapshotSlot),
    bigintText(artifact.feeContextSlot), bigintText(artifact.simulationSlot),
    bigintText(artifact.amountInRaw), bigintText(artifact.expectedAmountOutRaw),
    bigintText(artifact.protectedAmountOutRaw), bigintText(artifact.feesRaw),
    bigintText(artifact.estimatedFeeLamports), bigintText(artifact.simulatedFeePayerLamportDebit),
    bigintText(artifact.unitsConsumed), bigintText(artifact.simulatedBaseDeltaRaw),
    bigintText(artifact.simulatedQuoteDeltaRaw), artifact.rpcCallsUsed, artifact.rpcCallsLimit,
    artifact.quoteStatus, artifact.buildStatus, artifact.simulationStatus, artifact.failureStage,
    artifact.failureCode, artifact.terminalReasonCode, artifact.logsFingerprint,
    artifact.logsLineCount, artifact.resultFingerprint, new Date(artifact.recordedAtMs),
  ]);
}

export async function mutateWithTriggersDisabled(
  pool: InstanceType<typeof pg.Pool>,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await client.query(text, [...values]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve primary failure */ }
    throw error;
  } finally { client.release(); }
}

function bigintText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

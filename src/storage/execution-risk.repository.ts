import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createProviderUsageOperationId,
  createProviderUsageSnapshot,
  evaluateProviderQuota,
  type ProviderUsageSnapshotV1,
} from '../domain/execution-provider-quota.js';
import { assertExecutionIntent, type ExecutionIntentV1 } from '../domain/execution-intent.js';
import {
  classifyExecutionFault,
  type ExecutionRetryDecision,
} from '../domain/execution-fault-policy.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import {
  createExecutionRiskPolicy,
  evaluateBuyRisk,
  type ExecutionRiskPolicyV1,
  type ExecutionTechnicalFailureReasonCode,
} from '../domain/execution-risk-policy.js';
import type {
  ExecutionBuyAdmissionInputV1,
  ExecutionBuyAdmissionResultV1,
  ExecutionFaultRecordInputV1,
  ExecutionFaultRecordResultV1,
  ExecutionReconciliationCommitResultV1,
  ExecutionReconciliationCommitV1,
  ExecutionReconciledSuccessInputV1,
  ExecutionRiskRepository,
  ProviderRateLimitEventV1,
  ProviderUsageOperationV1,
  WalletGenerationDraftV1,
  WalletGenerationV1,
  WalletSnapshotDraftV1,
  WalletSnapshotV1,
} from '../ports/execution-risk-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ExecutionRiskClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionRiskPool {
  connect(): Promise<ExecutionRiskClient>;
}

export type ExecutionRiskReconciliationHook = (
  client: ExecutionRiskClient,
  evidence: ExecutionReconciliationEvidenceV1,
) => Promise<void>;

export type ExecutionRiskRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'CONFLICT'
  | 'STALE_MEASUREMENT'
  | 'OPERATION_UNAVAILABLE';

export class ExecutionRiskRepositoryError extends Error {
  public constructor(public readonly code: ExecutionRiskRepositoryErrorCode) {
    super('Execution risk repository operation failed.');
    this.name = 'ExecutionRiskRepositoryError';
  }
}

const DATE_MAX_MS = 8_640_000_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const INTERNAL_ERRORS = new WeakSet<ExecutionRiskRepositoryError>();
const HASH = /^[0-9a-f]{64}$/u;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const GENERATION_KEYS = Object.freeze([
  'generationId', 'payloadVersion', 'walletPublicKey', 'cluster', 'genesisHash', 'generation',
] as const);
const GENERATION_ROW_KEYS = Object.freeze([
  'generation_id', 'payload_version', 'wallet_public_key', 'cluster', 'genesis_hash',
  'generation', 'created_at_ms', 'retired_at_ms',
] as const);
const WALLET_SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', 'generationId', 'providerId',
  'stateRevision', 'slot', 'blockTimeMs', 'observedAtMs', 'commitment', 'walletLamports',
  'tokenBalanceCount', 'openPositions', 'realizedNetPnlRaw',
] as const);
const WALLET_SNAPSHOT_ROW_KEYS = Object.freeze([
  'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'generation_id', 'provider_id',
  'state_revision', 'slot', 'block_time_ms', 'observed_at_ms', 'commitment', 'wallet_lamports',
  'token_balance_count', 'open_positions', 'position_1_id', 'position_1_cost_basis_lamports',
  'position_1_conservative_liquidation_lamports', 'position_1_reconciliation_status',
  'position_2_id', 'position_2_cost_basis_lamports',
  'position_2_conservative_liquidation_lamports', 'position_2_reconciliation_status',
  'realized_net_pnl_raw',
] as const);
const PROVIDER_SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', 'providerId', 'planId',
  'billingPeriodId', 'billingPeriodStartedAtMs', 'billingPeriodEndsAtMs', 'limitUnits',
  'usedUnits', 'measuredAtMs', 'expiresAtMs', 'provenance',
] as const);
const PROVIDER_ROW_KEYS = Object.freeze([
  'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'provider_id', 'plan_id',
  'billing_period_id', 'billing_period_started_at_ms', 'billing_period_ends_at_ms',
  'limit_units', 'used_units', 'measured_at_ms', 'expires_at_ms', 'provenance',
] as const);
const OPERATION_KEYS = Object.freeze([
  'operationId', 'payloadVersion', 'snapshotId', 'providerId', 'billingPeriodId',
  'category', 'logicalOperationId', 'units',
] as const);
const RATE_LIMIT_KEYS = Object.freeze([
  'eventId', 'payloadVersion', 'providerId', 'billingPeriodId', 'endpointId', 'observedAtMs',
] as const);
const ADMISSION_KEYS = Object.freeze([
  'payloadVersion', 'intent', 'policy', 'generationId', 'walletSnapshot',
  'providerSnapshot', 'allEndpointsUnavailable', 'nowMs',
] as const);
const POLICY_KEYS = Object.freeze([
  'payloadVersion', 'policyFingerprint', 'quoteMintAllowlist',
  'initialCapitalLamports', 'maximumCapitalLamports', 'positionSizeBps',
  'maximumOpenPositions', 'maximumTotalExposureBps', 'drawdownPauseBps',
  'feeReserveLamports', 'walletSnapshotMaxAgeMs', 'providerUsageMaxAgeMs',
  'providerEntryCostUnits', 'providerExitCostUnitsPerPosition',
  'providerConfirmationCostUnitsPerPosition',
  'providerReconciliationCostUnitsPerPosition', 'providerSafetyMarginUnits',
  'maximumConsecutiveTechnicalFailures',
] as const);
const ADMISSION_REPORT_ROW_KEYS = Object.freeze([
  'report_id', 'decision', 'reason_code', 'input_fingerprint', 'policy_fingerprint',
  'wallet_snapshot_fingerprint', 'provider_snapshot_fingerprint',
  'wallet_state_revision', 'reservation_id',
] as const);
const RECONCILIATION_COMMIT_KEYS = Object.freeze(['payloadVersion', 'evidence'] as const);
const RECONCILIATION_EVIDENCE_KEYS = Object.freeze([
  'evidenceId', 'payloadVersion', 'evidenceFingerprint', 'intentId', 'attemptNumber',
  'walletGeneration', 'providerId', 'side', 'signature', 'blockhash',
  'lastValidBlockHeight', 'messageHash', 'buildFingerprint', 'snapshotFingerprint',
  'maximumFeeLamports', 'maximumFeePayerLamportDebit',
  'signatureHistory', 'confirmationStatus', 'finalizedBlockHeight', 'observedSlot',
  'observedTransactionFingerprint', 'feeLamports', 'walletLamportDelta', 'baseDeltaRaw',
  'quoteDeltaRaw', 'unexpectedResidualTokenBalanceRaw', 'observedAtMs', 'finalizedAtMs',
  'result', 'reasonCode',
] as const);
const FAULT_KEYS = Object.freeze([
  'faultId', 'payloadVersion', 'generationId', 'intentId', 'activationPhase', 'stage',
  'side', 'timing', 'classification', 'exactSignedBytesAvailable', 'reasonCode', 'observedAtMs',
] as const);
const RECONCILED_SUCCESS_KEYS = Object.freeze([
  'payloadVersion', 'evidenceId', 'generationId', 'activationPhase',
] as const);
const FAULT_REASON_CODES = Object.freeze([
  'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED', 'EXECUTION_PROVIDER_FAILED',
  'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID', 'SIGNATURE_PERSIST_FAILED',
  'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
  'RECONCILIATION_PROVED_NO_EFFECT', 'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE',
  'DOUBLE_ORDER_SUSPECTED',
] as const);

const GENERATION_PROJECTION = `generation_id,payload_version,wallet_public_key,cluster,
  genesis_hash,generation,
  trunc(EXTRACT(EPOCH FROM created_at) * 1000)::TEXT AS created_at_ms,
  CASE WHEN retired_at IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM retired_at) * 1000)::TEXT END AS retired_at_ms`;
const WALLET_SNAPSHOT_PROJECTION = `snapshot_id,payload_version,snapshot_fingerprint,
  generation_id,provider_id,state_revision::TEXT AS state_revision,slot::TEXT AS slot,
  CASE WHEN block_time IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM block_time) * 1000)::TEXT END AS block_time_ms,
  trunc(EXTRACT(EPOCH FROM observed_at) * 1000)::TEXT AS observed_at_ms,
  commitment,wallet_lamports::TEXT AS wallet_lamports,token_balance_count,open_positions,
  position_1_id,position_1_cost_basis_lamports::TEXT AS position_1_cost_basis_lamports,
  position_1_conservative_liquidation_lamports::TEXT
    AS position_1_conservative_liquidation_lamports,
  position_1_reconciliation_status,
  position_2_id,position_2_cost_basis_lamports::TEXT AS position_2_cost_basis_lamports,
  position_2_conservative_liquidation_lamports::TEXT
    AS position_2_conservative_liquidation_lamports,
  position_2_reconciliation_status,
  realized_net_pnl_raw::TEXT AS realized_net_pnl_raw`;
const PROVIDER_PROJECTION = `snapshot_id,payload_version,snapshot_fingerprint,provider_id,
  plan_id,billing_period_id,
  trunc(EXTRACT(EPOCH FROM billing_period_started_at) * 1000)::TEXT AS billing_period_started_at_ms,
  trunc(EXTRACT(EPOCH FROM billing_period_ends_at) * 1000)::TEXT AS billing_period_ends_at_ms,
  limit_units::TEXT AS limit_units,used_units::TEXT AS used_units,
  trunc(EXTRACT(EPOCH FROM measured_at) * 1000)::TEXT AS measured_at_ms,
  trunc(EXTRACT(EPOCH FROM expires_at) * 1000)::TEXT AS expires_at_ms,provenance`;

export class PostgresExecutionRiskRepository implements ExecutionRiskRepository {
  public constructor(private readonly pool: ExecutionRiskPool = getDatabasePool()) {}

  public async registerWalletGeneration(input: WalletGenerationDraftV1): Promise<WalletGenerationV1> {
    const draft = generationDraftFrom(input);
    return this.transaction(async (client) => {
      const existing = await findGeneration(client, draft.generationId);
      if (existing !== null) {
        if (!sameGeneration(existing, draft)) throw failure('CONFLICT');
        return existing;
      }
      try {
        const inserted = await client.query(`INSERT INTO execution_wallet_generations (
          generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation
        ) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING ${GENERATION_PROJECTION}`, generationValues(draft));
        const generation = decodeGeneration(singleRow(inserted));
        await client.query(`INSERT INTO execution_wallet_risk_state (
          generation_id,reconciled_capital_lamports,reserved_exposure_raw,
          conservative_drawdown_raw
        ) VALUES ($1,0,0,0)`, [draft.generationId]);
        return generation;
      } catch (error) {
        if (databaseCode(error) === '23505') throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async appendWalletSnapshot(input: WalletSnapshotDraftV1): Promise<WalletSnapshotV1> {
    const draft = walletSnapshotFrom(input);
    return this.transaction(async (client) => {
      const existing = await findWalletSnapshot(client, draft.snapshotId);
      if (existing !== null) {
        if (!sameWalletSnapshot(existing, draft)) throw failure('CONFLICT');
        return existing;
      }
      const latest = await client.query(`SELECT snapshot_id,state_revision::TEXT AS state_revision,
        superseded_at
        FROM execution_wallet_snapshots WHERE generation_id=$1
        ORDER BY state_revision DESC LIMIT 1 FOR UPDATE`, [draft.generationId]);
      if (latest.rows.length > 1) throw failure('INVALID_DATA');
      const latestRow = latest.rows.length === 0 ? null : exactRow(latest.rows[0], [
        'snapshot_id', 'state_revision', 'superseded_at',
      ] as const);
      const latestRevision = latestRow === null
        ? null : unsignedBigint(parseBigint(latestRow.state_revision));
      if (latestRow !== null && latestRow.superseded_at !== null) throw failure('INVALID_DATA');
      if (latestRevision !== null && draft.stateRevision <= latestRevision) throw failure('CONFLICT');
      try {
        const result = await client.query(`INSERT INTO execution_wallet_snapshots (
          snapshot_id,payload_version,snapshot_fingerprint,generation_id,provider_id,
          state_revision,slot,block_time,observed_at,commitment,wallet_lamports,
          token_balance_count,open_positions,
          position_1_id,position_1_cost_basis_lamports,
          position_1_conservative_liquidation_lamports,position_1_reconciliation_status,
          position_2_id,position_2_cost_basis_lamports,
          position_2_conservative_liquidation_lamports,position_2_reconciliation_status,
          realized_net_pnl_raw
        ) VALUES ($1,$2,$3,$4,$5,$6::BIGINT,$7::BIGINT,
          CASE WHEN $8::BIGINT IS NULL THEN NULL ELSE TIMESTAMPTZ 'epoch'
            + ($8::BIGINT * INTERVAL '1 millisecond') END,
          TIMESTAMPTZ 'epoch' + ($9::BIGINT * INTERVAL '1 millisecond'),
          $10,$11::NUMERIC,$12,$13,
          $14,$15::NUMERIC,$16::NUMERIC,$17,
          $18,$19::NUMERIC,$20::NUMERIC,$21,$22::NUMERIC)
        RETURNING ${WALLET_SNAPSHOT_PROJECTION}`, walletSnapshotValues(draft));
        const inserted = decodeWalletSnapshot(singleRow(result));
        if (latestRow !== null) {
          const superseded = await client.query(`UPDATE execution_wallet_snapshots SET
            superseded_at=date_trunc('milliseconds',statement_timestamp()),
            purge_after=date_trunc('milliseconds',statement_timestamp()) + INTERVAL '4 hours'
            WHERE snapshot_id=$1 AND superseded_at IS NULL`, [latestRow.snapshot_id]);
          if (superseded.rowCount !== 1) throw failure('CONFLICT');
        }
        return inserted;
      } catch (error) {
        if (['23503', '23505'].includes(databaseCode(error) ?? '')) throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async appendProviderUsage(input: ProviderUsageSnapshotV1): Promise<ProviderUsageSnapshotV1> {
    const snapshot = providerSnapshotFrom(input);
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))',
        [snapshot.providerId],
      );
      const existing = await findProviderSnapshot(client, snapshot.snapshotId);
      if (existing !== null) {
        if (!sameProviderSnapshot(existing, snapshot)) throw failure('CONFLICT');
        return existing;
      }
      const latestResult = await client.query(`SELECT ${PROVIDER_PROJECTION}
        FROM execution_provider_usage_snapshots
        WHERE provider_id=$1
        ORDER BY billing_period_started_at DESC,measured_at DESC LIMIT 1 FOR UPDATE`,
      [snapshot.providerId]);
      if (latestResult.rows.length > 1) throw failure('INVALID_DATA');
      if (latestResult.rows.length === 1) {
        const latest = decodeProviderSnapshot(latestResult.rows[0]);
        const samePeriod = snapshot.billingPeriodId === latest.billingPeriodId;
        const coherent = snapshot.planId === latest.planId && (samePeriod
          ? snapshot.billingPeriodStartedAtMs === latest.billingPeriodStartedAtMs
            && snapshot.billingPeriodEndsAtMs === latest.billingPeriodEndsAtMs
            && snapshot.limitUnits === latest.limitUnits
            && snapshot.measuredAtMs > latest.measuredAtMs
            && snapshot.usedUnits >= latest.usedUnits
          : snapshot.billingPeriodStartedAtMs >= latest.billingPeriodEndsAtMs);
        if (!coherent) throw failure('STALE_MEASUREMENT');
      }
      try {
        if (latestResult.rows.length === 1) {
          const latest = decodeProviderSnapshot(latestResult.rows[0]);
          const superseded = await client.query(`UPDATE execution_provider_usage_snapshots SET
            superseded_at=date_trunc('milliseconds',statement_timestamp()),
            purge_after=date_trunc('milliseconds',statement_timestamp()) + INTERVAL '4 hours'
            WHERE snapshot_id=$1 AND superseded_at IS NULL`, [latest.snapshotId]);
          if (superseded.rowCount !== 1) throw failure('CONFLICT');
        }
        const result = await client.query(`INSERT INTO execution_provider_usage_snapshots (
          snapshot_id,payload_version,snapshot_fingerprint,provider_id,plan_id,billing_period_id,
          billing_period_started_at,billing_period_ends_at,limit_units,used_units,measured_at,
          expires_at,provenance
        ) VALUES ($1,$2,$3,$4,$5,$6,
          TIMESTAMPTZ 'epoch' + ($7::BIGINT * INTERVAL '1 millisecond'),
          TIMESTAMPTZ 'epoch' + ($8::BIGINT * INTERVAL '1 millisecond'),$9::NUMERIC,$10::NUMERIC,
          TIMESTAMPTZ 'epoch' + ($11::BIGINT * INTERVAL '1 millisecond'),
          TIMESTAMPTZ 'epoch' + ($12::BIGINT * INTERVAL '1 millisecond'),$13)
        RETURNING ${PROVIDER_PROJECTION}`, providerSnapshotValues(snapshot));
        const inserted = decodeProviderSnapshot(singleRow(result));
        return inserted;
      } catch (error) {
        if (databaseCode(error) === '23505') throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async recordProviderOperation(
    input: ProviderUsageOperationV1,
  ): Promise<'RECORDED' | 'REPLAYED'> {
    const operation = operationFrom(input);
    return this.transaction(async (client) => {
      const existing = await client.query(`SELECT operation_id,payload_version,snapshot_id,
        provider_id,billing_period_id,category,logical_operation_id,units::TEXT AS units
        FROM execution_provider_usage_counters WHERE operation_id=$1`, [operation.operationId]);
      if (existing.rows.length > 1) throw failure('INVALID_DATA');
      if (existing.rows.length === 1) {
        if (!sameOperation(decodeOperation(existing.rows[0]), operation)) throw failure('CONFLICT');
        return 'REPLAYED';
      }
      const snapshotResult = await client.query(`SELECT provider_id,billing_period_id,
        superseded_at FROM execution_provider_usage_snapshots
        WHERE snapshot_id=$1 FOR UPDATE`, [operation.snapshotId]);
      if (snapshotResult.rows.length !== 1) throw failure('CONFLICT');
      const snapshot = exactRow(snapshotResult.rows[0], [
        'provider_id', 'billing_period_id', 'superseded_at',
      ] as const);
      if (snapshot.provider_id !== operation.providerId
        || snapshot.billing_period_id !== operation.billingPeriodId
        || snapshot.superseded_at !== null) throw failure('CONFLICT');
      try {
        const result = await client.query(`INSERT INTO execution_provider_usage_counters (
          operation_id,payload_version,snapshot_id,provider_id,billing_period_id,category,
          logical_operation_id,units
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::NUMERIC)`, operationValues(operation));
        if (result.rowCount !== 1) throw failure('INVALID_DATA');
        return 'RECORDED';
      } catch (error) {
        if (['23503', '23505'].includes(databaseCode(error) ?? '')) throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async recordRateLimit(input: ProviderRateLimitEventV1): Promise<'RECORDED' | 'REPLAYED'> {
    const event = rateLimitFrom(input);
    return this.transaction(async (client) => {
      const existing = await client.query(`SELECT event_id,payload_version,provider_id,
        billing_period_id,endpoint_id,
        trunc(EXTRACT(EPOCH FROM observed_at) * 1000)::TEXT AS observed_at_ms
        FROM execution_provider_rate_limit_events WHERE event_id=$1`, [event.eventId]);
      if (existing.rows.length > 1) throw failure('INVALID_DATA');
      if (existing.rows.length === 1) {
        if (!sameRateLimit(decodeRateLimit(existing.rows[0]), event)) throw failure('CONFLICT');
        return 'REPLAYED';
      }
      try {
        const result = await client.query(`INSERT INTO execution_provider_rate_limit_events (
          event_id,payload_version,provider_id,billing_period_id,endpoint_id,observed_at,purge_after
        ) VALUES ($1,$2,$3,$4,$5,
          TIMESTAMPTZ 'epoch' + ($6::BIGINT * INTERVAL '1 millisecond'),
          TIMESTAMPTZ 'epoch' + (($6::BIGINT + 14400000) * INTERVAL '1 millisecond'))`,
        rateLimitValues(event));
        if (result.rowCount !== 1) throw failure('INVALID_DATA');
        return 'RECORDED';
      } catch (error) {
        if (databaseCode(error) === '23505') throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async admitBuy(inputValue: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1> {
    const input = admissionFrom(inputValue);
    const quoteAmountRaw = input.intent.quoteAmountRaw;
    if (quoteAmountRaw === null) throw failure('INVALID_INPUT');
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [input.generationId],
      );
      const operationAtMs = textTimestamp(exactRow(singleRow(await client.query(
        `SELECT trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds', statement_timestamp()))
          * 1000)::TEXT AS operation_at_ms`,
      )), ['operation_at_ms'] as const).operation_at_ms);
      const decisionAtMs = Math.max(operationAtMs, input.nowMs);
      const generationResult = await client.query(`SELECT generation_id,wallet_public_key,
        cluster,genesis_hash,generation FROM execution_wallet_generations
        WHERE generation_id=$1 AND retired_at IS NULL FOR UPDATE`, [input.generationId]);
      if (generationResult.rows.length !== 1) throw failure('CONFLICT');
      exactRow(singleRow(generationResult), [
        'generation_id', 'wallet_public_key', 'cluster', 'genesis_hash', 'generation',
      ] as const);
      const stateResult = await client.query(`SELECT state_revision::TEXT AS state_revision,
        reserved_exposure_raw::TEXT AS reserved_exposure_raw,open_positions,
        consecutive_technical_failures,last_technical_failure_reason_code,unknown_block
        FROM execution_wallet_risk_state WHERE generation_id=$1 FOR UPDATE`, [input.generationId]);
      const state = decodeRiskState(singleRow(stateResult));
      const intentResult = await client.query(`SELECT id,payload_version,position_id,mint,side,
        quote_mint,quote_amount_raw::TEXT AS quote_amount_raw,decision_fingerprint,
        status,trunc(EXTRACT(EPOCH FROM requested_at) * 1000)::TEXT AS requested_at_ms,
        trunc(EXTRACT(EPOCH FROM expires_at) * 1000)::TEXT AS expires_at_ms
        FROM execution_intents WHERE id=$1 FOR UPDATE`, [input.intent.id]);
      assertAdmissionIntentRow(singleRow(intentResult), input.intent);

      const inputFingerprint = admissionInputFingerprint(input);
      const existing = await findAdmissionResult(client, input.intent.id);
      if (existing !== null) {
        if (existing.inputFingerprint !== inputFingerprint
          || existing.policyFingerprint !== input.policy.policyFingerprint
          || existing.walletSnapshotFingerprint !== input.walletSnapshot.snapshotFingerprint
          || existing.providerSnapshotFingerprint !== input.providerSnapshot.snapshotFingerprint) {
          throw failure('CONFLICT');
        }
        return existing.result;
      }

      const walletSnapshot = await findWalletSnapshot(
        client,
        input.walletSnapshot.snapshotId,
        true,
      );
      if (walletSnapshot === null || !sameWalletSnapshot(walletSnapshot, input.walletSnapshot)
        || walletSnapshot.generationId !== input.generationId) throw failure('CONFLICT');
      const providerSnapshot = await findProviderSnapshot(
        client,
        input.providerSnapshot.snapshotId,
        true,
      );
      if (providerSnapshot === null
        || !sameProviderSnapshot(providerSnapshot, input.providerSnapshot)) throw failure('CONFLICT');

      const localUsage = unsignedBigint(parseBigint(exactRow(singleRow(await client.query(
        `SELECT COALESCE(SUM(units),0)::TEXT AS local_units
         FROM execution_provider_usage_counters
         WHERE provider_id=$1 AND billing_period_id=$2
           AND recorded_at >= TIMESTAMPTZ 'epoch'
             + ($3::BIGINT * INTERVAL '1 millisecond')`,
        [providerSnapshot.providerId, providerSnapshot.billingPeriodId,
          providerSnapshot.measuredAtMs],
      )), ['local_units'] as const).local_units));
      const rateRows = await client.query(`SELECT
        trunc(EXTRACT(EPOCH FROM observed_at) * 1000)::TEXT AS observed_at_ms
        FROM execution_provider_rate_limit_events
        WHERE provider_id=$1 AND observed_at >= TIMESTAMPTZ 'epoch'
          + (($2::BIGINT - 30000) * INTERVAL '1 millisecond')
        ORDER BY observed_at ASC,event_id ASC LIMIT 1000`, [providerSnapshot.providerId, decisionAtMs]);
      const recentRateLimits = rateRows.rows.map((row) => textTimestamp(
        exactRow(row, ['observed_at_ms'] as const).observed_at_ms,
      ));
      const quota = evaluateProviderQuota({
        policy: input.policy,
        previousSnapshot: null,
        snapshot: providerSnapshot,
        localUsedSinceMeasurement: localUsage,
        openPositions: walletSnapshot.openPositions.length,
        consecutiveRateLimits: recentRateLimits,
        allEndpointsUnavailable: input.allEndpointsUnavailable,
        nowMs: decisionAtMs,
      });
      const risk = evaluateBuyRisk({
        policy: input.policy,
        quoteMint: input.intent.quoteMint,
        requestedQuoteAmountRaw: input.intent.quoteAmountRaw,
        realizedNetPnlLamports: walletSnapshot.realizedNetPnlRaw,
        reservedExposureLamports: state.reservedExposureRaw,
        openPositions: walletSnapshot.openPositions,
        consecutiveTechnicalFailures: state.consecutiveTechnicalFailures,
        lastTechnicalFailureReasonCode: state.lastTechnicalFailureReasonCode,
      });
      const staleWallet = walletSnapshot.stateRevision !== state.stateRevision
        || walletSnapshot.openPositions.length !== state.openPositions
        || decisionAtMs > walletSnapshot.observedAtMs + input.policy.walletSnapshotMaxAgeMs;
      const staleDecision = decisionAtMs >= input.intent.expiresAtMs;
      const reasonCode = state.unknownBlock ? 'RECONCILIATION_REQUIRED'
        : staleDecision ? 'DECISION_STALE'
          : staleWallet ? 'WALLET_MISMATCH'
          : risk.kind === 'REJECTED' ? risk.reasonCode
            : quota.state !== 'NORMAL' ? quota.reasonCode : null;
      if (reasonCode === null && (risk.kind !== 'ADMISSIBLE' || quota.state !== 'NORMAL')) {
        throw failure('INVALID_DATA');
      }
      const decision = reasonCode === null ? 'ADMITTED' : 'REJECTED';
      const targetRevision = decision === 'ADMITTED' ? state.stateRevision + 1n : state.stateRevision;
      const identity = admissionIdentity(
        input,
        inputFingerprint,
        risk,
        quota.state,
        decision,
        reasonCode,
      );
      const reportId = `execution_risk_admission_${identity.reportFingerprint}`;
      const reservationId = decision === 'ADMITTED'
        ? `execution_exposure_reservation_${hash(['reservation-v1', reportId])}` : null;
      const reportInsert = await client.query(`INSERT INTO execution_risk_admission_reports (
        report_id,payload_version,report_fingerprint,intent_id,generation_id,policy_fingerprint,
        wallet_snapshot_fingerprint,provider_snapshot_fingerprint,decision,reason_code,
        quote_amount_raw,projected_capital_raw,projected_exposure_raw,projected_drawdown_raw,
        quota_state,wallet_state_revision,input_fingerprint,recorded_at,terminal_at,purge_after
      ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10::NUMERIC,$11::NUMERIC,
        $12::NUMERIC,$13::NUMERIC,$14,$15::BIGINT,$16,
        TIMESTAMPTZ 'epoch' + ($17::BIGINT * INTERVAL '1 millisecond'),
        CASE WHEN $8='REJECTED' THEN TIMESTAMPTZ 'epoch'
          + ($17::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
        CASE WHEN $8='REJECTED' THEN TIMESTAMPTZ 'epoch'
          + (($17::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END)`, [
        reportId, identity.reportFingerprint, input.intent.id, input.generationId,
        input.policy.policyFingerprint, walletSnapshot.snapshotFingerprint,
        providerSnapshot.snapshotFingerprint, decision, reasonCode,
        quoteAmountRaw.toString(), risk.reconciledCapitalLamports.toString(),
        risk.projectedExposureLamports.toString(),
        risk.conservativeUnrealizedLossLamports.toString(), quota.state,
        targetRevision.toString(), inputFingerprint, operationAtMs,
      ]);
      if (reportInsert.rowCount !== 1) throw failure('INVALID_DATA');
      if (decision === 'ADMITTED' && reservationId !== null) {
        const reservationInsert = await client.query(`INSERT INTO execution_exposure_reservations (
          reservation_id,payload_version,intent_id,generation_id,admission_report_id,position_id,
          side,mint,quote_mint,maximum_amount_raw,intent_fingerprint,policy_fingerprint,
          wallet_snapshot_fingerprint,provider_snapshot_fingerprint,state,state_revision,created_at
        ) VALUES ($1,1,$2,$3,$4,$5,'BUY',$6,$7,$8::NUMERIC,$9,$10,$11,$12,
          'RESERVED',$13::BIGINT,
          TIMESTAMPTZ 'epoch' + ($14::BIGINT * INTERVAL '1 millisecond'))`, [
          reservationId, input.intent.id, input.generationId, reportId, input.intent.positionId,
          input.intent.mint, input.intent.quoteMint, quoteAmountRaw.toString(),
          identity.intentFingerprint, input.policy.policyFingerprint,
          walletSnapshot.snapshotFingerprint, providerSnapshot.snapshotFingerprint,
          targetRevision.toString(), operationAtMs,
        ]);
        if (reservationInsert.rowCount !== 1) throw failure('INVALID_DATA');
        const operationId = createProviderUsageOperationId({
          providerId: providerSnapshot.providerId,
          billingPeriodId: providerSnapshot.billingPeriodId,
          category: 'ENTRY',
          logicalOperationId: input.intent.id,
        });
        const counterInsert = await client.query(`INSERT INTO execution_provider_usage_counters (
          operation_id,payload_version,snapshot_id,provider_id,billing_period_id,category,
          logical_operation_id,units,recorded_at
        ) VALUES ($1,1,$2,$3,$4,'ENTRY',$5,$6::NUMERIC,
          TIMESTAMPTZ 'epoch' + ($7::BIGINT * INTERVAL '1 millisecond'))`, [
          operationId, providerSnapshot.snapshotId, providerSnapshot.providerId,
          providerSnapshot.billingPeriodId, input.intent.id,
          input.policy.providerEntryCostUnits.toString(), operationAtMs,
        ]);
        if (counterInsert.rowCount !== 1) throw failure('INVALID_DATA');
        const update = await client.query(`UPDATE execution_wallet_risk_state SET
          state_revision=$2::BIGINT,reconciled_capital_lamports=$3::NUMERIC,
          reserved_exposure_raw=$4::NUMERIC,open_positions=$5,
          conservative_drawdown_raw=$6::NUMERIC,
          updated_at=TIMESTAMPTZ 'epoch' + ($7::BIGINT * INTERVAL '1 millisecond')
          WHERE generation_id=$1 AND state_revision=$8::BIGINT`, [
          input.generationId, targetRevision.toString(), risk.reconciledCapitalLamports.toString(),
          risk.projectedExposureLamports.toString(), risk.openPositionCount + 1,
          risk.conservativeUnrealizedLossLamports.toString(), operationAtMs,
          state.stateRevision.toString(),
        ]);
        if (update.rowCount !== 1) throw failure('CONFLICT');
      }
      return Object.freeze({
        payloadVersion: 1,
        decision,
        reasonCode,
        reportId,
        reservationId,
        stateRevision: targetRevision,
      });
    });
  }

  public async recordFault(
    inputValue: ExecutionFaultRecordInputV1,
  ): Promise<ExecutionFaultRecordResultV1> {
    const input = faultFrom(inputValue);
    const fingerprint = faultFingerprint(input);
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [input.generationId],
      );
      const stateResult = await client.query(`SELECT
        risk.state_revision::TEXT AS state_revision,
        risk.consecutive_technical_failures,
        generation.retired_at
        FROM execution_wallet_risk_state AS risk
        JOIN execution_wallet_generations AS generation
          ON generation.generation_id=risk.generation_id
        WHERE risk.generation_id=$1 FOR UPDATE OF risk,generation`, [input.generationId]);
      const state = exactRow(singleRow(stateResult), [
        'state_revision', 'consecutive_technical_failures', 'retired_at',
      ] as const);
      if (state.retired_at !== null) throw failure('CONFLICT');
      const existing = await client.query(`SELECT fault_fingerprint,
        consecutive_failure_count,retry_decision FROM execution_fault_ledger
        WHERE fault_id=$1`, [input.faultId]);
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw failure('INVALID_DATA');
        const prior = exactRow(existing.rows[0], [
          'fault_fingerprint', 'consecutive_failure_count', 'retry_decision',
        ] as const);
        if (prior.fault_fingerprint !== fingerprint) throw failure('CONFLICT');
        return faultResult(
          input.faultId,
          integer(prior.consecutive_failure_count, 0, 32_767),
          enumValue(prior.retry_decision, [
            'DO_NOT_RETRY', 'RETRY_PRE_SIGNATURE', 'RECONCILE_ONLY', 'RETRY_EXACT_BYTES',
          ] as const),
        );
      }
      const currentFailures = integer(state.consecutive_technical_failures, 0, 32_767);
      const technicalReason = technicalFailureReason(input);
      const nextFailures = technicalReason === null
        ? currentFailures : Math.min(currentFailures + 1, 32_767);
      const retryDecision = classifyExecutionFault({
        stage: input.stage,
        side: input.side,
        timing: input.timing,
        classification: input.classification,
        consecutiveTechnicalFailures: nextFailures,
        exactSignedBytesAvailable: input.exactSignedBytesAvailable,
      });
      const insert = await client.query(`INSERT INTO execution_fault_ledger (
        fault_id,payload_version,fault_fingerprint,generation_id,intent_id,activation_phase,
        stage,classification,retry_decision,reason_code,consecutive_failure_count,observed_at
      ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        TIMESTAMPTZ 'epoch' + ($11::BIGINT * INTERVAL '1 millisecond'))`, [
        input.faultId, fingerprint, input.generationId, input.intentId, input.activationPhase,
        input.stage, input.classification, retryDecision, input.reasonCode, nextFailures,
        input.observedAtMs,
      ]);
      if (insert.rowCount !== 1) throw failure('INVALID_DATA');
      if (technicalReason !== null) {
        const revision = unsignedBigint(parseBigint(state.state_revision));
        const update = await client.query(`UPDATE execution_wallet_risk_state SET
          state_revision=$2::BIGINT,consecutive_technical_failures=$3,
          last_technical_failure_reason_code=$4,
          updated_at=TIMESTAMPTZ 'epoch' + ($5::BIGINT * INTERVAL '1 millisecond')
          WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
          input.generationId, (revision + 1n).toString(), nextFailures, technicalReason,
          input.observedAtMs, revision.toString(),
        ]);
        if (update.rowCount !== 1) throw failure('CONFLICT');
      }
      return faultResult(input.faultId, nextFailures, retryDecision);
    });
  }

  public async recordReconciledSuccess(
    inputValue: ExecutionReconciledSuccessInputV1,
  ): Promise<ExecutionFaultRecordResultV1> {
    const input = reconciledSuccessFrom(inputValue);
    const faultId = `execution_fault_${hash([
      'execution-reconciled-success-v1', input.evidenceId,
    ])}`;
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [input.generationId],
      );
      const proofResult = await client.query(`SELECT evidence.evidence_id,evidence.intent_id,
        evidence.generation_id,evidence.result,
        trunc(EXTRACT(EPOCH FROM evidence.finalized_at) * 1000)::TEXT AS finalized_at_ms,
        risk.state_revision::TEXT AS state_revision,risk.consecutive_technical_failures,
        generation.retired_at
        FROM execution_reconciliation_evidence AS evidence
        JOIN execution_wallet_risk_state AS risk
          ON risk.generation_id=evidence.generation_id
        JOIN execution_wallet_generations AS generation
          ON generation.generation_id=evidence.generation_id
        WHERE evidence.evidence_id=$1 FOR UPDATE OF evidence,risk,generation`, [input.evidenceId]);
      const proof = exactRow(singleRow(proofResult), [
        'evidence_id', 'intent_id', 'generation_id', 'result', 'finalized_at_ms',
        'state_revision', 'consecutive_technical_failures', 'retired_at',
      ] as const);
      if (proof.evidence_id !== input.evidenceId
        || proof.generation_id !== input.generationId
        || proof.result !== 'MATCHED'
        || proof.finalized_at_ms === null
        || proof.retired_at !== null) throw failure('CONFLICT');
      const finalizedAtMs = textTimestamp(proof.finalized_at_ms);
      const currentFailures = integer(proof.consecutive_technical_failures, 0, 32_767);
      if (currentFailures > 0) {
        const latestFaultResult = await client.query(`SELECT
          trunc(EXTRACT(EPOCH FROM observed_at) * 1000)::TEXT AS observed_at_ms
          FROM execution_fault_ledger
          WHERE generation_id=$1 AND reason_code IN (
            'EXECUTION_BUILD_FAILED','BUY_SIMULATION_FAILED','SELL_SIMULATION_FAILED',
            'EXECUTION_PROVIDER_FAILED','CONFIRMATION_TIMEOUT','RECONCILIATION_REQUIRED'
          )
          ORDER BY observed_at DESC,fault_id DESC LIMIT 1`, [input.generationId]);
        const latestFault = exactRow(singleRow(latestFaultResult), ['observed_at_ms'] as const);
        if (finalizedAtMs <= textTimestamp(latestFault.observed_at_ms)) {
          throw failure('CONFLICT');
        }
      }
      const intentId = patternedText(proof.intent_id, /^execution_intent_[0-9a-f]{64}$/u);
      const fingerprint = hash([
        'execution-reconciled-success-ledger-v1', faultId, input.evidenceId,
        input.generationId, intentId, input.activationPhase, finalizedAtMs,
      ]);
      const existing = await client.query(`SELECT fault_fingerprint,
        consecutive_failure_count,retry_decision FROM execution_fault_ledger
        WHERE fault_id=$1`, [faultId]);
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw failure('INVALID_DATA');
        const prior = exactRow(existing.rows[0], [
          'fault_fingerprint', 'consecutive_failure_count', 'retry_decision',
        ] as const);
        if (prior.fault_fingerprint !== fingerprint
          || prior.consecutive_failure_count !== 0
          || prior.retry_decision !== 'DO_NOT_RETRY') throw failure('CONFLICT');
        return faultResult(faultId, 0, 'DO_NOT_RETRY');
      }
      const insert = await client.query(`INSERT INTO execution_fault_ledger (
        fault_id,payload_version,fault_fingerprint,generation_id,intent_id,activation_phase,
        stage,classification,retry_decision,reason_code,consecutive_failure_count,
        observed_at,reset_at,purge_after
      ) VALUES ($1,1,$2,$3,$4,$5,'RECONCILIATION','RESOLVED','DO_NOT_RETRY',
        'INTENT_SUCCEEDED',0,
        TIMESTAMPTZ 'epoch' + ($6::BIGINT * INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch' + ($6::BIGINT * INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch' + (($6::BIGINT + 14400000) * INTERVAL '1 millisecond'))`, [
        faultId, fingerprint, input.generationId, intentId, input.activationPhase, finalizedAtMs,
      ]);
      if (insert.rowCount !== 1) throw failure('INVALID_DATA');
      const revision = unsignedBigint(parseBigint(proof.state_revision));
      const update = await client.query(`UPDATE execution_wallet_risk_state SET
        state_revision=$2::BIGINT,consecutive_technical_failures=0,
        last_technical_failure_reason_code=NULL,
        updated_at=GREATEST(updated_at,
          TIMESTAMPTZ 'epoch' + ($3::BIGINT * INTERVAL '1 millisecond'))
        WHERE generation_id=$1 AND state_revision=$4::BIGINT`, [
        input.generationId, (revision + 1n).toString(), finalizedAtMs, revision.toString(),
      ]);
      if (update.rowCount !== 1) throw failure('CONFLICT');
      return faultResult(faultId, 0, 'DO_NOT_RETRY');
    });
  }

  public async reconcile(
    inputValue: ExecutionReconciliationCommitV1,
  ): Promise<ExecutionReconciliationCommitResultV1> {
    return this.reconcileWithHook(inputValue, () => Promise.resolve());
  }

  public async reconcileWithHook(
    inputValue: ExecutionReconciliationCommitV1,
    hook: ExecutionRiskReconciliationHook,
  ): Promise<ExecutionReconciliationCommitResultV1> {
    const evidence = reconciliationCommitFrom(inputValue);
    return this.transaction(async (client) => {
      const identity = await client.query(`SELECT generation_id FROM execution_exposure_reservations
        WHERE intent_id=$1`, [evidence.intentId]);
      const generationId = patternedText(
        exactRow(singleRow(identity), ['generation_id'] as const).generation_id,
        /^execution_wallet_generation_[0-9a-f]{64}$/u,
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [generationId],
      );
      const locked = await client.query(`SELECT reservation.reservation_id,
        reservation.state AS reservation_state,
        reservation.maximum_amount_raw::TEXT AS maximum_amount_raw,
        reservation.state_revision::TEXT AS reservation_revision,
        reservation.wallet_snapshot_fingerprint,
        generation.generation,
        risk.state_revision::TEXT AS risk_revision,
        risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,
        risk.open_positions,risk.unknown_block,
        intent.status AS intent_status,intent.side AS intent_side,
        intent.state_revision::TEXT AS intent_revision,
        attempt.provider_id,attempt.status AS attempt_status,
        attempt.reconciliation_signature,
        attempt.reconciliation_blockhash,
        attempt.reconciliation_last_valid_block_height::TEXT
          AS reconciliation_last_valid_block_height,
        attempt.reconciliation_message_hash,
        attempt.reconciliation_build_fingerprint,
        attempt.reconciliation_snapshot_fingerprint,
        attempt.reconciliation_maximum_fee_lamports::TEXT
          AS reconciliation_maximum_fee_lamports,
        attempt.reconciliation_maximum_fee_payer_lamport_debit::TEXT
          AS reconciliation_maximum_fee_payer_lamport_debit
        FROM execution_exposure_reservations AS reservation
        JOIN execution_wallet_generations AS generation
          ON generation.generation_id=reservation.generation_id
        JOIN execution_wallet_risk_state AS risk
          ON risk.generation_id=reservation.generation_id
        JOIN execution_intents AS intent ON intent.id=reservation.intent_id
        JOIN execution_attempts AS attempt ON attempt.intent_id=intent.id
          AND attempt.attempt_number=$2
        WHERE reservation.intent_id=$1 AND reservation.generation_id=$3
        FOR UPDATE OF reservation,generation,risk,intent,attempt`, [
        evidence.intentId, evidence.attemptNumber, generationId,
      ]);
      const row = exactRow(singleRow(locked), [
        'reservation_id', 'reservation_state', 'maximum_amount_raw', 'reservation_revision',
        'wallet_snapshot_fingerprint', 'generation',
        'risk_revision', 'reserved_exposure_raw', 'open_positions', 'unknown_block',
        'intent_status', 'intent_side', 'intent_revision', 'provider_id', 'attempt_status',
        'reconciliation_signature', 'reconciliation_blockhash',
        'reconciliation_last_valid_block_height', 'reconciliation_message_hash',
        'reconciliation_build_fingerprint', 'reconciliation_snapshot_fingerprint',
        'reconciliation_maximum_fee_lamports',
        'reconciliation_maximum_fee_payer_lamport_debit',
      ] as const);
      const existing = await client.query(`SELECT evidence_id,evidence_fingerprint,result,
        trunc(EXTRACT(EPOCH FROM observed_at) * 1000)::TEXT AS observed_at_ms,
        resolved_by_evidence_id
        FROM execution_reconciliation_evidence
        WHERE intent_id=$1 AND attempt_number=$2
        ORDER BY observed_at,evidence_id FOR UPDATE`, [
        evidence.intentId, evidence.attemptNumber,
      ]);
      const priorEvidence = existing.rows.map((candidate) => exactRow(candidate, [
        'evidence_id', 'evidence_fingerprint', 'result', 'observed_at_ms',
        'resolved_by_evidence_id',
      ] as const));
      const replay = priorEvidence.find((prior) => prior.evidence_id === evidence.evidenceId);
      if (replay !== undefined) {
        if (replay.evidence_fingerprint !== evidence.evidenceFingerprint
          || replay.result !== evidence.result) throw failure('CONFLICT');
        await hook(client, evidence);
        return reconciliationResult(evidence);
      }
      if (priorEvidence.length > 0) {
        const latestObservedAtMs = priorEvidence.reduce(
          (latest, prior) => Math.max(latest, textTimestamp(prior.observed_at_ms)),
          0,
        );
        if (priorEvidence.some((prior) => prior.result !== 'UNKNOWN'
          || prior.resolved_by_evidence_id !== null)
          || evidence.observedAtMs <= latestObservedAtMs) throw failure('CONFLICT');
      }
      if (row.generation !== evidence.walletGeneration
        || row.intent_side !== evidence.side
        || row.provider_id !== evidence.providerId
        || row.wallet_snapshot_fingerprint !== evidence.snapshotFingerprint
        || row.reconciliation_signature !== evidence.signature
        || row.reconciliation_blockhash !== evidence.blockhash
        || row.reconciliation_last_valid_block_height
          !== evidence.lastValidBlockHeight.toString()
        || row.reconciliation_message_hash !== evidence.messageHash
        || row.reconciliation_build_fingerprint !== evidence.buildFingerprint
        || row.reconciliation_snapshot_fingerprint !== evidence.snapshotFingerprint
        || row.reconciliation_maximum_fee_lamports !== evidence.maximumFeeLamports.toString()
        || row.reconciliation_maximum_fee_payer_lamport_debit
          !== evidence.maximumFeePayerLamportDebit.toString()
        || !['RESERVED', 'UNKNOWN_HELD'].includes(String(row.reservation_state))
        || row.attempt_status !== 'STARTED') throw failure('CONFLICT');
      const reservationId = patternedText(
        row.reservation_id,
        /^execution_exposure_reservation_[0-9a-f]{64}$/u,
      );
      const maximumAmount = positiveBigint(parseBigint(row.maximum_amount_raw));
      const riskRevision = unsignedBigint(parseBigint(row.risk_revision));
      const reservationRevision = unsignedBigint(parseBigint(row.reservation_revision));
      const intentRevision = unsignedBigint(parseBigint(row.intent_revision));
      const reservedExposure = unsignedBigint(parseBigint(row.reserved_exposure_raw));
      const openPositions = integer(row.open_positions, 0, 2);
      if (typeof row.unknown_block !== 'boolean' || reservedExposure < maximumAmount) {
        throw failure('INVALID_DATA');
      }
      const terminal = evidence.result === 'MATCHED' || evidence.result === 'NO_EFFECT';
      const finalizedAtMs = evidence.finalizedAtMs;
      if (terminal && finalizedAtMs === null) throw failure('INVALID_INPUT');
      const inserted = await client.query(`INSERT INTO execution_reconciliation_evidence (
        evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,reservation_id,
        generation_id,provider_id,side,signature,blockhash,last_valid_block_height,message_hash,
        build_fingerprint,snapshot_fingerprint,maximum_fee_lamports,
        maximum_fee_payer_lamport_debit,signature_history,confirmation_status,
        finalized_block_height,observed_slot,observed_transaction_fingerprint,fee_lamports,
        wallet_lamport_delta,base_delta_raw,quote_delta_raw,
        unexpected_residual_token_balance_raw,observed_at,finalized_at,result,reason_code,purge_after
      ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::BIGINT,$12,$13,$14,
        $15::NUMERIC,$16::NUMERIC,$17,$18,$19::BIGINT,$20::BIGINT,$21,
        $22::NUMERIC,$23::NUMERIC,$24::NUMERIC,$25::NUMERIC,$26::NUMERIC,
        TIMESTAMPTZ 'epoch' + ($27::BIGINT * INTERVAL '1 millisecond'),
        CASE WHEN $28::BIGINT IS NULL THEN NULL ELSE TIMESTAMPTZ 'epoch'
          + ($28::BIGINT * INTERVAL '1 millisecond') END,$29,$30,
        CASE WHEN $29 IN ('MATCHED','NO_EFFECT') THEN TIMESTAMPTZ 'epoch'
          + (($28::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END)`, [
        evidence.evidenceId, evidence.evidenceFingerprint, evidence.intentId,
        evidence.attemptNumber, reservationId, generationId, evidence.providerId, evidence.side,
        evidence.signature, evidence.blockhash, evidence.lastValidBlockHeight.toString(),
        evidence.messageHash, evidence.buildFingerprint, evidence.snapshotFingerprint,
        evidence.maximumFeeLamports.toString(), evidence.maximumFeePayerLamportDebit.toString(),
        evidence.signatureHistory, evidence.confirmationStatus,
        evidence.finalizedBlockHeight.toString(), evidence.observedSlot?.toString() ?? null,
        evidence.observedTransactionFingerprint, evidence.feeLamports.toString(),
        evidence.walletLamportDelta.toString(), evidence.baseDeltaRaw.toString(),
        evidence.quoteDeltaRaw.toString(), evidence.unexpectedResidualTokenBalanceRaw.toString(),
        evidence.observedAtMs, finalizedAtMs, evidence.result, evidence.reasonCode,
      ]);
      if (inserted.rowCount !== 1) throw failure('INVALID_DATA');
      if (terminal && priorEvidence.length > 0) {
        const resolved = await client.query(`UPDATE execution_reconciliation_evidence SET
          resolved_by_evidence_id=$3,resolved_at=TIMESTAMPTZ 'epoch'
            + ($4::BIGINT * INTERVAL '1 millisecond'),
          purge_after=TIMESTAMPTZ 'epoch'
            + (($4::BIGINT + 14400000) * INTERVAL '1 millisecond')
          WHERE intent_id=$1 AND attempt_number=$2 AND result='UNKNOWN'
            AND resolved_by_evidence_id IS NULL`, [
          evidence.intentId, evidence.attemptNumber, evidence.evidenceId, finalizedAtMs,
        ]);
        if (resolved.rowCount !== priorEvidence.length) throw failure('CONFLICT');
      }
      const reservationState = evidence.result === 'MATCHED' ? 'CONSUMED'
        : evidence.result === 'NO_EFFECT' ? 'RELEASED' : 'UNKNOWN_HELD';
      const reservationUpdate = await client.query(`UPDATE execution_exposure_reservations SET
        state=$2,state_revision=$3::BIGINT,
        reconciled_at=CASE WHEN $2 IN ('CONSUMED','RELEASED') THEN TIMESTAMPTZ 'epoch'
          + ($4::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
        purge_after=CASE WHEN $2 IN ('CONSUMED','RELEASED') THEN TIMESTAMPTZ 'epoch'
          + (($4::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END
        WHERE reservation_id=$1 AND state_revision=$5::BIGINT`, [
        reservationId, reservationState, (reservationRevision + 1n).toString(),
        finalizedAtMs, reservationRevision.toString(),
      ]);
      if (reservationUpdate.rowCount !== 1) throw failure('CONFLICT');
      const releasesExposure = evidence.result === 'NO_EFFECT';
      const riskUpdate = await client.query(`UPDATE execution_wallet_risk_state SET
        state_revision=$2::BIGINT,
        reserved_exposure_raw=$3::NUMERIC,open_positions=$4,
        unknown_block=EXISTS (
          SELECT 1 FROM execution_exposure_reservations
          WHERE generation_id=$1 AND state='UNKNOWN_HELD'
        ),
        updated_at=TIMESTAMPTZ 'epoch' + ($5::BIGINT * INTERVAL '1 millisecond')
        WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
        generationId, (riskRevision + 1n).toString(),
        (releasesExposure ? reservedExposure - maximumAmount : reservedExposure).toString(),
        releasesExposure ? openPositions - 1 : openPositions,
        evidence.finalizedAtMs ?? evidence.observedAtMs, riskRevision.toString(),
      ]);
      if (riskUpdate.rowCount !== 1) throw failure('CONFLICT');
      const transitions = reconciliationTransitions(String(row.intent_status), evidence.result);
      for (const [index, transition] of transitions.entries()) {
        const transitionAtMs = evidence.finalizedAtMs ?? evidence.observedAtMs;
        const transitionInsert = await client.query(`INSERT INTO execution_intent_transitions (
          intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
          attempt_number,evidence,occurred_at
        ) VALUES ($1,$2,$3,$4,$5,'NONE',$6,
          jsonb_build_object('payloadVersion',1,'attemptNumber',$6::INTEGER,
            'sourceEventId',NULL,'observedAtMs',$7::BIGINT),
          TIMESTAMPTZ 'epoch' + (($7::BIGINT + $8::INTEGER) * INTERVAL '1 millisecond'))`, [
          evidence.intentId, transition.previousStatus, transition.nextStatus,
          transition.reasonCode, transition.humanMessage, evidence.attemptNumber,
          transitionAtMs, index,
        ]);
        if (transitionInsert.rowCount !== 1) throw failure('INVALID_DATA');
      }
      const finalStatus = transitions.at(-1)?.nextStatus ?? String(row.intent_status);
      const finalReason = transitions.at(-1)?.reasonCode ?? 'RECONCILIATION_REQUIRED';
      const intentTerminal = finalStatus === 'SUCCEEDED' || finalStatus === 'FAILED';
      const intentAtMs = evidence.finalizedAtMs ?? evidence.observedAtMs;
      const intentUpdate = await client.query(`UPDATE execution_intents SET
        status=$2,last_reason_code=$3,state_revision=$4::BIGINT,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        terminal_at=CASE WHEN $5 THEN TIMESTAMPTZ 'epoch'
          + ($6::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
        reconciliation_completed_at=CASE WHEN $5 THEN TIMESTAMPTZ 'epoch'
          + ($6::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
        purge_after=CASE WHEN $5 THEN TIMESTAMPTZ 'epoch'
          + (($6::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END,
        updated_at=TIMESTAMPTZ 'epoch' + ($6::BIGINT * INTERVAL '1 millisecond')
        WHERE id=$1 AND state_revision=$7::BIGINT`, [
        evidence.intentId, finalStatus, finalReason,
        (intentRevision + BigInt(transitions.length)).toString(), intentTerminal,
        intentAtMs, intentRevision.toString(),
      ]);
      if (intentUpdate.rowCount !== 1) throw failure('CONFLICT');
      if (terminal) {
        const attemptUpdate = await client.query(`UPDATE execution_attempts SET
          status=$3,completed_at=TIMESTAMPTZ 'epoch'
            + ($4::BIGINT * INTERVAL '1 millisecond'),reason_code=$5
          WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'`, [
          evidence.intentId, evidence.attemptNumber,
          evidence.result === 'MATCHED' ? 'COMPLETED' : 'ABANDONED',
          finalizedAtMs,
          evidence.result === 'MATCHED' ? 'ATTEMPT_COMPLETED' : evidence.reasonCode,
        ]);
        if (attemptUpdate.rowCount !== 1) throw failure('CONFLICT');
      }
      await hook(client, evidence);
      return reconciliationResult(evidence);
    });
  }

  private async transaction<T>(operation: (client: ExecutionRiskClient) => Promise<T>): Promise<T> {
    let client: ExecutionRiskClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw failure('DATABASE_FAILURE');
    }
    let primary: unknown;
    let result: T | undefined;
    let commitStarted = false;
    try {
      await client.query('BEGIN');
      result = await operation(client);
      commitStarted = true;
      await client.query('COMMIT');
    } catch (error) {
      primary = error;
      if (!commitStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          primary = failure('DATABASE_FAILURE');
        }
      }
    }
    try {
      client.release(primary !== undefined);
    } catch {
      if (primary === undefined) primary = failure('DATABASE_FAILURE');
    }
    if (primary !== undefined) {
      if (primary instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(primary)) throw primary;
      throw failure(commitStarted ? 'COMMIT_OUTCOME_UNKNOWN' : 'DATABASE_FAILURE');
    }
    if (result === undefined) throw failure('INVALID_DATA');
    return result;
  }
}

function generationDraftFrom(value: unknown): WalletGenerationDraftV1 {
  try {
    const row = exactInput(value, GENERATION_KEYS);
    return Object.freeze({
      generationId: patternedText(row.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payloadVersion),
      walletPublicKey: base58(row.walletPublicKey, 32, 44),
      cluster: enumValue(row.cluster, ['mainnet-beta', 'devnet', 'testnet'] as const),
      genesisHash: base58(row.genesisHash, 32, 44),
      generation: integer(row.generation, 1, 2_147_483_647),
    });
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function walletSnapshotFrom(value: unknown): WalletSnapshotV1 {
  try {
    const row = exactInput(value, WALLET_SNAPSHOT_KEYS);
    return Object.freeze({
      snapshotId: patternedText(row.snapshotId, /^execution_wallet_snapshot_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payloadVersion),
      snapshotFingerprint: patternedText(row.snapshotFingerprint, HASH),
      generationId: patternedText(row.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u),
      providerId: text(row.providerId, 256),
      stateRevision: unsignedBigint(row.stateRevision),
      slot: unsignedBigint(row.slot),
      blockTimeMs: nullableTimestamp(row.blockTimeMs),
      observedAtMs: timestamp(row.observedAtMs),
      commitment: enumValue(row.commitment, ['finalized'] as const),
      walletLamports: unsignedBigint(row.walletLamports),
      tokenBalanceCount: integer(row.tokenBalanceCount, 0, 2_147_483_647),
      openPositions: positionsFrom(row.openPositions),
      realizedNetPnlRaw: signedBigint(row.realizedNetPnlRaw),
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_INPUT');
  }
}

function providerSnapshotFrom(value: unknown): ProviderUsageSnapshotV1 {
  try {
    const row = exactInput(value, PROVIDER_SNAPSHOT_KEYS);
    const snapshot = createProviderUsageSnapshot(Object.freeze({
      providerId: row.providerId,
      planId: row.planId,
      billingPeriodId: row.billingPeriodId,
      billingPeriodStartedAtMs: row.billingPeriodStartedAtMs,
      billingPeriodEndsAtMs: row.billingPeriodEndsAtMs,
      limitUnits: row.limitUnits,
      usedUnits: row.usedUnits,
      measuredAtMs: row.measuredAtMs,
      expiresAtMs: row.expiresAtMs,
      provenance: row.provenance,
    }));
    if (snapshot.snapshotId !== row.snapshotId
      || snapshot.snapshotFingerprint !== row.snapshotFingerprint
      || row.payloadVersion !== 1) {
      throw new TypeError();
    }
    return snapshot;
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function admissionFrom(value: unknown): ExecutionBuyAdmissionInputV1 {
  try {
    const row = exactInput(value, ADMISSION_KEYS);
    if (row.payloadVersion !== 1) throw new TypeError();
    assertExecutionIntent(row.intent);
    const intent = row.intent;
    if (intent.side !== 'BUY' || intent.status !== 'PENDING'
      || intent.quoteAmountRaw === null || intent.baseAmountRaw !== null) throw new TypeError();
    const policy = policyFrom(row.policy);
    const walletSnapshot = walletSnapshotFrom(row.walletSnapshot);
    const providerSnapshot = providerSnapshotFrom(row.providerSnapshot);
    const generationId = patternedText(
      row.generationId,
      /^execution_wallet_generation_[0-9a-f]{64}$/u,
    );
    if (walletSnapshot.generationId !== generationId
      || walletSnapshot.providerId !== providerSnapshot.providerId
      || intent.quoteMint !== policy.quoteMintAllowlist[0]
      || typeof row.allEndpointsUnavailable !== 'boolean') throw new TypeError();
    const nowMs = timestamp(row.nowMs);
    if (nowMs < intent.requestedAtMs || nowMs >= intent.expiresAtMs) throw new TypeError();
    return Object.freeze({
      payloadVersion: 1,
      intent,
      policy,
      generationId,
      walletSnapshot,
      providerSnapshot,
      allEndpointsUnavailable: row.allEndpointsUnavailable,
      nowMs,
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_INPUT');
  }
}

function policyFrom(value: unknown): ExecutionRiskPolicyV1 {
  const row = exactInput(value, POLICY_KEYS);
  if (row.payloadVersion !== 1) throw new TypeError();
  const policy = createExecutionRiskPolicy(Object.freeze({
    quoteMintAllowlist: row.quoteMintAllowlist,
    initialCapitalLamports: row.initialCapitalLamports,
    maximumCapitalLamports: row.maximumCapitalLamports,
    positionSizeBps: row.positionSizeBps,
    maximumOpenPositions: row.maximumOpenPositions,
    maximumTotalExposureBps: row.maximumTotalExposureBps,
    drawdownPauseBps: row.drawdownPauseBps,
    feeReserveLamports: row.feeReserveLamports,
    walletSnapshotMaxAgeMs: row.walletSnapshotMaxAgeMs,
    providerUsageMaxAgeMs: row.providerUsageMaxAgeMs,
    providerEntryCostUnits: row.providerEntryCostUnits,
    providerExitCostUnitsPerPosition: row.providerExitCostUnitsPerPosition,
    providerConfirmationCostUnitsPerPosition: row.providerConfirmationCostUnitsPerPosition,
    providerReconciliationCostUnitsPerPosition: row.providerReconciliationCostUnitsPerPosition,
    providerSafetyMarginUnits: row.providerSafetyMarginUnits,
    maximumConsecutiveTechnicalFailures: row.maximumConsecutiveTechnicalFailures,
  }));
  if (row.policyFingerprint !== policy.policyFingerprint) throw new TypeError();
  return policy;
}

function decodeRiskState(value: unknown): Readonly<{
  stateRevision: bigint;
  reservedExposureRaw: bigint;
  openPositions: number;
  consecutiveTechnicalFailures: number;
  lastTechnicalFailureReasonCode: ExecutionTechnicalFailureReasonCode | null;
  unknownBlock: boolean;
}> {
  try {
    const row = exactRow(value, [
      'state_revision', 'reserved_exposure_raw', 'open_positions',
      'consecutive_technical_failures', 'last_technical_failure_reason_code', 'unknown_block',
    ] as const);
    const consecutiveTechnicalFailures = integer(row.consecutive_technical_failures, 0, 32_767);
    const lastTechnicalFailureReasonCode = row.last_technical_failure_reason_code === null
      ? null : enumValue(row.last_technical_failure_reason_code, [
        'EXECUTION_BUILD_FAILED', 'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED',
        'EXECUTION_PROVIDER_FAILED', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
      ] as const);
    if ((consecutiveTechnicalFailures === 0) !== (lastTechnicalFailureReasonCode === null)) {
      throw new TypeError();
    }
    if (typeof row.unknown_block !== 'boolean') throw new TypeError();
    return Object.freeze({
      stateRevision: unsignedBigint(parseBigint(row.state_revision)),
      reservedExposureRaw: unsignedBigint(parseBigint(row.reserved_exposure_raw)),
      openPositions: integer(row.open_positions, 0, 2),
      consecutiveTechnicalFailures,
      lastTechnicalFailureReasonCode,
      unknownBlock: row.unknown_block,
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_DATA');
  }
}

function assertAdmissionIntentRow(value: unknown, intent: ExecutionIntentV1): void {
  try {
    const row = exactRow(value, [
      'id', 'payload_version', 'position_id', 'mint', 'side', 'quote_mint',
      'quote_amount_raw', 'decision_fingerprint', 'status', 'requested_at_ms', 'expires_at_ms',
    ] as const);
    if (row.id !== intent.id || row.payload_version !== intent.payloadVersion
      || row.position_id !== intent.positionId || row.mint !== intent.mint
      || row.side !== 'BUY' || row.quote_mint !== intent.quoteMint
      || unsignedBigint(parseBigint(row.quote_amount_raw)) !== intent.quoteAmountRaw
      || row.decision_fingerprint !== intent.decisionFingerprint || row.status !== 'PENDING'
      || textTimestamp(row.requested_at_ms) !== intent.requestedAtMs
      || textTimestamp(row.expires_at_ms) !== intent.expiresAtMs) throw new TypeError();
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('CONFLICT');
  }
}

async function findAdmissionResult(
  client: ExecutionRiskClient,
  intentId: string,
): Promise<Readonly<{
  inputFingerprint: string;
  policyFingerprint: string;
  walletSnapshotFingerprint: string;
  providerSnapshotFingerprint: string;
  result: ExecutionBuyAdmissionResultV1;
}> | null> {
  const result = await client.query(`SELECT report.report_id,report.decision,report.reason_code,
    report.input_fingerprint,
    report.policy_fingerprint,report.wallet_snapshot_fingerprint,
    report.provider_snapshot_fingerprint,report.wallet_state_revision::TEXT
      AS wallet_state_revision,reservation.reservation_id
    FROM execution_risk_admission_reports AS report
    LEFT JOIN execution_exposure_reservations AS reservation
      ON reservation.admission_report_id=report.report_id
    WHERE report.intent_id=$1`, [intentId]);
  if (result.rows.length === 0) return null;
  const row = exactRow(singleRow(result), ADMISSION_REPORT_ROW_KEYS);
  const decision = enumValue(row.decision, ['ADMITTED', 'REJECTED'] as const);
  const reasonCode = row.reason_code === null ? null : enumValue(row.reason_code, [
    'CAPITAL_LIMIT_EXCEEDED', 'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
    'QUOTE_MINT_NOT_ALLOWED', 'RECONCILIATION_REQUIRED', 'EXECUTION_BUILD_FAILED',
    'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED', 'EXECUTION_PROVIDER_FAILED',
    'CONFIRMATION_TIMEOUT', 'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
    'PROVIDER_EXIT_ONLY', 'DECISION_STALE', 'WALLET_MISMATCH',
  ] as const);
  const reservationId = row.reservation_id === null
    ? null : patternedText(row.reservation_id, /^execution_exposure_reservation_[0-9a-f]{64}$/u);
  if ((decision === 'ADMITTED') !== (reasonCode === null)
    || (decision === 'ADMITTED') !== (reservationId !== null)) throw failure('INVALID_DATA');
  return Object.freeze({
    inputFingerprint: patternedText(row.input_fingerprint, HASH),
    policyFingerprint: patternedText(row.policy_fingerprint, HASH),
    walletSnapshotFingerprint: patternedText(row.wallet_snapshot_fingerprint, HASH),
    providerSnapshotFingerprint: patternedText(row.provider_snapshot_fingerprint, HASH),
    result: Object.freeze({
      payloadVersion: 1,
      decision,
      reasonCode,
      reportId: patternedText(row.report_id, /^execution_risk_admission_[0-9a-f]{64}$/u),
      reservationId,
      stateRevision: unsignedBigint(parseBigint(row.wallet_state_revision)),
    }),
  });
}

function admissionIdentity(
  input: ExecutionBuyAdmissionInputV1,
  inputFingerprint: string,
  risk: ReturnType<typeof evaluateBuyRisk>,
  quotaState: 'NORMAL' | 'ENTRY_BLOCKED' | 'EXIT_ONLY' | 'UNKNOWN',
  decision: 'ADMITTED' | 'REJECTED',
  reasonCode: ExecutionBuyAdmissionResultV1['reasonCode'],
): Readonly<{ reportFingerprint: string; intentFingerprint: string }> {
  const intentFingerprint = hash([
    'execution-intent-risk-v1', input.intent.id, input.intent.logicalOrderKey,
    input.intent.decisionFingerprint, input.intent.quoteAmountRaw?.toString() ?? '',
  ]);
  return Object.freeze({
    intentFingerprint,
    reportFingerprint: hash([
      'execution-risk-admission-v1', inputFingerprint, intentFingerprint, input.policy.policyFingerprint,
      input.walletSnapshot.snapshotFingerprint, input.providerSnapshot.snapshotFingerprint,
      risk.reconciledCapitalLamports, risk.projectedExposureLamports,
      risk.conservativeUnrealizedLossLamports, quotaState, decision, reasonCode ?? '',
    ]),
  });
}

function admissionInputFingerprint(input: ExecutionBuyAdmissionInputV1): string {
  return hash([
    'execution-risk-admission-input-v1', input.intent.id, input.intent.decisionFingerprint,
    input.policy.policyFingerprint, input.generationId,
    input.walletSnapshot.snapshotFingerprint, input.providerSnapshot.snapshotFingerprint,
    input.allEndpointsUnavailable ? 1 : 0, input.nowMs,
  ]);
}

function reconciliationCommitFrom(value: unknown): ExecutionReconciliationEvidenceV1 {
  try {
    const commit = exactInput(value, RECONCILIATION_COMMIT_KEYS);
    if (commit.payloadVersion !== 1) throw new TypeError();
    const row = exactInput(commit.evidence, RECONCILIATION_EVIDENCE_KEYS);
    if (row.payloadVersion !== 1) throw new TypeError();
    const result = enumValue(row.result, ['MATCHED', 'NO_EFFECT', 'MISMATCH', 'UNKNOWN'] as const);
    const reasonCode = enumValue(row.reasonCode, [
      'INTENT_SUCCEEDED', 'RECONCILIATION_PROVED_NO_EFFECT', 'RECONCILIATION_REQUIRED',
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED',
    ] as const);
    if ((result === 'MATCHED') !== (reasonCode === 'INTENT_SUCCEEDED')
      || (result === 'NO_EFFECT') !== (reasonCode === 'RECONCILIATION_PROVED_NO_EFFECT')
      || (result === 'UNKNOWN') !== (reasonCode === 'RECONCILIATION_REQUIRED')
      || (result === 'MISMATCH') !== [
        'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED',
      ].includes(reasonCode)) throw new TypeError();
    const finalizedAtMs = nullableTimestamp(row.finalizedAtMs);
    if ((result === 'MATCHED' || result === 'NO_EFFECT') && finalizedAtMs === null) {
      throw new TypeError();
    }
    const observedAtMs = timestamp(row.observedAtMs);
    if (finalizedAtMs !== null && finalizedAtMs < observedAtMs) throw new TypeError();
    return Object.freeze({
      evidenceId: patternedText(row.evidenceId, /^execution_reconciliation_[0-9a-f]{64}$/u),
      payloadVersion: 1,
      evidenceFingerprint: patternedText(row.evidenceFingerprint, HASH),
      intentId: patternedText(row.intentId, /^execution_intent_[0-9a-f]{64}$/u),
      attemptNumber: integer(row.attemptNumber, 1, 2_147_483_647),
      walletGeneration: integer(row.walletGeneration, 1, 2_147_483_647),
      providerId: text(row.providerId, 256),
      side: enumValue(row.side, ['BUY', 'SELL'] as const),
      signature: base58(row.signature, 32, 128),
      blockhash: base58(row.blockhash, 32, 44),
      lastValidBlockHeight: unsignedBigint(row.lastValidBlockHeight),
      messageHash: patternedText(row.messageHash, HASH),
      buildFingerprint: patternedText(row.buildFingerprint, HASH),
      snapshotFingerprint: patternedText(row.snapshotFingerprint, HASH),
      maximumFeeLamports: unsignedBigint(row.maximumFeeLamports),
      maximumFeePayerLamportDebit: unsignedBigint(row.maximumFeePayerLamportDebit),
      signatureHistory: enumValue(row.signatureHistory, ['PRESENT', 'ABSENT', 'UNKNOWN'] as const),
      confirmationStatus: enumValue(
        row.confirmationStatus,
        ['FINALIZED', 'CONFIRMED', 'ORPHANED', 'NOT_FOUND'] as const,
      ),
      finalizedBlockHeight: unsignedBigint(row.finalizedBlockHeight),
      observedSlot: row.observedSlot === null ? null : unsignedBigint(row.observedSlot),
      observedTransactionFingerprint: row.observedTransactionFingerprint === null
        ? null : patternedText(row.observedTransactionFingerprint, HASH),
      feeLamports: unsignedBigint(row.feeLamports),
      walletLamportDelta: signedBigint(row.walletLamportDelta),
      baseDeltaRaw: signedBigint(row.baseDeltaRaw),
      quoteDeltaRaw: signedBigint(row.quoteDeltaRaw),
      unexpectedResidualTokenBalanceRaw: unsignedBigint(row.unexpectedResidualTokenBalanceRaw),
      observedAtMs,
      finalizedAtMs,
      result,
      reasonCode,
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_INPUT');
  }
}

function reconciliationResult(
  evidence: ExecutionReconciliationEvidenceV1,
): ExecutionReconciliationCommitResultV1 {
  return Object.freeze({
    payloadVersion: 1,
    result: evidence.result,
    evidenceId: evidence.evidenceId,
  });
}

type ReconciliationTransition = Readonly<{
  previousStatus: string;
  nextStatus: string;
  reasonCode: string;
  humanMessage: string;
}>;

function reconciliationTransitions(
  initialStatus: string,
  result: ExecutionReconciliationEvidenceV1['result'],
): readonly ReconciliationTransition[] {
  if (result === 'MATCHED') {
    if (initialStatus === 'SUBMITTED' || initialStatus === 'UNKNOWN_REQUIRES_RECONCILIATION') {
      return Object.freeze([
        transition(initialStatus, 'CONFIRMED', 'CONFIRMATION_OBSERVED',
          'Finalized execution effect confirmed.'),
        transition('CONFIRMED', 'SUCCEEDED', 'INTENT_SUCCEEDED',
          'Finalized execution effect reconciled.'),
      ]);
    }
    if (initialStatus === 'CONFIRMED' || initialStatus === 'RECONCILING') {
      return Object.freeze([transition(
        initialStatus, 'SUCCEEDED', 'INTENT_SUCCEEDED',
        'Finalized execution effect reconciled.',
      )]);
    }
  } else if (result === 'NO_EFFECT') {
    if (initialStatus === 'UNKNOWN_REQUIRES_RECONCILIATION') {
      return Object.freeze([transition(
        initialStatus, 'FAILED', 'RECONCILIATION_PROVED_NO_EFFECT',
        'Finalized reconciliation proved no execution effect.',
      )]);
    }
  } else if (initialStatus === 'UNKNOWN_REQUIRES_RECONCILIATION') {
    return Object.freeze([]);
  } else if (['SIGNED_NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED', 'RECONCILING'].includes(initialStatus)) {
    return Object.freeze([transition(
      initialStatus, 'UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILIATION_REQUIRED',
      'Execution effect remains unresolved.',
    )]);
  }
  throw failure('CONFLICT');
}

function transition(
  previousStatus: string,
  nextStatus: string,
  reasonCode: string,
  humanMessage: string,
): ReconciliationTransition {
  return Object.freeze({ previousStatus, nextStatus, reasonCode, humanMessage });
}

function positionsFrom(value: unknown): WalletSnapshotV1['openPositions'] {
  if (!Array.isArray(value) || isProxy(value) || value.length > 2) throw new TypeError();
  const positions = value.map((candidate) => {
    const row = exactInput(candidate, [
      'positionId', 'costBasisLamports', 'conservativeLiquidationLamports',
      'reconciliationStatus',
    ] as const);
    return Object.freeze({
      positionId: text(row.positionId, 256),
      costBasisLamports: positiveBigint(row.costBasisLamports),
      conservativeLiquidationLamports: row.conservativeLiquidationLamports === null
        ? null : unsignedBigint(row.conservativeLiquidationLamports),
      reconciliationStatus: enumValue(
        row.reconciliationStatus,
        ['RECONCILED', 'UNKNOWN'] as const,
      ),
    });
  });
  if (positions.length === 2 && positions[0]?.positionId === positions[1]?.positionId) {
    throw new TypeError();
  }
  return Object.freeze(positions);
}

function positionsFromRow(row: Record<string, unknown>): WalletSnapshotV1['openPositions'] {
  const count = integer(row.open_positions, 0, 2);
  const positions: WalletSnapshotV1['openPositions'][number][] = [];
  for (let index = 1; index <= count; index += 1) {
    const positionId = row[`position_${index}_id`];
    const costBasis = row[`position_${index}_cost_basis_lamports`];
    const liquidation = row[`position_${index}_conservative_liquidation_lamports`];
    const status = row[`position_${index}_reconciliation_status`];
    positions.push(Object.freeze({
      positionId: text(positionId, 256),
      costBasisLamports: positiveBigint(parseBigint(costBasis)),
      conservativeLiquidationLamports: liquidation === null
        ? null : unsignedBigint(parseBigint(liquidation)),
      reconciliationStatus: enumValue(status, ['RECONCILED', 'UNKNOWN'] as const),
    }));
  }
  return Object.freeze(positions);
}

function operationFrom(value: unknown): ProviderUsageOperationV1 {
  try {
    const row = exactInput(value, OPERATION_KEYS);
    return Object.freeze({
      operationId: patternedText(row.operationId, /^execution_provider_operation_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payloadVersion),
      snapshotId: patternedText(row.snapshotId, /^execution_provider_usage_[0-9a-f]{64}$/u),
      providerId: text(row.providerId, 256),
      billingPeriodId: text(row.billingPeriodId, 128),
      category: enumValue(row.category, [
        'ENTRY', 'EXIT', 'CONFIRMATION', 'RECONCILIATION', 'TELEMETRY',
      ] as const),
      logicalOperationId: text(row.logicalOperationId, 256),
      units: positiveBigint(row.units),
    });
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function rateLimitFrom(value: unknown): ProviderRateLimitEventV1 {
  try {
    const row = exactInput(value, RATE_LIMIT_KEYS);
    const endpointId = text(row.endpointId, 128);
    if (endpointId.includes('://')) throw new TypeError();
    return Object.freeze({
      eventId: patternedText(row.eventId, /^execution_provider_rate_limit_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payloadVersion),
      providerId: text(row.providerId, 256),
      billingPeriodId: text(row.billingPeriodId, 128),
      endpointId,
      observedAtMs: timestamp(row.observedAtMs),
    });
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function faultFrom(value: unknown): ExecutionFaultRecordInputV1 {
  try {
    const row = exactInput(value, FAULT_KEYS);
    const result = Object.freeze({
      faultId: patternedText(row.faultId, /^execution_fault_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payloadVersion),
      generationId: patternedText(
        row.generationId,
        /^execution_wallet_generation_[0-9a-f]{64}$/u,
      ),
      intentId: row.intentId === null
        ? null : patternedText(row.intentId, /^execution_intent_[0-9a-f]{64}$/u),
      activationPhase: enumValue(
        row.activationPhase,
        ['NONE', 'CANARY', 'MICRO_LIVE', 'PILOT'] as const,
      ),
      stage: enumValue(row.stage, [
        'BUILD', 'SIMULATION', 'PROVIDER', 'SUBMISSION', 'CONFIRMATION',
        'RECONCILIATION', 'VALIDATION', 'POLICY',
      ] as const),
      side: enumValue(row.side, ['BUY', 'SELL'] as const),
      timing: enumValue(row.timing, ['PRE_SIGNATURE', 'AFTER_SIGNATURE'] as const),
      classification: enumValue(row.classification, [
        'TRANSIENT', 'DETERMINISTIC', 'AMBIGUOUS', 'PROVED_NO_EFFECT', 'CRITICAL',
      ] as const),
      exactSignedBytesAvailable: boolean(row.exactSignedBytesAvailable),
      reasonCode: enumValue(row.reasonCode, FAULT_REASON_CODES),
      observedAtMs: timestamp(row.observedAtMs),
    });
    technicalFailureReason(result);
    classifyExecutionFault({
      stage: result.stage,
      side: result.side,
      timing: result.timing,
      classification: result.classification,
      consecutiveTechnicalFailures: 0,
      exactSignedBytesAvailable: result.exactSignedBytesAvailable,
    });
    return result;
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function reconciledSuccessFrom(value: unknown): ExecutionReconciledSuccessInputV1 {
  try {
    const row = exactInput(value, RECONCILED_SUCCESS_KEYS);
    return Object.freeze({
      payloadVersion: one(row.payloadVersion),
      evidenceId: patternedText(
        row.evidenceId,
        /^execution_reconciliation_[0-9a-f]{64}$/u,
      ),
      generationId: patternedText(
        row.generationId,
        /^execution_wallet_generation_[0-9a-f]{64}$/u,
      ),
      activationPhase: enumValue(
        row.activationPhase,
        ['NONE', 'CANARY', 'MICRO_LIVE', 'PILOT'] as const,
      ),
    });
  } catch {
    throw failure('INVALID_INPUT');
  }
}

function technicalFailureReason(
  input: ExecutionFaultRecordInputV1,
): ExecutionTechnicalFailureReasonCode | null {
  const expected = input.stage === 'BUILD' ? 'EXECUTION_BUILD_FAILED'
    : input.stage === 'SIMULATION'
      ? (input.side === 'BUY' ? 'BUY_SIMULATION_FAILED' : 'SELL_SIMULATION_FAILED')
      : input.stage === 'PROVIDER' ? 'EXECUTION_PROVIDER_FAILED'
        : input.stage === 'CONFIRMATION' ? 'CONFIRMATION_TIMEOUT'
          : input.stage === 'RECONCILIATION' ? 'RECONCILIATION_REQUIRED'
            : null;
  const isTechnicalCode = [
    'EXECUTION_BUILD_FAILED', 'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED',
    'EXECUTION_PROVIDER_FAILED', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
  ].includes(input.reasonCode);
  if (isTechnicalCode && input.reasonCode !== expected) throw new TypeError();
  return expected === input.reasonCode ? expected : null;
}

function faultFingerprint(input: ExecutionFaultRecordInputV1): string {
  return hash([
    'execution-fault-v1', input.faultId, input.payloadVersion, input.generationId,
    input.intentId ?? '', input.activationPhase, input.stage, input.side, input.timing,
    input.classification, input.exactSignedBytesAvailable ? 1 : 0,
    input.reasonCode, input.observedAtMs,
  ]);
}

function faultResult(
  faultId: string,
  consecutiveTechnicalFailures: number,
  retryDecision: ExecutionRetryDecision,
): ExecutionFaultRecordResultV1 {
  return Object.freeze({
    payloadVersion: 1,
    faultId,
    consecutiveTechnicalFailures,
    retryDecision,
    buyBlocked: consecutiveTechnicalFailures >= 2,
  });
}

async function findGeneration(
  client: ExecutionRiskClient,
  generationId: string,
): Promise<WalletGenerationV1 | null> {
  const result = await client.query(`SELECT ${GENERATION_PROJECTION}
    FROM execution_wallet_generations WHERE generation_id=$1 FOR UPDATE`, [generationId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows.length === 0 ? null : decodeGeneration(result.rows[0]);
}

async function findWalletSnapshot(
  client: ExecutionRiskClient,
  snapshotId: string,
  currentOnly = false,
): Promise<WalletSnapshotV1 | null> {
  const result = await client.query(`SELECT ${WALLET_SNAPSHOT_PROJECTION}
    FROM execution_wallet_snapshots WHERE snapshot_id=$1
      AND (NOT $2::BOOLEAN OR superseded_at IS NULL) FOR UPDATE`, [snapshotId, currentOnly]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows.length === 0 ? null : decodeWalletSnapshot(result.rows[0]);
}

async function findProviderSnapshot(
  client: ExecutionRiskClient,
  snapshotId: string,
  currentOnly = false,
): Promise<ProviderUsageSnapshotV1 | null> {
  const result = await client.query(`SELECT ${PROVIDER_PROJECTION}
    FROM execution_provider_usage_snapshots WHERE snapshot_id=$1
      AND (NOT $2::BOOLEAN OR superseded_at IS NULL) FOR UPDATE`, [snapshotId, currentOnly]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows.length === 0 ? null : decodeProviderSnapshot(result.rows[0]);
}

function decodeGeneration(value: unknown): WalletGenerationV1 {
  try {
    const row = exactRow(value, GENERATION_ROW_KEYS);
    return Object.freeze({
      generationId: patternedText(row.generation_id, /^execution_wallet_generation_[0-9a-f]{64}$/u),
      payloadVersion: one(row.payload_version),
      walletPublicKey: base58(row.wallet_public_key, 32, 44),
      cluster: enumValue(row.cluster, ['mainnet-beta', 'devnet', 'testnet'] as const),
      genesisHash: base58(row.genesis_hash, 32, 44),
      generation: integer(row.generation, 1, 2_147_483_647),
      createdAtMs: textTimestamp(row.created_at_ms),
      retiredAtMs: nullableTextTimestamp(row.retired_at_ms),
    });
  } catch {
    throw failure('INVALID_DATA');
  }
}

function decodeWalletSnapshot(value: unknown): WalletSnapshotV1 {
  try {
    const row = exactRow(value, WALLET_SNAPSHOT_ROW_KEYS);
    return walletSnapshotFrom({
      snapshotId: row.snapshot_id,
      payloadVersion: row.payload_version,
      snapshotFingerprint: row.snapshot_fingerprint,
      generationId: row.generation_id,
      providerId: row.provider_id,
      stateRevision: parseBigint(row.state_revision),
      slot: parseBigint(row.slot),
      blockTimeMs: nullableTextTimestamp(row.block_time_ms),
      observedAtMs: textTimestamp(row.observed_at_ms),
      commitment: row.commitment,
      walletLamports: parseBigint(row.wallet_lamports),
      tokenBalanceCount: row.token_balance_count,
      openPositions: positionsFromRow(row),
      realizedNetPnlRaw: parseBigint(row.realized_net_pnl_raw),
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && error.code === 'INVALID_INPUT') {
      throw failure('INVALID_DATA');
    }
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_DATA');
  }
}

function decodeProviderSnapshot(value: unknown): ProviderUsageSnapshotV1 {
  try {
    const row = exactRow(value, PROVIDER_ROW_KEYS);
    return providerSnapshotFrom({
      snapshotId: row.snapshot_id,
      payloadVersion: row.payload_version,
      snapshotFingerprint: row.snapshot_fingerprint,
      providerId: row.provider_id,
      planId: row.plan_id,
      billingPeriodId: row.billing_period_id,
      billingPeriodStartedAtMs: textTimestamp(row.billing_period_started_at_ms),
      billingPeriodEndsAtMs: textTimestamp(row.billing_period_ends_at_ms),
      limitUnits: parseBigint(row.limit_units),
      usedUnits: parseBigint(row.used_units),
      measuredAtMs: textTimestamp(row.measured_at_ms),
      expiresAtMs: textTimestamp(row.expires_at_ms),
      provenance: row.provenance,
    });
  } catch (error) {
    if (error instanceof ExecutionRiskRepositoryError && error.code === 'INVALID_INPUT') {
      throw failure('INVALID_DATA');
    }
    if (error instanceof ExecutionRiskRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
    throw failure('INVALID_DATA');
  }
}

function decodeOperation(value: unknown): ProviderUsageOperationV1 {
  const row = exactRow(value, [
    'operation_id', 'payload_version', 'snapshot_id', 'provider_id', 'billing_period_id',
    'category', 'logical_operation_id', 'units',
  ] as const);
  return operationFrom({
    operationId: row.operation_id, payloadVersion: row.payload_version,
    snapshotId: row.snapshot_id, providerId: row.provider_id,
    billingPeriodId: row.billing_period_id, category: row.category,
    logicalOperationId: row.logical_operation_id, units: parseBigint(row.units),
  });
}

function decodeRateLimit(value: unknown): ProviderRateLimitEventV1 {
  const row = exactRow(value, [
    'event_id', 'payload_version', 'provider_id', 'billing_period_id', 'endpoint_id',
    'observed_at_ms',
  ] as const);
  return rateLimitFrom({
    eventId: row.event_id, payloadVersion: row.payload_version,
    providerId: row.provider_id, billingPeriodId: row.billing_period_id,
    endpointId: row.endpoint_id, observedAtMs: textTimestamp(row.observed_at_ms),
  });
}

function generationValues(value: WalletGenerationDraftV1): readonly unknown[] {
  return [value.generationId, value.payloadVersion, value.walletPublicKey, value.cluster,
    value.genesisHash, value.generation];
}

function walletSnapshotValues(value: WalletSnapshotV1): readonly unknown[] {
  const [first, second] = value.openPositions;
  return [value.snapshotId, value.payloadVersion, value.snapshotFingerprint, value.generationId,
    value.providerId, value.stateRevision.toString(), value.slot.toString(), value.blockTimeMs,
    value.observedAtMs, value.commitment, value.walletLamports.toString(), value.tokenBalanceCount,
    value.openPositions.length,
    first?.positionId ?? null, first?.costBasisLamports.toString() ?? null,
    first?.conservativeLiquidationLamports?.toString() ?? null,
    first?.reconciliationStatus ?? null,
    second?.positionId ?? null, second?.costBasisLamports.toString() ?? null,
    second?.conservativeLiquidationLamports?.toString() ?? null,
    second?.reconciliationStatus ?? null,
    value.realizedNetPnlRaw.toString()];
}

function providerSnapshotValues(value: ProviderUsageSnapshotV1): readonly unknown[] {
  return [value.snapshotId, value.payloadVersion, value.snapshotFingerprint, value.providerId,
    value.planId, value.billingPeriodId, value.billingPeriodStartedAtMs,
    value.billingPeriodEndsAtMs, value.limitUnits.toString(), value.usedUnits.toString(),
    value.measuredAtMs, value.expiresAtMs, value.provenance];
}

function operationValues(value: ProviderUsageOperationV1): readonly unknown[] {
  return [value.operationId, value.payloadVersion, value.snapshotId, value.providerId,
    value.billingPeriodId, value.category, value.logicalOperationId, value.units.toString()];
}

function rateLimitValues(value: ProviderRateLimitEventV1): readonly unknown[] {
  return [value.eventId, value.payloadVersion, value.providerId, value.billingPeriodId,
    value.endpointId, value.observedAtMs];
}

function sameGeneration(left: WalletGenerationV1, right: WalletGenerationDraftV1): boolean {
  return left.generationId === right.generationId
    && left.walletPublicKey === right.walletPublicKey && left.cluster === right.cluster
    && left.genesisHash === right.genesisHash && left.generation === right.generation;
}

function sameWalletSnapshot(left: WalletSnapshotV1, right: WalletSnapshotV1): boolean {
  return WALLET_SNAPSHOT_KEYS.filter((key) => key !== 'openPositions')
    .every((key) => left[key] === right[key])
    && left.openPositions.length === right.openPositions.length
    && left.openPositions.every((position, index) => {
      const other = right.openPositions[index];
      return position.positionId === other?.positionId
        && position.costBasisLamports === other.costBasisLamports
        && position.conservativeLiquidationLamports === other.conservativeLiquidationLamports
        && position.reconciliationStatus === other.reconciliationStatus;
    });
}

function sameProviderSnapshot(left: ProviderUsageSnapshotV1, right: ProviderUsageSnapshotV1): boolean {
  return left.snapshotId === right.snapshotId
    && left.snapshotFingerprint === right.snapshotFingerprint
    && left.providerId === right.providerId && left.planId === right.planId
    && left.billingPeriodId === right.billingPeriodId
    && left.billingPeriodStartedAtMs === right.billingPeriodStartedAtMs
    && left.billingPeriodEndsAtMs === right.billingPeriodEndsAtMs
    && left.limitUnits === right.limitUnits && left.usedUnits === right.usedUnits
    && left.measuredAtMs === right.measuredAtMs && left.expiresAtMs === right.expiresAtMs
    && left.provenance === right.provenance;
}

function sameOperation(left: ProviderUsageOperationV1, right: ProviderUsageOperationV1): boolean {
  return OPERATION_KEYS.every((key) => left[key] === right[key]);
}

function sameRateLimit(left: ProviderRateLimitEventV1, right: ProviderRateLimitEventV1): boolean {
  return RATE_LIMIT_KEYS.every((key) => left[key] === right[key]);
}

function singleRow(result: QueryResult): Row {
  const [row] = result.rows;
  if (result.rowCount !== 1 || result.rows.length !== 1 || row === undefined) {
    throw failure('INVALID_DATA');
  }
  return row;
}

function exactInput<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (!isPlainRecord(value) || !sameKeys(value, keys)) throw new TypeError();
  return value;
}

function exactRow<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (!isPlainRecord(value) || !sameKeys(value, keys)) throw failure('INVALID_DATA');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length && own.every((key, index) => key === expected[index]);
}

function one(value: unknown): 1 {
  if (value !== 1) throw new TypeError();
  return 1;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError();
  return value;
}

function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value) > maximumBytes) throw new TypeError();
  return value;
}

function patternedText(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError();
  return value;
}

function base58(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
    || !BASE58.test(value)) throw new TypeError();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) throw new TypeError();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError();
  return value;
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new TypeError();
  return value;
}

function positiveBigint(value: unknown): bigint {
  const result = unsignedBigint(value);
  if (result === 0n) throw new TypeError();
  return result;
}

function signedBigint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < I128_MIN || value > I128_MAX) throw new TypeError();
  return value;
}

function parseBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError();
  return BigInt(value);
}

function timestamp(value: unknown): number {
  return integer(value, 0, DATE_MAX_MS);
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function textTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError();
  const parsed = Number(value);
  return timestamp(parsed);
}

function nullableTextTimestamp(value: unknown): number | null {
  return value === null ? null : textTimestamp(value);
}

function databaseCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value : null;
}

function failure(code: ExecutionRiskRepositoryErrorCode): ExecutionRiskRepositoryError {
  const error = new ExecutionRiskRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}

function hash(parts: readonly (string | number | bigint)[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    const textValue = String(part);
    digest.update(String(Buffer.byteLength(textValue)));
    digest.update(':');
    digest.update(textValue);
    digest.update('|');
  }
  return digest.digest('hex');
}

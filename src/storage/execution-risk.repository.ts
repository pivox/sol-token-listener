import { isProxy } from 'node:util/types';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from '../domain/execution-provider-quota.js';
import type {
  ExecutionBuyAdmissionInputV1,
  ExecutionBuyAdmissionResultV1,
  ExecutionReconciliationCommitResultV1,
  ExecutionReconciliationCommitV1,
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

interface ExecutionRiskClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionRiskPool {
  connect(): Promise<ExecutionRiskClient>;
}

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
  'token_balance_count', 'open_positions', 'realized_net_pnl_raw',
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
      const latest = await client.query(`SELECT state_revision::TEXT AS state_revision
        FROM execution_wallet_snapshots WHERE generation_id=$1
        ORDER BY state_revision DESC LIMIT 1 FOR UPDATE`, [draft.generationId]);
      if (latest.rows.length > 1) throw failure('INVALID_DATA');
      const latestRevision = latest.rows.length === 0
        ? null
        : unsignedBigint(parseBigint(
          exactRow(latest.rows[0], ['state_revision'] as const).state_revision,
        ));
      if (latestRevision !== null && draft.stateRevision <= latestRevision) throw failure('CONFLICT');
      try {
        const result = await client.query(`INSERT INTO execution_wallet_snapshots (
          snapshot_id,payload_version,snapshot_fingerprint,generation_id,provider_id,
          state_revision,slot,block_time,observed_at,commitment,wallet_lamports,
          token_balance_count,open_positions,realized_net_pnl_raw
        ) VALUES ($1,$2,$3,$4,$5,$6::BIGINT,$7::BIGINT,
          CASE WHEN $8::BIGINT IS NULL THEN NULL ELSE TIMESTAMPTZ 'epoch'
            + ($8::BIGINT * INTERVAL '1 millisecond') END,
          TIMESTAMPTZ 'epoch' + ($9::BIGINT * INTERVAL '1 millisecond'),
          $10,$11::NUMERIC,$12,$13,$14::NUMERIC)
        RETURNING ${WALLET_SNAPSHOT_PROJECTION}`, walletSnapshotValues(draft));
        return decodeWalletSnapshot(singleRow(result));
      } catch (error) {
        if (['23503', '23505'].includes(databaseCode(error) ?? '')) throw failure('CONFLICT');
        throw error;
      }
    });
  }

  public async appendProviderUsage(input: ProviderUsageSnapshotV1): Promise<ProviderUsageSnapshotV1> {
    const snapshot = providerSnapshotFrom(input);
    return this.transaction(async (client) => {
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
        if (snapshot.billingPeriodStartedAtMs < latest.billingPeriodStartedAtMs
          || (snapshot.billingPeriodStartedAtMs === latest.billingPeriodStartedAtMs
            && snapshot.measuredAtMs <= latest.measuredAtMs)
          || (snapshot.billingPeriodStartedAtMs === latest.billingPeriodStartedAtMs
            && (snapshot.billingPeriodId !== latest.billingPeriodId
              || snapshot.planId !== latest.planId
              || snapshot.limitUnits !== latest.limitUnits
              || snapshot.usedUnits < latest.usedUnits))) {
          throw failure('STALE_MEASUREMENT');
        }
      }
      try {
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
        return decodeProviderSnapshot(singleRow(result));
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

  public admitBuy(input: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1> {
    void input;
    return Promise.reject(failure('OPERATION_UNAVAILABLE'));
  }

  public reconcile(
    input: ExecutionReconciliationCommitV1,
  ): Promise<ExecutionReconciliationCommitResultV1> {
    void input;
    return Promise.reject(failure('OPERATION_UNAVAILABLE'));
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
      openPositions: integer(row.openPositions, 0, 2),
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
): Promise<WalletSnapshotV1 | null> {
  const result = await client.query(`SELECT ${WALLET_SNAPSHOT_PROJECTION}
    FROM execution_wallet_snapshots WHERE snapshot_id=$1 FOR UPDATE`, [snapshotId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows.length === 0 ? null : decodeWalletSnapshot(result.rows[0]);
}

async function findProviderSnapshot(
  client: ExecutionRiskClient,
  snapshotId: string,
): Promise<ProviderUsageSnapshotV1 | null> {
  const result = await client.query(`SELECT ${PROVIDER_PROJECTION}
    FROM execution_provider_usage_snapshots WHERE snapshot_id=$1 FOR UPDATE`, [snapshotId]);
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
      openPositions: row.open_positions,
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
  return [value.snapshotId, value.payloadVersion, value.snapshotFingerprint, value.generationId,
    value.providerId, value.stateRevision.toString(), value.slot.toString(), value.blockTimeMs,
    value.observedAtMs, value.commitment, value.walletLamports.toString(), value.tokenBalanceCount,
    value.openPositions, value.realizedNetPnlRaw.toString()];
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
  return WALLET_SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
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

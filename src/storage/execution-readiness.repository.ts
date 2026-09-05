import { isProxy } from 'node:util/types';
import { createProviderUsageSnapshot } from '../domain/execution-provider-quota.js';
import { createExecutionWalletGeneration } from '../domain/execution-readiness.js';
import { assertExecutionWalletSnapshot } from '../domain/execution-wallet-snapshot.js';
import type {
  ExecutionReadinessCommitV1,
  ExecutionReadinessRepository,
} from '../ports/execution-readiness-repository.js';
import {
  appendProviderUsageInTransaction,
  appendWalletSnapshotInTransaction,
  type ExecutionRiskClient,
  type ExecutionRiskPool,
} from './execution-risk.repository.js';

const COMMIT_KEYS = Object.freeze(['generation', 'walletSnapshot', 'providerSnapshot'] as const);
const GENERATION_KEYS = Object.freeze([
  'generationId', 'payloadVersion', 'walletPublicKey', 'cluster', 'genesisHash', 'generation',
] as const);
const PROVIDER_SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', 'providerId', 'planId',
  'billingPeriodId', 'billingPeriodStartedAtMs', 'billingPeriodEndsAtMs',
  'limitUnits', 'usedUnits', 'measuredAtMs', 'expiresAtMs', 'provenance',
] as const);
const COMMIT_FRESHNESS_MARGIN_MS = 5_000;
const INTERNAL_ERRORS = new WeakSet<ExecutionReadinessRepositoryError>();

export type ExecutionReadinessRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN';

export class ExecutionReadinessRepositoryError extends Error {
  public constructor(public readonly code: ExecutionReadinessRepositoryErrorCode) {
    super('Execution readiness repository operation failed.');
    this.name = 'ExecutionReadinessRepositoryError';
  }
}

export class PostgresExecutionReadinessRepository implements ExecutionReadinessRepository {
  public constructor(private readonly pool: ExecutionRiskPool) {}

  public async commit(inputValue: ExecutionReadinessCommitV1): Promise<ExecutionReadinessCommitV1> {
    let input: ExecutionReadinessCommitV1;
    try {
      input = validatedCommit(inputValue);
    } catch {
      throw failure('INVALID_INPUT');
    }
    let client: ExecutionRiskClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw failure('DATABASE_FAILURE');
    }
    let transactionStarted = false;
    let commitStarted = false;
    let released = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [input.generation.generationId]);
      await persistGeneration(client, input.generation);
      await validateInitialRiskState(client, input.generation.generationId);
      await validateNoActiveWalletPositions(client, input.generation.walletPublicKey);
      await appendWalletSnapshotInTransaction(client, input.walletSnapshot);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))',
        [input.providerSnapshot.providerId]);
      await appendProviderUsageInTransaction(client, input.providerSnapshot);
      await validateProviderEvidenceFreshness(client, input.providerSnapshot.expiresAtMs);
      commitStarted = true;
      await client.query('COMMIT');
      return input;
    } catch (error) {
      if (transactionStarted && !commitStarted) {
        try { await client.query('ROLLBACK'); } catch {
          client.release(true);
          released = true;
          throw failure('DATABASE_FAILURE');
        }
      }
      client.release(true);
      released = true;
      if (error instanceof ExecutionReadinessRepositoryError && INTERNAL_ERRORS.has(error)) {
        throw error;
      }
      throw failure(commitStarted ? 'COMMIT_OUTCOME_UNKNOWN' : 'DATABASE_FAILURE');
    } finally {
      if (!released) client.release();
    }
  }
}

async function validateNoActiveWalletPositions(
  client: ExecutionRiskClient,
  walletPublicKey: string,
): Promise<void> {
  const result = await client.query(`SELECT COUNT(*)::TEXT AS active_position_count
    FROM execution_live_positions
    WHERE wallet_public_key=$1 AND state IN ('OPEN','EXIT_PENDING','UNKNOWN')`, [walletPublicKey]);
  if (result.rows.length !== 1 || result.rows[0]?.active_position_count !== '0') {
    throw failure('CONFLICT');
  }
}

async function validateProviderEvidenceFreshness(
  client: ExecutionRiskClient,
  expiresAtMs: number,
): Promise<void> {
  const result = await client.query(`SELECT ($1::NUMERIC >=
    trunc(EXTRACT(EPOCH FROM clock_timestamp())*1000)::NUMERIC+$2::NUMERIC)
    AS evidence_fresh`, [expiresAtMs, COMMIT_FRESHNESS_MARGIN_MS]);
  if (result.rows.length !== 1 || result.rows[0]?.evidence_fresh !== true) {
    throw failure('CONFLICT');
  }
}

async function persistGeneration(
  client: ExecutionRiskClient,
  generation: ExecutionReadinessCommitV1['generation'],
): Promise<void> {
  const result = await client.query(`SELECT generation_id,payload_version,wallet_public_key,
    cluster,genesis_hash,generation,retired_at FROM execution_wallet_generations
    WHERE generation_id=$1`, [generation.generationId]);
  if (result.rows.length > 1) throw failure('CONFLICT');
  if (result.rows.length === 1) {
    const row = result.rows[0];
    if (row?.generation_id !== generation.generationId
      || row.payload_version !== 1 || row.wallet_public_key !== generation.walletPublicKey
      || row.cluster !== generation.cluster || row.genesis_hash !== generation.genesisHash
      || row.generation !== generation.generation || row.retired_at !== null) {
      throw failure('CONFLICT');
    }
    return;
  }
  const inserted = await client.query(`INSERT INTO execution_wallet_generations (
    generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation
  ) VALUES ($1,1,$2,$3,$4,$5)`, [generation.generationId, generation.walletPublicKey,
    generation.cluster, generation.genesisHash, generation.generation]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
  const state = await client.query(`INSERT INTO execution_wallet_risk_state (
    generation_id,reconciled_capital_lamports,reserved_exposure_raw,
    conservative_drawdown_raw
  ) VALUES ($1,0,0,0)`, [generation.generationId]);
  if (state.rowCount !== 1) throw failure('CONFLICT');
}

async function validateInitialRiskState(
  client: ExecutionRiskClient,
  generationId: string,
): Promise<void> {
  const result = await client.query(`SELECT state_revision::TEXT AS state_revision,
    reconciled_capital_lamports::TEXT AS reconciled_capital_lamports,
    reserved_exposure_raw::TEXT AS reserved_exposure_raw,open_positions,
    conservative_drawdown_raw::TEXT AS conservative_drawdown_raw,
    consecutive_technical_failures,last_technical_failure_reason_code,unknown_block
    FROM execution_wallet_risk_state WHERE generation_id=$1 FOR UPDATE`, [generationId]);
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (row?.state_revision !== '0'
    || row.reconciled_capital_lamports !== '0' || row.reserved_exposure_raw !== '0'
    || row.open_positions !== 0 || row.conservative_drawdown_raw !== '0'
    || row.consecutive_technical_failures !== 0
    || row.last_technical_failure_reason_code !== null || row.unknown_block !== false) {
    throw failure('CONFLICT');
  }
}

function validatedCommit(input: unknown): ExecutionReadinessCommitV1 {
  const row = exactFrozenRecord(input, COMMIT_KEYS);
  if (!Object.isFrozen(row.generation) || !Object.isFrozen(row.walletSnapshot)
    || !Object.isFrozen(row.providerSnapshot)) throw failure('INVALID_INPUT');
  const generationRecord = exactFrozenRecord(row.generation, GENERATION_KEYS);
  const generationRaw = generationRecord as unknown as ExecutionReadinessCommitV1['generation'];
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey: generationRaw.walletPublicKey,
    cluster: generationRaw.cluster,
    genesisHash: generationRaw.genesisHash,
    generation: generationRaw.generation,
  }));
  if (generationRecord.payloadVersion !== 1
    || generationRaw.generationId !== generation.generationId) {
    throw failure('INVALID_INPUT');
  }
  assertExecutionWalletSnapshot(row.walletSnapshot);
  const walletSnapshot = row.walletSnapshot;
  if (walletSnapshot.generationId !== generation.generationId
    || walletSnapshot.stateRevision !== 0n || walletSnapshot.openPositions.length !== 0
    || walletSnapshot.realizedNetPnlRaw !== 0n) throw failure('INVALID_INPUT');
  const providerRecord = exactFrozenRecord(row.providerSnapshot, PROVIDER_SNAPSHOT_KEYS);
  const providerRaw = providerRecord as unknown as ExecutionReadinessCommitV1['providerSnapshot'];
  const providerSnapshot = createProviderUsageSnapshot(Object.freeze({
    providerId: providerRaw.providerId, planId: providerRaw.planId,
    billingPeriodId: providerRaw.billingPeriodId,
    billingPeriodStartedAtMs: providerRaw.billingPeriodStartedAtMs,
    billingPeriodEndsAtMs: providerRaw.billingPeriodEndsAtMs,
    limitUnits: providerRaw.limitUnits, usedUnits: providerRaw.usedUnits,
    measuredAtMs: providerRaw.measuredAtMs, expiresAtMs: providerRaw.expiresAtMs,
    provenance: providerRaw.provenance,
  }));
  if (providerRaw.snapshotId !== providerSnapshot.snapshotId
    || providerRaw.snapshotFingerprint !== providerSnapshot.snapshotFingerprint
    || walletSnapshot.providerId !== providerSnapshot.providerId) throw failure('INVALID_INPUT');
  return Object.freeze({ generation, walletSnapshot, providerSnapshot });
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || !Object.isFrozen(value)) throw failure('INVALID_INPUT');
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure('INVALID_INPUT');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw failure('INVALID_INPUT');
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw failure('INVALID_INPUT');
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function failure(code: ExecutionReadinessRepositoryErrorCode): ExecutionReadinessRepositoryError {
  const error = new ExecutionReadinessRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}

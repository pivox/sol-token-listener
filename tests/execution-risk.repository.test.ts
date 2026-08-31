import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { evaluateExecutionReconciliation } from '../src/domain/execution-reconciliation.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { ExecutionAdmissionService } from '../src/executor-risk/admission-service.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionRiskRepositoryError,
  PostgresExecutionRiskRepository,
} from '../src/storage/execution-risk.repository.js';
import { migrateDatabase } from '../src/storage/database.js';

const publicKey = '11111111111111111111111111111111';
const genesisHash = '2'.repeat(32);

void test('wallet generation and snapshot writes replay exactly and reject conflicts', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk repository wallet test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_repository_wallet', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionRiskRepository(pool);
    const generation = generationDraft('a', 1);
    const created = await repository.registerWalletGeneration(generation);
    assert.deepEqual(await repository.registerWalletGeneration(generation), created);
    assert.equal(created.walletPublicKey, publicKey);
    await assert.rejects(
      repository.registerWalletGeneration(generationDraft('b', 2)),
      isRepositoryError('CONFLICT'),
    );

    const snapshot = walletSnapshotDraft(created.generationId, 'c', 0n);
    assert.deepEqual(await repository.appendWalletSnapshot(snapshot), snapshot);
    assert.deepEqual(await repository.appendWalletSnapshot(snapshot), snapshot);
    await assert.rejects(
      repository.appendWalletSnapshot({ ...snapshot, snapshotId: id('wallet_snapshot', 'd') }),
      isRepositoryError('CONFLICT'),
    );
    const positioned = walletSnapshotDraft(created.generationId, 'e', 1n, [{
      positionId: 'position:test',
      costBasisLamports: 500n,
      conservativeLiquidationLamports: 450n,
      reconciliationStatus: 'RECONCILED',
    }]);
    assert.deepEqual(await repository.appendWalletSnapshot(positioned), positioned);
  });
});

void test('provider usage is monotone and operations and 429 events are idempotent', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk repository provider test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_repository_provider', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionRiskRepository(pool);
    const first = providerSnapshot(1_000, 1_100, 10);
    assert.deepEqual(await repository.appendProviderUsage(first), first);
    assert.deepEqual(await repository.appendProviderUsage(first), first);
    await assert.rejects(
      repository.appendProviderUsage(providerSnapshot(900, 1_050, 11)),
      isRepositoryError('STALE_MEASUREMENT'),
    );

    const operation = {
      operationId: `execution_provider_operation_${'d'.repeat(64)}`,
      payloadVersion: 1 as const,
      snapshotId: first.snapshotId,
      providerId: first.providerId,
      billingPeriodId: first.billingPeriodId,
      category: 'ENTRY' as const,
      logicalOperationId: 'intent:test',
      units: 3n,
    };
    assert.equal(await repository.recordProviderOperation(operation), 'RECORDED');
    assert.equal(await repository.recordProviderOperation(operation), 'REPLAYED');
    await assert.rejects(
      repository.recordProviderOperation({ ...operation, units: 4n }),
      isRepositoryError('CONFLICT'),
    );

    const rateLimit = {
      eventId: `execution_provider_rate_limit_${'e'.repeat(64)}`,
      payloadVersion: 1 as const,
      providerId: first.providerId,
      billingPeriodId: first.billingPeriodId,
      endpointId: 'primary',
      observedAtMs: 1_050,
    };
    assert.equal(await repository.recordRateLimit(rateLimit), 'RECORDED');
    assert.equal(await repository.recordRateLimit(rateLimit), 'REPLAYED');
    await assert.rejects(
      repository.recordRateLimit({ ...rateLimit, endpointId: 'secondary' }),
      isRepositoryError('CONFLICT'),
    );
  });
});

void test('repository failures expose only a fixed redacted error', async () => {
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      throw new Error('postgresql://operator:secret@private.invalid/database');
    },
  });
  await assert.rejects(repository.registerWalletGeneration(generationDraft('f', 1)), (error) => {
    assert.equal(error instanceof ExecutionRiskRepositoryError, true);
    assert.equal((error as Error).message, 'Execution risk repository operation failed.');
    assert.equal(String(error).includes('secret'), false);
    assert.equal((error as Error & { readonly cause?: unknown }).cause, undefined);
    return true;
  });
});

void test('repository rejects malformed rows without exposing their contents', async () => {
  const calls: string[] = [];
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      return {
        async query(text: string) {
          calls.push(text);
          if (text.includes('FROM execution_wallet_generations')) {
            return { rowCount: 1, rows: [{ generation_id: 'hostile-secret' }] };
          }
          return { rowCount: null, rows: [] };
        },
        release() {},
      };
    },
  });
  await assert.rejects(
    repository.registerWalletGeneration(generationDraft('f', 1)),
    isRepositoryError('INVALID_DATA'),
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
});

void test('a commit ambiguity is fail-closed and redacted', async () => {
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      return {
        async query(text: string) {
          if (text === 'COMMIT') throw new Error('secret commit transport failure');
          if (text.includes('FROM execution_wallet_generations')) {
            return { rowCount: 0, rows: [] };
          }
          if (text.includes('INSERT INTO execution_wallet_generations')) {
            return { rowCount: 1, rows: [generationRow('f')] };
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  });
  await assert.rejects(
    repository.registerWalletGeneration(generationDraft('f', 1)),
    isRepositoryError('COMMIT_OUTCOME_UNKNOWN'),
  );
});

void test('reconciliation atomically consumes, releases or holds reservations and replays exactly', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk reconciliation repository test');
  if (databaseUrl === null) return;
  const cases = [
    ['MATCHED', 'SUBMITTED', 'CONSUMED', 'SUCCEEDED'],
    ['NO_EFFECT', 'UNKNOWN_REQUIRES_RECONCILIATION', 'RELEASED', 'FAILED'],
    ['MISMATCH', 'SUBMITTED', 'UNKNOWN_HELD', 'UNKNOWN_REQUIRES_RECONCILIATION'],
    ['UNKNOWN', 'SUBMITTED', 'UNKNOWN_HELD', 'UNKNOWN_REQUIRES_RECONCILIATION'],
  ] as const;
  for (const [outcome, initialStatus, reservationState, intentStatus] of cases) {
    await withTemporarySchema(databaseUrl, `execution_risk_reconcile_${outcome.toLowerCase()}`, async (pool) => {
      const fixture = await reconciliationFixture(pool, outcome, initialStatus);
      const evidence = reconciliationEvidence(fixture.intentId, outcome, fixture.snapshotFingerprint);
      const result = await fixture.repository.reconcile({ payloadVersion: 1, evidence });
      assert.equal(result.result, outcome);
      assert.deepEqual(await fixture.repository.reconcile({ payloadVersion: 1, evidence }), result);
      const durable = await pool.query(`SELECT reservation.state,intent.status,
        intent.last_reason_code,risk.reserved_exposure_raw::TEXT AS exposure,
        risk.open_positions,risk.unknown_block,
        (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence) AS evidence_count
        FROM execution_exposure_reservations AS reservation
        JOIN execution_intents AS intent ON intent.id=reservation.intent_id
        JOIN execution_wallet_risk_state AS risk ON risk.generation_id=reservation.generation_id`);
      assert.equal(durable.rows[0]?.state, reservationState);
      assert.equal(durable.rows[0]?.status, intentStatus);
      assert.equal(durable.rows[0]?.evidence_count, 1);
      if (outcome === 'NO_EFFECT') {
        assert.equal(durable.rows[0]?.last_reason_code, 'RECONCILIATION_PROVED_NO_EFFECT');
        assert.equal(durable.rows[0]?.exposure, '0');
        assert.equal(durable.rows[0]?.open_positions, 0);
      } else if (outcome === 'MATCHED') {
        assert.equal(durable.rows[0]?.last_reason_code, 'INTENT_SUCCEEDED');
        assert.equal(durable.rows[0]?.exposure, '90000');
        assert.equal(durable.rows[0]?.open_positions, 1);
      } else {
        assert.equal(durable.rows[0]?.unknown_block, true);
      }
      if (outcome === 'UNKNOWN') {
        const conflicting = reconciliationEvidence(
          fixture.intentId,
          'MISMATCH',
          fixture.snapshotFingerprint,
        );
        await assert.rejects(
          fixture.repository.reconcile({ payloadVersion: 1, evidence: conflicting }),
          isRepositoryError('CONFLICT'),
        );
      }
    });
  }
});

async function reconciliationFixture(
  pool: InstanceType<typeof pg.Pool>,
  seed: string,
  initialStatus: 'SUBMITTED' | 'UNKNOWN_REQUIRES_RECONCILIATION',
) {
  const nowMs = Date.now();
  await migrateDatabase({ pool });
  const repository = new PostgresExecutionRiskRepository(pool);
  const intentRepository = new PostgresExecutionIntentRepository(pool);
  const generation = await repository.registerWalletGeneration(generationDraft('a', 1));
  const snapshot = await repository.appendWalletSnapshot(Object.freeze({
    ...walletSnapshotDraft(generation.generationId, 'b', 0n),
    blockTimeMs: nowMs - 100,
    observedAtMs: nowMs - 50,
  }));
  const provider = createProviderUsageSnapshot({
    providerId: 'rpc-primary', planId: 'public-v1', billingPeriodId: 'current',
    billingPeriodStartedAtMs: nowMs - 1_000,
    billingPeriodEndsAtMs: nowMs + 300_000,
    limitUnits: 10_000n, usedUnits: 10n, measuredAtMs: nowMs - 100,
    expiresAtMs: nowMs + 60_000, provenance: 'AUTHORITATIVE_PROBE',
  });
  await repository.appendProviderUsage(provider);
  const draft = createExecutionIntentDraft({
    strategyId: 'risk-reconciliation-test', strategyVersion: 1,
    positionId: `position:${seed}`, logicalCommandId: `command:${seed}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 90_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `decision:${seed}`, decisionFingerprint: 'c'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const created = await intentRepository.create(draft);
  const policy = createExecutionRiskPolicy({
    quoteMintAllowlist: ['So11111111111111111111111111111111111111112'],
    initialCapitalLamports: 1_000_000n, maximumCapitalLamports: 1_000_000n,
    positionSizeBps: 1_000n, maximumOpenPositions: 2,
    maximumTotalExposureBps: 2_000n, drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n, walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n, maximumConsecutiveTechnicalFailures: 2,
  });
  const admitted = await new ExecutionAdmissionService(repository).admit({
    payloadVersion: 1, intent: created.intent, policy,
    generationId: generation.generationId, walletSnapshot: snapshot,
    providerSnapshot: provider, allEndpointsUnavailable: false, nowMs,
  });
  assert.equal(admitted.decision, 'ADMITTED');
  const reason = initialStatus === 'SUBMITTED'
    ? 'SUBMISSION_ACCEPTED' : 'RECONCILIATION_REQUIRED';
  await pool.query(`UPDATE execution_intents SET status=$2,attempt_count=1,state_revision=1,
    last_reason_code=$3,updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`,
  [created.intent.id, initialStatus, reason]);
  await pool.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,effective_venue,provider_id
  ) VALUES ($1,1,'STARTED','PUMP_FUN','rpc-primary')`, [created.intent.id]);
  return Object.freeze({
    repository,
    intentId: created.intent.id,
    snapshotFingerprint: snapshot.snapshotFingerprint,
  });
}

function reconciliationEvidence(
  intentId: string,
  outcome: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN',
  snapshotFingerprint: string,
) {
  const nowMs = Date.now() + 1_000;
  const signature = '3'.repeat(88);
  const transaction = Object.freeze({
    signature,
    blockhash: publicKey,
    messageHash: 'd'.repeat(64),
    buildFingerprint: 'e'.repeat(64),
    snapshotFingerprint,
  });
  const observed = outcome === 'MATCHED' ? {
    signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED', finalizedBlockHeight: 999n,
    observedSlot: 500n, transaction, feeLamports: 5n, walletLamportDelta: -105n,
    baseDeltaRaw: 500n, quoteDeltaRaw: -100n, unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: nowMs, finalizedAtMs: nowMs + 1,
  } : outcome === 'NO_EFFECT' ? {
    signatureHistory: 'ABSENT', confirmationStatus: 'NOT_FOUND', finalizedBlockHeight: 1_001n,
    observedSlot: null, transaction: null, feeLamports: 0n, walletLamportDelta: 0n,
    baseDeltaRaw: 0n, quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: nowMs, finalizedAtMs: nowMs + 1,
  } : outcome === 'MISMATCH' ? {
    signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED', finalizedBlockHeight: 999n,
    observedSlot: 500n, transaction: Object.freeze({
      ...transaction, messageHash: 'f'.repeat(64),
    }), feeLamports: 5n, walletLamportDelta: -105n,
    baseDeltaRaw: 500n, quoteDeltaRaw: -100n, unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: nowMs, finalizedAtMs: nowMs + 1,
  } : {
    signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND', finalizedBlockHeight: 999n,
    observedSlot: null, transaction: null, feeLamports: 0n, walletLamportDelta: 0n,
    baseDeltaRaw: 0n, quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: nowMs, finalizedAtMs: null,
  };
  return evaluateExecutionReconciliation({
    expected: Object.freeze({
      intentId, attemptNumber: 1, walletGeneration: 1, providerId: 'rpc-primary',
      side: 'BUY', signature, blockhash: publicKey, lastValidBlockHeight: 1_000n,
      messageHash: 'd'.repeat(64), buildFingerprint: 'e'.repeat(64), snapshotFingerprint,
      maximumFeeLamports: 10n, maximumFeePayerLamportDebit: 1_000n,
    }),
    observed: Object.freeze(observed),
  });
}

function generationDraft(seed: string, generation: number) {
  return Object.freeze({
    generationId: id('wallet_generation', seed),
    payloadVersion: 1 as const,
    walletPublicKey: publicKey,
    cluster: 'mainnet-beta' as const,
    genesisHash,
    generation,
  });
}

function generationRow(seed: string) {
  return {
    generation_id: id('wallet_generation', seed),
    payload_version: 1,
    wallet_public_key: publicKey,
    cluster: 'mainnet-beta',
    genesis_hash: genesisHash,
    generation: 1,
    created_at_ms: '1000',
    retired_at_ms: null,
  };
}

function walletSnapshotDraft(
  generationId: string,
  seed: string,
  stateRevision: bigint,
  openPositions: readonly Readonly<{
    positionId: string;
    costBasisLamports: bigint;
    conservativeLiquidationLamports: bigint | null;
    reconciliationStatus: 'RECONCILED' | 'UNKNOWN';
  }>[] = [],
) {
  return Object.freeze({
    snapshotId: id('wallet_snapshot', seed),
    payloadVersion: 1 as const,
    snapshotFingerprint: seed.repeat(64),
    generationId,
    providerId: 'rpc-primary',
    stateRevision,
    slot: 123n,
    blockTimeMs: 1_000 as number | null,
    observedAtMs: 1_001,
    commitment: 'finalized' as const,
    walletLamports: 1_000_000n,
    tokenBalanceCount: 0,
    openPositions: Object.freeze(openPositions),
    realizedNetPnlRaw: 0n,
  });
}

function providerSnapshot(startedAtMs: number, measuredAtMs: number, usedUnits: number) {
  return createProviderUsageSnapshot({
    providerId: 'rpc-primary',
    planId: 'public-v1',
    billingPeriodId: `period-${startedAtMs}`,
    billingPeriodStartedAtMs: startedAtMs,
    billingPeriodEndsAtMs: 100_000,
    limitUnits: 10_000n,
    usedUnits: BigInt(usedUnits),
    measuredAtMs,
    expiresAtMs: measuredAtMs + 30_000,
    provenance: 'AUTHORITATIVE_PROBE',
  });
}

function id(kind: 'wallet_generation' | 'wallet_snapshot', seed: string): string {
  return `execution_${kind}_${seed.repeat(64)}`;
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionRiskRepositoryError && error.code === code;
}

function testDatabaseUrl(
  context: Readonly<{ skip(message?: string): void }>,
  label: string,
): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionArmament,
  createOperatorAuthorization,
} from '../src/domain/execution-operations.js';
import {
  createSafetyQualification,
  createMainnetSimulationEvidenceFingerprint,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const publicKey = '11111111111111111111111111111111';
const hash = '1'.repeat(64);

void test('qualification, resume and inert armament replay durably without live capability', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId,
      payloadVersion: 1,
      walletPublicKey: publicKey,
      cluster: 'mainnet-beta',
      genesisHash: publicKey,
      generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);

    const stopped = await repository.setStop({
      payloadVersion: 1,
      commandId: 'command:initial-entry-stop',
      generationId,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 1,
    }, 'ENTRY_STOP');
    assert.equal(stopped.controlState, 'ENTRY_STOP');
    assert.equal(stopped.controlRevision, 1n);

    const futureAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '9'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs + 30_000, expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(futureAuthorization),
      isRepositoryError('CONFLICT'));

    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'RESUME',
      phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'b'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'RECORDED');
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'REPLAYED');
    const running = await repository.resume({
      payloadVersion: 1,
      commandId: 'command:resume',
      generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 2,
    });
    assert.equal(running.controlState, 'RUNNING');

    const armAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'ARM',
      phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'c'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(armAuthorization);
    const armament = createExecutionArmament({
      payloadVersion: 1,
      qualification,
      maximumBuys: 1,
      maximumCapitalLamports: 500_000n,
      maximumExposureBps: 500n,
      maximumOpenPositions: 1,
      maximumHoldingMs: 300_000,
      armedAtMs: nowMs + 3,
      expiresAtMs: nowMs + 299_999,
      operatorId: 'operator-primary',
      operatorReason: 'Mainnet canary manually approved.',
      authorizationId: armAuthorization.authorizationId,
      authorizationFingerprint: armAuthorization.authorizationFingerprint,
    });
    assert.deepEqual(await repository.arm(armament), armament);
    assert.deepEqual(await repository.arm(armament), armament);
    const status = await repository.readStatus(generationId);
    assert.equal(status.controlState, 'RUNNING');
    assert.equal(status.activeArmamentId, armament.armamentId);
    assert.equal(status.activeArmamentPhase, 'CANARY');
    assert.equal(status.latestQualificationId, qualification.qualificationId);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_activation_events`)).rows[0]?.count, 1);
    for (const query of [
      `UPDATE execution_safety_qualifications SET build_hash='${'f'.repeat(64)}'`,
      `UPDATE execution_safety_gate_evidence SET evidence_id='rewritten'`,
      `UPDATE execution_operator_authorizations SET operator_id='rewritten'`,
      `UPDATE execution_activation_armaments SET maximum_capital_lamports=1`,
      `UPDATE execution_control_events SET operator_id='rewritten'`,
      `UPDATE execution_activation_events SET occurred_at=occurred_at+INTERVAL '1 millisecond'`,
    ]) await assert.rejects(pool.query(query), /immutable/u);
  });
});

void test('armament fails closed while stopped and a hard stop cannot be downgraded', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    await repository.persistQualification(qualification);
    const authorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'd'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(authorization);
    const armament = createExecutionArmament({
      payloadVersion: 1, qualification, maximumBuys: 1,
      maximumCapitalLamports: 1n, maximumExposureBps: 500n,
      maximumOpenPositions: 1, maximumHoldingMs: 30_000,
      armedAtMs: nowMs + 1, expiresAtMs: nowMs + 60_000,
      operatorId: 'operator-primary', operatorReason: 'Canary.',
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: authorization.authorizationFingerprint,
    });
    await assert.rejects(repository.arm(armament), isRepositoryError('CONTROL_STOPPED'));
    await repository.setStop({
      payloadVersion: 1, commandId: 'command:hard-stop', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 2,
    }, 'HARD_STOP');
    await assert.rejects(repository.setStop({
      payloadVersion: 1, commandId: 'command:downgrade', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 3,
    }, 'ENTRY_STOP'), isRepositoryError('CONFLICT'));
  });
});

void test('preflight rejects absent or mismatched #51-D Mainnet simulation evidence', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const valid = safetyQualification(nowMs, simulation);
    const gates = valid.gates.map((gate) => gate.gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? { ...gate, evidenceFingerprint: 'f'.repeat(64) }
      : gate);
    const mismatched = createSafetyQualification({
      payloadVersion: 1, evaluatorVersion: 1, phase: valid.phase,
      buildHash: valid.buildHash,
      configurationFingerprint: valid.configurationFingerprint,
      strategyFingerprint: valid.strategyFingerprint, generationId: valid.generationId,
      walletPublicKey: valid.walletPublicKey, cluster: valid.cluster,
      genesisHash: valid.genesisHash, providerId: valid.providerId,
      qualifiedAtMs: valid.qualifiedAtMs, expiresAtMs: valid.expiresAtMs, gates,
    });
    await assert.rejects(repository.persistQualification(mismatched),
      isRepositoryError('CONFLICT'));
    await assert.rejects(
      repository.persistQualification(safetyQualification(nowMs, simulation, '2'.repeat(64))),
      isRepositoryError('CONFLICT'),
    );
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_safety_qualifications`)).rows[0]?.count, 0);
  });
});

void test('identical concurrent preflights replay after the generation lock', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const qualification = safetyQualification(Date.now(), simulation);
    const results = await Promise.all([
      repository.persistQualification(qualification),
      repository.persistQualification(qualification),
    ]);
    assert.deepEqual(results, [qualification, qualification]);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_safety_qualifications`)).rows[0]?.count, 1);
  });
});

void test('identical concurrent operator authorizations replay exactly once', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const authorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: hash, nonceHash: 'e'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    assert.deepEqual((await Promise.all([
      repository.recordAuthorization(authorization),
      repository.recordAuthorization(authorization),
    ])).sort(), ['RECORDED', 'REPLAYED']);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_operator_authorizations`)).rows[0]?.count, 1);
  });
});

void test('database rejects a direct transition to RUNNING without guarded evidence', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    await pool.query(`INSERT INTO execution_control_state (generation_id)
      VALUES ($1)`, [generationId]);
    await assert.rejects(pool.query(`UPDATE execution_control_state SET
      state='RUNNING',state_revision=1,updated_at=date_trunc('milliseconds',statement_timestamp())
      WHERE generation_id=$1`, [generationId]), /guarded control transition/u);
  });
});

void test('armament rechecks unknown risk atomically before consuming authorization', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const qualification = safetyQualification(Date.now(), simulation);
    await repository.persistQualification(qualification);
    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '4'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: qualification.qualifiedAtMs,
      expiresAtMs: qualification.qualifiedAtMs + 60_000,
    });
    await repository.recordAuthorization(resumeAuthorization);
    await repository.resume({
      payloadVersion: 1, commandId: 'command:risk-resume', generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization, operatorId: 'operator-primary',
      occurredAtMs: qualification.qualifiedAtMs + 1,
    });
    await pool.query(`UPDATE execution_wallet_risk_state
      SET unknown_block=TRUE WHERE generation_id=$1`, [generationId]);
    await assert.rejects(
      armCanary(repository, qualification, Date.now(), '8'),
      isRepositoryError('CONFLICT'),
    );
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_operator_authorizations
      WHERE action='ARM' AND consumed_at IS NULL`)).rows[0]?.count, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_activation_armaments`)).rows[0]?.count, 0);
  });
});

void test('status hides stale armaments, replacement expires them and stop revokes atomically', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    await repository.persistQualification(qualification);
    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '7'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(resumeAuthorization);
    await repository.resume({
      payloadVersion: 1, commandId: 'command:expiry-resume', generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization, operatorId: 'operator-primary',
      occurredAtMs: nowMs + 1,
    });
    const first = await armCanary(repository, qualification, Date.now(), '6', 200);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const expiredStatus = await repository.readStatus(generationId);
    assert.equal(expiredStatus.activeArmamentId, null);
    assert.equal((await pool.query(`SELECT state FROM execution_activation_armaments
      WHERE armament_id=$1`, [first.armamentId])).rows[0]?.state, 'ARMED');

    const replacement = await armCanary(repository, qualification, Date.now(), '5');
    assert.deepEqual((await pool.query(`SELECT state,terminal_at IS NOT NULL AS terminal,
      purge_after=terminal_at+INTERVAL '4 hours' AS purge_exact
      FROM execution_activation_armaments WHERE armament_id=$1`, [first.armamentId])).rows[0], {
      state: 'EXPIRED', terminal: true, purge_exact: true,
    });
    assert.equal((await repository.readStatus(generationId)).activeArmamentId,
      replacement.armamentId);
    const stopped = await repository.setStop({
      payloadVersion: 1, commandId: 'command:revoke-active', generationId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    }, 'ENTRY_STOP');
    assert.equal(stopped.activeArmamentId, null);
    assert.equal((await pool.query(`SELECT state FROM execution_activation_armaments
      WHERE armament_id=$1`, [replacement.armamentId])).rows[0]?.state, 'REVOKED');
    await assert.rejects(repository.arm(replacement), isRepositoryError('CONFLICT'));
    const reasons = (await pool.query<{ readonly reason_code: string }>(
      `SELECT reason_code FROM execution_activation_events
      WHERE armament_id IN ($1,$2) ORDER BY occurred_at,event_id`,
    [first.armamentId, replacement.armamentId])).rows.map((row) => row.reason_code);
    assert.ok(reasons.includes('ARMAMENT_EXPIRED'));
    assert.ok(reasons.includes('ARMAMENT_REVOKED'));
  });
});

function safetyQualification(
  nowMs: number,
  simulation: Awaited<ReturnType<typeof seedSuccessfulSimulation>>,
  buildHash = hash,
) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.artifactId : `evidence:${index}`,
      evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? createMainnetSimulationEvidenceFingerprint({
          artifactId: simulation.artifactId,
          resultFingerprint: simulation.resultFingerprint,
          buildHash,
          configurationFingerprint: simulation.configurationFingerprint,
          strategyFingerprint: '3'.repeat(64),
          walletPublicKey: publicKey,
          genesisHash: publicKey,
          providerId: 'primary',
        })
        : index.toString(16).repeat(64),
      observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.recordedAtMs : nowMs - 1_000 + index,
      expiresAtMs: nowMs + 300_000,
    })),
  });
}

async function seedSuccessfulSimulation(pool: InstanceType<typeof pg.Pool>) {
  const nowMs = Date.now();
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId: `event-${randomUUID()}`, decisionFingerprint: hash,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const claimed = await intents.claim({
    ownerId: 'preflight-test-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  });
  if (claimed === null) assert.fail('Expected one claimed simulation intent.');
  const processingIntent = await intents.transition(claimed, {
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const processing = Object.freeze({ ...claimed, intent: processingIntent });
  const begun = await intents.beginAttempt(processing);
  const artifact = createExecutionSimulationArtifactDraft({
    intentId: begun.claim.intent.id, attemptNumber: begun.attempt.attemptNumber,
    intentStateRevision: begun.claim.intent.stateRevision,
    strategyId: begun.claim.intent.strategyId,
    strategyVersion: begun.claim.intent.strategyVersion,
    decisionFingerprint: begun.claim.intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: publicKey, expectedGenesisHash: publicKey,
    observedGenesisHash: publicKey, configurationFingerprint: hash,
    quoteFingerprint: hash, snapshotFingerprint: hash, buildFingerprint: hash,
    messageHash: hash, blockhash: publicKey, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 900n, snapshotSlot: 899n, feeContextSlot: 900n,
    simulationSlot: 901n, amountInRaw: 1_000n, expectedAmountOutRaw: 900n,
    protectedAmountOutRaw: 850n, feesRaw: 10n, estimatedFeeLamports: 5_000n,
    simulatedFeePayerLamportDebit: 6_000n, unitsConsumed: 200_000n,
    simulatedBaseDeltaRaw: 900n, simulatedQuoteDeltaRaw: -1_000n,
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: hash, logsLineCount: 1,
  });
  return new PostgresExecutionSimulationRepository(pool)
    .complete(begun.claim, artifact, new AbortController().signal);
}

async function armCanary(
  repository: PostgresExecutionOperationsRepository,
  qualification: ReturnType<typeof safetyQualification>,
  armedAtMs: number,
  nonceSeed: string,
  ttlMs = 60_000,
) {
  const authorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: qualification.qualificationFingerprint,
    nonceHash: nonceSeed.repeat(64), operatorId: 'operator-primary',
    issuedAtMs: armedAtMs, expiresAtMs: armedAtMs + 60_000,
  });
  await repository.recordAuthorization(authorization);
  return repository.arm(createExecutionArmament({
    payloadVersion: 1, qualification, maximumBuys: 1,
    maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 300_000,
    armedAtMs, expiresAtMs: Math.min(armedAtMs + ttlMs, qualification.expiresAtMs),
    operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
    authorizationId: authorization.authorizationId,
    authorizationFingerprint: authorization.authorizationFingerprint,
  }));
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations repository test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_operations_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

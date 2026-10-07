import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { Keypair } from '@solana/web3.js';
import pg from 'pg';
import {
  createExecutionArmamentRequestV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  type ExecutionActivationArmamentV2,
  type ExecutionArmamentRequestV2,
  type ExecutionOperatorAuthorizationV1,
  type ExecutionOperatorAuthorizationV2,
} from '../../src/domain/execution-operations.js';
import {
  createEntryEnvelope,
  createEnvelopeArmAuthorization,
  createEnvelopeProviderSnapshot,
  ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS,
  type EntryEnvelopeV2,
} from '../../src/domain/execution-entry-envelope.js';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from '../../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../../src/domain/execution-risk-policy.js';
import {
  createEnvelopeBindingGates,
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
  type ExecutionSafetyQualificationV1,
  type ExecutionSafetyQualificationV2,
} from '../../src/domain/execution-safety-qualification.js';
import { createExecutionWalletSnapshot } from '../../src/domain/execution-wallet-snapshot.js';
import { createExecutionIntentDraft } from '../../src/domain/execution-intent.js';
import { createExecutionSimulationArtifactDraft } from '../../src/domain/execution-simulation.js';
import { migrateDatabase } from '../../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../../src/storage/execution-intent.repository.js';
import type { PostgresExecutionOperationsRepository } from '../../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../../src/storage/execution-simulation.repository.js';
import { PostgresFastEntryRepository } from '../../src/storage/fast-entry.repository.js';
import { insertExecutionDecisionEvent } from './execution-decision-event.js';
import { acquireExecutorRoleTestLock } from '../postgres-role-test-lock.js';
import { waitForBackendDrain } from './postgres-backend-drain.js';

/** Shared PostgreSQL fixtures for ENVELOPE-scoped (lot 4a) tests. */
export type Pool = InstanceType<typeof pg.Pool>;

export const publicKey = '11111111111111111111111111111111';
export const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
export const hash = '1'.repeat(64);
export const WSOL = 'So11111111111111111111111111111111111111112';
export const HOUR = 3_600_000;
export const PER_BUY = 10_000_000n;
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const scriptUrl = new URL('../../scripts/provision-executor-roles.sql', import.meta.url);

export interface PreparedEnvelope {
  readonly envelope: EntryEnvelopeV2;
  readonly qualification: ExecutionSafetyQualificationV2;
  readonly authorization: ExecutionOperatorAuthorizationV1;
}

export async function prepareEnvelope(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
  options: Readonly<{
    nonce?: string; expiresInMs?: number; maxBuys?: number;
    maxTotalExposureRaw?: bigint; maxRealizedLossRaw?: bigint;
  }> = {},
): Promise<PreparedEnvelope> {
  const nowMs = await currentDatabaseTimeMs(pool);
  const qualification = envelopeQualification(nowMs, simulation, options.expiresInMs);
  const envelope = createEntryEnvelope(Object.freeze({
    payloadVersion: 2, qualification, operatorId: 'operator-primary',
    perBuyQuoteAmountRaw: PER_BUY, maxBuys: options.maxBuys ?? 3,
    maxTotalExposureRaw: options.maxTotalExposureRaw ?? 30_000_000n,
    maxRealizedLossRaw: options.maxRealizedLossRaw ?? 30_000_000n, maximumHoldingMs: 60_000,
    validFromMs: nowMs, validUntilMs: qualification.expiresAtMs, policy: envelopePolicy(),
  }));
  const authorization = envelopeAuthorization(envelope, nowMs,
    (options.nonce ?? '7').repeat(64));
  await repository.recordAuthorization(authorization);
  return Object.freeze({ envelope, qualification, authorization });
}

export function envelopeAuthorization(
  envelope: EntryEnvelopeV2,
  nowMs: number,
  nonceHash: string,
): ExecutionOperatorAuthorizationV1 {
  return createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'ENVELOPE', phase: null,
    contextFingerprint: envelope.fingerprint, nonceHash, operatorId: envelope.operatorId,
    issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
}

export function staticGates(nowMs: number, expiresAtMs: number, simulation: SeededSimulation) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
    payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
    evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED' ? simulation.artifactId : `evidence:${index}`,
    evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? createMainnetSimulationEvidenceFingerprint({
        artifactId: simulation.artifactId, resultFingerprint: simulation.resultFingerprint,
        buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
        strategyFingerprint: '3'.repeat(64), walletPublicKey: publicKey,
        genesisHash: publicKey, providerId: 'primary',
      })
      : index.toString(16).repeat(64),
    observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? simulation.recordedAtMs : nowMs - 1_000 + index,
    expiresAtMs,
  }));
}

export function envelopeQualification(
  nowMs: number,
  simulation: SeededSimulation,
  expiresInMs = 2 * HOUR,
): ExecutionSafetyQualificationV2 {
  const expiresAtMs = nowMs + expiresInMs;
  const binding = createEnvelopeBindingGates({
    generationId, walletPublicKey: publicKey, providerId: 'primary',
    observedAtMs: nowMs, expiresAtMs,
  });
  const gates = staticGates(nowMs, expiresAtMs, simulation).map((gate, index) => (
    index === 7 ? binding.provider : index === 9 ? binding.wallet : gate));
  const qualification = createSafetyQualification({
    payloadVersion: 2, scope: 'ENVELOPE', evaluatorVersion: 1, phase: 'CANARY',
    buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs, gates,
  });
  assert.equal(qualification.payloadVersion, 2);
  return qualification;
}

export function envelopePolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL],
    initialCapitalLamports: 230_000_000n,
    maximumCapitalLamports: 230_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 20_000_000n,
    walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
}

/** Creates the envelope and resumes control with its ENVELOPE qualification. */
export async function openEnvelope(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
  options: Parameters<typeof prepareEnvelope>[3] = {},
): Promise<PreparedEnvelope> {
  const prepared = await prepareEnvelope(pool, repository, simulation, options);
  await repository.createEnvelope(prepared);
  await resumeWith(repository, prepared.qualification, 'open');
  return prepared;
}

export async function resumeWith(
  repository: PostgresExecutionOperationsRepository,
  qualification: ExecutionSafetyQualificationV2,
  tag: string,
): Promise<void> {
  const nowMs = Date.now();
  const authorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint,
    nonceHash: createHash('sha256').update(`resume:${tag}`).digest('hex'),
    operatorId: 'operator-primary', issuedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  await repository.recordAuthorization(authorization);
  await repository.resume({
    payloadVersion: 1, commandId: `command:resume:${tag}`, generationId,
    qualificationId: qualification.qualificationId, authorization,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
}

export async function seedProviderSnapshot(pool: Pool): Promise<ProviderUsageSnapshotV1> {
  const nowMs = await currentDatabaseTimeMs(pool);
  const snapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'plan-1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: nowMs - 60_000, billingPeriodEndsAtMs: nowMs + 3 * HOUR,
    limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 300_000, provenance: 'OPERATOR_REPORT',
  });
  return new PostgresExecutionRiskRepository(pool).appendProviderUsage(snapshot);
}

/** A BUY intent produced by the real lot-3 fast-entry path (safety point 6). */
export async function fastEntryIntent(
  pool: Pool,
  envelope: EntryEnvelopeV2,
  decidedAtMs: number,
  amountInRaw: bigint = envelope.perBuyQuoteAmountRaw,
): Promise<string> {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const signature = `create-${mint}`;
  const at = new Date(decidedAtMs - 500);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun',$2,$3,'SPL_TOKEN',$4,'DETECTED',$5,100,2,3,NULL,$6,$6)`, [
    mint, PUMP_PROGRAM, creator,
    JSON.stringify([{ mint: WSOL, decimals: 9, tokenProgram: 'SPL_TOKEN' }]), signature, at,
  ]);
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,'TokenLaunchDetected',$2,'pumpfun',$3,$4,100,2,3,NULL,'confirmed',$5,$5,1,$6)`, [
    `launch-${mint}`, mint, PUMP_PROGRAM, signature, at, JSON.stringify({ launch: { mint, creator } }),
  ]);
  const fastEntry = new PostgresFastEntryRepository(pool);
  const launch = await fastEntry.readLaunchForSignature(mint, signature);
  assert.ok(launch !== null);
  const quote = (inputMint: string, outputMint: string, amountIn: bigint, minimumOut: bigint) => (
    Object.freeze({
      id: `quote-${randomUUID()}`, inputMint, outputMint, amountInRaw: amountIn,
      amountOutRaw: minimumOut + 1n, minimumAmountOutRaw: minimumOut, feesRaw: 10n,
      slippageBps: 1_000n, priceImpactBps: 5n, observedAtMs: decidedAtMs, observedSlot: 100n,
    }));
  const result = await fastEntry.recordBuy({
    launch, decidedAtMs,
    envelope: { envelopeId: envelope.envelopeId, perBuyQuoteAmountRaw: envelope.perBuyQuoteAmountRaw },
    buyQuote: quote(WSOL, mint, amountInRaw, 1_000_000n),
    reverseQuote: quote(mint, WSOL, 1_000_000n, (amountInRaw * 9n) / 10n),
    roundTripLossBps: 500n,
  });
  assert.equal(result.kind, 'RECORDED');
  if (result.kind !== 'RECORDED') throw new Error('unreachable');
  return result.intentId;
}

export function contextQuery(overrides: Partial<{
  minimumRemainingMs: number; excludedIntentIds: readonly string[];
}> = {}) {
  return Object.freeze({
    generationId, minimumRemainingMs: 60_000, excludedIntentIds: [], ...overrides,
  });
}

/** What the auto-arm daemon builds from one context: snapshots, request and authorization. */
export async function envelopeArmRequest(
  repository: PostgresExecutionOperationsRepository,
  prepared: PreparedEnvelope,
  intentId: string,
  options: Readonly<{
    extraUnits?: bigint;
    provenance?: 'OPERATOR_REPORT';
    operatorId?: string;
    provider?: Readonly<{ snapshot: ProviderUsageSnapshotV1; localUsedUnits: bigint }>;
    /** A shorter carried-forward snapshot, so its refresh is due right after the arm. */
    providerMaxAgeMs?: number;
  }> = {},
) {
  const view = await repository.readAutoArmContext(contextQuery({ minimumRemainingMs: 0 }));
  const provider = options.provider ?? view.provider;
  assert.ok(provider !== null);
  const nowMs = view.databaseNowMs;
  const policy = prepared.envelope.policy;
  const carried = createEnvelopeProviderSnapshot({
    latest: provider.snapshot,
    localUsedUnits: provider.localUsedUnits + (options.extraUnits ?? 0n),
    measuredAtMs: nowMs, maximumAgeMs: options.providerMaxAgeMs ?? policy.providerUsageMaxAgeMs,
  });
  const { snapshotId: _id, payloadVersion: _version, snapshotFingerprint: _fingerprint,
    ...carriedFields } = carried;
  const providerSnapshot = options.provenance === undefined ? carried
    : createProviderUsageSnapshot({ ...carriedFields, provenance: options.provenance });
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId, providerId: 'primary', stateRevision: view.riskStateRevision, slot: 10n,
    blockTimeMs: nowMs - 100, observedAtMs: nowMs - 50, commitment: 'finalized',
    walletLamports: 230_000_000n, tokenBalanceCount: 0, openPositions: [], realizedNetPnlRaw: 0n,
  });
  const target = await repository.readTargetIntent(intentId);
  const expiresAtMs = Math.min(target.expiresAtMs, providerSnapshot.expiresAtMs,
    nowMs + ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS);
  const request = createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification: prepared.qualification, targetIntentId: intentId, policy,
    walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
    capturedAtMs: nowMs, expiresAtMs,
    target: {
      intentId, stateRevision: target.stateRevision, strategyId: target.strategyId,
      strategyVersion: target.strategyVersion, decisionFingerprint: target.decisionFingerprint,
      mint: target.mint, quoteMint: target.quoteMint, quoteAmountRaw: target.quoteAmountRaw,
    },
    maximumBuys: 1, maximumCapitalLamports: prepared.envelope.perBuyQuoteAmountRaw,
    maximumExposureBps: 500n, maximumOpenPositions: 1,
    maximumHoldingMs: prepared.envelope.maximumHoldingMs, runtimeQuoteMaxAgeMs: 60_000,
    runtimeSlippageBps: 1_000n, runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
    runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 3_000, armedAtMs: nowMs, armamentExpiresAtMs: expiresAtMs,
    operatorId: options.operatorId ?? prepared.envelope.operatorId,
    operatorReason: 'Entry envelope auto-arm.',
  });
  const authorization = createEnvelopeArmAuthorization({
    generationId, operatorId: options.operatorId ?? prepared.envelope.operatorId,
    envelopeId: prepared.envelope.envelopeId, intentId,
    contextFingerprint: request.armamentRequestFingerprint, nowMs,
  });
  return Object.freeze({ request, authorization, envelopeId: prepared.envelope.envelopeId });
}

export async function armEnvelope(
  repository: PostgresExecutionOperationsRepository,
  prepared: PreparedEnvelope,
  intentId: string,
  options: Parameters<typeof envelopeArmRequest>[3] = {},
): Promise<ExecutionActivationArmamentV2> {
  return repository.armEnvelope(await envelopeArmRequest(repository, prepared, intentId, options));
}

export type SeededSimulation = Awaited<ReturnType<typeof seedSuccessfulSimulation>>;

export async function seedEnvelopeBase(pool: Pool): Promise<SeededSimulation> {
  await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
  });
  return seedSuccessfulSimulation(pool);
}

export async function seedSuccessfulSimulation(pool: Pool) {
  const nowMs = await currentDatabaseTimeMs(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  const decisionEventId = `event-${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, publicKey);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId, decisionFingerprint: hash,
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

export async function currentDatabaseTimeMs(pool: Pool): Promise<number> {
  const result = await pool.query<{ readonly now_ms: string }>(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms`);
  const nowMs = Number(result.rows[0]?.now_ms);
  assert.equal(Number.isSafeInteger(nowMs), true);
  return nowMs;
}

/** Runs every repository transaction on its own connection under `SET ROLE role`. */
export function roleSource(pool: Pool, role: string) {
  return Object.freeze({
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SET ROLE ${role}`);
      return Object.freeze({
        query: async (text: string, values?: readonly unknown[]) => {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: result.rows as readonly Readonly<Record<string, unknown>>[], rowCount: result.rowCount };
        },
        // The role is session state: the connection is discarded instead of being reset.
        release: () => { client.release(true); },
      });
    },
  });
}

export async function withSchema(context: TestContext, callback: (pool: Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: entry envelope repository test skipped');
    return;
  }
  const schema = `entry_envelope_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await migrateDatabase({ pool });
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

export async function withProvisionedDatabase(
  context: TestContext,
  callback: (pool: Pool) => Promise<void>,
): Promise<void> {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: configuredUrl });
  const capability = (await maintenance.query<{
    readonly rolsuper: boolean; readonly rolcreatedb: boolean; readonly version: number;
  }>(`SELECT rolsuper,rolcreatedb,current_setting('server_version_num')::INTEGER AS version
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!capability?.rolsuper || !capability.rolcreatedb || capability.version < 160_000) {
    await maintenance.end();
    context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
    return;
  }
  const release = await acquireExecutorRoleTestLock(maintenance);
  const databaseName = `entry_envelope_roles_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: Pool | undefined;
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href, max: 4 });
    await migrateDatabase({ pool: isolated });
    const provisioningSql = await readFile(scriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await isolated.query(provisioningSql);
    await callback(isolated);
  } finally {
    try {
      await isolated?.end();
      await waitForBackendDrain(maintenance, databaseName);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      try { await release(); } finally { await maintenance.end(); }
    }
  }
}

export function canaryQualification(
  nowMs: number,
  simulation: SeededSimulation,
  snapshots?: Readonly<{
    wallet: ReturnType<typeof createExecutionWalletSnapshot>;
    provider: ReturnType<typeof createProviderUsageSnapshot>;
  }>,
): ExecutionSafetyQualificationV1 {
  const gates = staticGates(nowMs, nowMs + 300_000, simulation).map((gate) => (
    snapshots !== undefined && gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED'
      ? { ...gate, evidenceId: snapshots.wallet.snapshotId,
        evidenceFingerprint: snapshots.wallet.snapshotFingerprint }
      : snapshots !== undefined && gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED'
        ? { ...gate, evidenceId: snapshots.provider.snapshotId,
          evidenceFingerprint: snapshots.provider.snapshotFingerprint }
        : gate));
  const qualification = createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000, gates,
  });
  assert.equal(qualification.payloadVersion, 1);
  return qualification;
}


export function canaryPolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL],
    initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n,
    walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
}

/** The CANARY v2 path of tests/execution-operations.repository.test.ts, through `repository`. */
export async function armCanary(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
): Promise<ExecutionActivationArmamentV2>;
export async function armCanary(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
  options: Readonly<{ returnRequest: true }>,
): Promise<Readonly<{
  armament: ExecutionActivationArmamentV2;
  request: ExecutionArmamentRequestV2;
  authorization: ExecutionOperatorAuthorizationV2;
}>>;
export async function armCanary(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
  options: Readonly<{ returnRequest?: true }> = {},
) {
  const snapshotNowMs = await currentDatabaseTimeMs(pool);
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId, providerId: 'primary', stateRevision: 0n, slot: 10n,
    blockTimeMs: snapshotNowMs - 100, observedAtMs: snapshotNowMs - 50, commitment: 'finalized',
    walletLamports: 1_000_000n, tokenBalanceCount: 0, openPositions: [], realizedNetPnlRaw: 0n,
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: snapshotNowMs - 60_000, billingPeriodEndsAtMs: snapshotNowMs + 600_000,
    limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: snapshotNowMs - 50,
    expiresAtMs: snapshotNowMs + 300_000, provenance: 'OPERATOR_REPORT',
  });
  const nowMs = await currentDatabaseTimeMs(pool);
  const qualification = canaryQualification(nowMs, simulation,
    { wallet: walletSnapshot, provider: providerSnapshot });
  await repository.persistQualification(qualification);
  const resumeAuthorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint, nonceHash: '9'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await repository.recordAuthorization(resumeAuthorization);
  await repository.resume({
    payloadVersion: 1, commandId: 'command:envelope-canary-resume', generationId,
    qualificationId: qualification.qualificationId, authorization: resumeAuthorization,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
  await insertExecutionDecisionEvent(pool, 'decision:canary-target', publicKey);
  const target = await new PostgresExecutionIntentRepository(pool).create(createExecutionIntentDraft({
    strategyId: 'canary-target', strategyVersion: 1,
    positionId: 'position:canary-target', logicalCommandId: 'command:canary-target',
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 40_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'decision:canary-target', decisionFingerprint: 'd'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 120_000,
  }));
  const request = createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification, targetIntentId: target.intent.id, policy: canaryPolicy(),
    walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
    capturedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
    target: {
      intentId: target.intent.id, stateRevision: target.intent.stateRevision,
      strategyId: target.intent.strategyId, strategyVersion: target.intent.strategyVersion,
      decisionFingerprint: target.intent.decisionFingerprint, mint: target.intent.mint,
      quoteMint: target.intent.quoteMint, quoteAmountRaw: target.intent.quoteAmountRaw,
    },
    maximumBuys: 1, maximumCapitalLamports: 40_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 30_000, runtimeQuoteMaxAgeMs: 60_000,
    runtimeSlippageBps: 100n, runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
    runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 3_000, armedAtMs: nowMs, armamentExpiresAtMs: nowMs + 120_000,
    operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
  });
  const authorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  const armament = await repository.armCanary(Object.freeze({ request, authorization }));
  return options.returnRequest === true
    ? Object.freeze({ armament, request, authorization }) : armament;
}

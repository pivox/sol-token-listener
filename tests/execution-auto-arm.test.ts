import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntryEnvelope,
  ENVELOPE_EXIT_MARGIN_MS,
  type EntryEnvelopeV2,
} from '../src/domain/execution-entry-envelope.js';
import {
  createExecutionArmamentV2,
  type ExecutionActivationArmamentV2,
  type ExecutionArmamentRequestV2,
  type ExecutionOperatorAuthorizationV2,
} from '../src/domain/execution-operations.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import type { ExecutionSafetyQualificationV2 } from '../src/domain/execution-safety-qualification.js';
import type {
  ExecutionAutoArmContextQueryV1,
  ExecutionAutoArmContextV1,
  ExecutionCanaryTargetIntentV1,
  ExecutionEnvelopeProviderRefreshCommandV1,
} from '../src/ports/execution-operations-repository.js';
import {
  ExecutionOperationsRepositoryError,
  type ExecutionOperationsRepositoryErrorCode,
} from '../src/storage/execution-operations.repository.js';
import type { ReadinessWalletObservationV1 } from '../src/executor-readiness/rpc-gateway.js';
import {
  createAutoArmState,
  formatAutoArmTickLog,
  runAutoArmTick,
  type AutoArmConfig,
  type AutoArmRepository,
  type AutoArmState,
  type AutoArmTickResult,
} from '../src/executor-operations/auto-arm.js';
import { runAutoArmLoop } from '../src/executor-operations/auto-arm-main.js';
import {
  envelopeCanaryEvidenceInput,
  NOW_MS,
  WSOL_MINT,
} from './helpers/execution-canary-fixture.js';

const DB_NOW_MS = NOW_MS + 10_000;
const LEASE_MS = 40_000;
const PER_BUY = 10_000_000n;
const FEE_RESERVE = 20_000_000n;
const INTENT_ID = `execution_intent_${'1'.repeat(64)}`;
const OTHER_INTENT_ID = `execution_intent_${'2'.repeat(64)}`;
const ENVELOPE_OPERATOR = 'envelope-operator';

const qualification = envelopeCanaryEvidenceInput().qualification as ExecutionSafetyQualificationV2;
const policy = createExecutionRiskPolicy({
  quoteMintAllowlist: [WSOL_MINT], initialCapitalLamports: 230_000_000n,
  maximumCapitalLamports: 230_000_000n, positionSizeBps: 1_000n, maximumOpenPositions: 1,
  maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n, feeReserveLamports: FEE_RESERVE,
  walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
  providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
  providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
  maximumConsecutiveTechnicalFailures: 2,
});
const envelope: EntryEnvelopeV2 = createEntryEnvelope({
  payloadVersion: 2, qualification, operatorId: ENVELOPE_OPERATOR,
  perBuyQuoteAmountRaw: PER_BUY, maxBuys: 5, maxTotalExposureRaw: 50_000_000n,
  maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 120_000,
  validFromMs: NOW_MS, validUntilMs: qualification.expiresAtMs, policy,
});
const latestProvider = createProviderUsageSnapshot({
  providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
  billingPeriodStartedAtMs: NOW_MS - 60_000, billingPeriodEndsAtMs: NOW_MS + 3_600_000,
  limitUnits: 1_000n, usedUnits: 10n, measuredAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
  provenance: 'OPERATOR_REPORT',
});

const config: AutoArmConfig = Object.freeze({
  generationId: qualification.generationId,
  walletPublicKey: qualification.walletPublicKey,
  providerId: 'primary',
  minimumRemainingMs: 2 * LEASE_MS + 2 * 5_000 + 5_000,
  runtimeQuoteMaxAgeMs: 3_000,
  runtimeSlippageBps: 500n,
  runtimeSnapshotMaxSlotLag: 8,
  runtimeMaxComputeUnits: 300_000n,
  runtimeMaxFeeLamports: 100_000n,
  runtimeMaxFeePayerLamportDebit: 2_500_000n,
  runtimeMaxRpcCallsPerAttempt: 12,
  runtimeLeaseMs: LEASE_MS,
});

function intent(overrides: Partial<ExecutionCanaryTargetIntentV1> = {}): ExecutionCanaryTargetIntentV1 {
  return Object.freeze({
    intentId: INTENT_ID, side: 'BUY', status: 'PENDING', leaseOwner: null, leaseExpiresAtMs: null,
    stateRevision: 0n, strategyId: 'fast-entry-v1', strategyVersion: 1,
    decisionFingerprint: 'f'.repeat(64), mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    quoteMint: WSOL_MINT, quoteAmountRaw: PER_BUY, expiresAtMs: DB_NOW_MS + 110_000,
    ...overrides,
  });
}

function context(overrides: Partial<ExecutionAutoArmContextV1> = {}): ExecutionAutoArmContextV1 {
  return Object.freeze({
    payloadVersion: 1, databaseNowMs: DB_NOW_MS, envelope, qualification,
    buysArmed: 1, realizedLossRaw: 2_000_000n, controlState: 'RUNNING', riskStateRevision: 7n,
    openPositions: 0, unknownBlock: false, activeArmament: null,
    provider: Object.freeze({ snapshot: latestProvider, localUsedUnits: 3n }),
    candidateIntent: intent(), providerRefreshDue: false,
    ...overrides,
  });
}

interface FakeOptions {
  readonly context?: ExecutionAutoArmContextV1;
  readonly armError?: ExecutionOperationsRepositoryErrorCode | Error;
  readonly refreshError?: ExecutionOperationsRepositoryErrorCode;
  readonly readError?: ExecutionOperationsRepositoryErrorCode;
  readonly walletLamports?: bigint;
  readonly rpcFails?: boolean;
}

function harness(options: FakeOptions = {}, state: AutoArmState = createAutoArmState()) {
  const calls = {
    expire: 0, read: [] as ExecutionAutoArmContextQueryV1[],
    refresh: [] as ExecutionEnvelopeProviderRefreshCommandV1[],
    arm: [] as Readonly<{
      request: ExecutionArmamentRequestV2;
      authorization: ExecutionOperatorAuthorizationV2;
      envelopeId: string;
    }>[],
    rpc: [] as Readonly<{ wallet: string; lag: number; now: number }>[],
  };
  const repository: AutoArmRepository = {
    expireEnvelopes: async () => {
      calls.expire += 1;
      return Object.freeze({ payloadVersion: 1, expiredCount: 0, databaseNowMs: DB_NOW_MS });
    },
    readAutoArmContext: async (query) => {
      calls.read.push(query);
      if (options.readError !== undefined) throw new ExecutionOperationsRepositoryError(options.readError);
      return options.context ?? context();
    },
    refreshEnvelopeProviderSnapshot: async (command) => {
      calls.refresh.push(command);
      if (options.refreshError !== undefined) {
        throw new ExecutionOperationsRepositoryError(options.refreshError);
      }
      return Object.freeze({ payloadVersion: 1, refreshed: true, snapshot: null, databaseNowMs: DB_NOW_MS });
    },
    armEnvelope: async (input): Promise<ExecutionActivationArmamentV2> => {
      calls.arm.push(input);
      if (options.armError instanceof Error) throw options.armError;
      if (options.armError !== undefined) throw new ExecutionOperationsRepositoryError(options.armError);
      return createExecutionArmamentV2({
        payloadVersion: 2, request: input.request,
        authorizationId: input.authorization.authorizationId,
        authorizationFingerprint: input.authorization.authorizationFingerprint,
        admissionReportId: `execution_risk_admission_${'a'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'b'.repeat(64)}`,
      });
    },
  };
  const rpc = {
    observeWallet: async (
      wallet: string, lag: number, _signal: AbortSignal, now: () => number,
    ): Promise<ReadinessWalletObservationV1> => {
      calls.rpc.push({ wallet, lag, now: now() });
      if (options.rpcFails === true) throw new Error('RPC_TIMEOUT https://rpc.example.com/?api-key=x');
      return Object.freeze({
        slot: 1_000n, blockTimeMs: NOW_MS, observedAtMs: now(),
        walletLamports: options.walletLamports ?? 1_000_000_000n, tokenBalanceCount: 0,
      });
    },
  };
  const tick = () => runAutoArmTick({ config, repository, rpc, state }, new AbortController().signal);
  return { calls, state, tick };
}

void test('each IDLE reason makes no RPC call and arms nothing', async () => {
  const cases: readonly [string, Partial<ExecutionAutoArmContextV1>][] = [
    ['NO_ENVELOPE', { envelope: null, qualification: null, candidateIntent: null }],
    ['CONTROL_NOT_RUNNING', { controlState: 'ENTRY_STOP' }],
    ['CONTROL_NOT_RUNNING', { controlState: 'HARD_STOP' }],
    ['UNKNOWN_BLOCK', { unknownBlock: true }],
    ['ACTIVE_ARMAMENT', { activeArmament: 'ARMED' }],
    ['ACTIVE_ARMAMENT', { activeArmament: 'LOCKED' }],
    ['OPEN_POSITION', { openPositions: 1 }],
    ['WINDOW_CUTOFF', {
      databaseNowMs: envelope.validUntilMs - envelope.maximumHoldingMs - ENVELOPE_EXIT_MARGIN_MS + 1,
    }],
    ['CAPACITY', { buysArmed: 5 }],
    ['LOSS_CAP', { realizedLossRaw: 30_000_000n }],
    ['NO_INTENT', { candidateIntent: null }],
  ];
  for (const [reason, overrides] of cases) {
    const { calls, tick } = harness({ context: context(overrides) });
    const result = await tick();
    assert.deepEqual(result, { kind: 'IDLE', reason }, reason);
    assert.equal(calls.rpc.length, 0, reason);
    assert.equal(calls.arm.length, 0, reason);
    assert.equal(calls.refresh.length, 0, reason);
  }
});

void test('POLICY_FRESHNESS idles without RPC when the policy max ages are below 2 x lease + 30 s', async () => {
  const shortPolicy = createExecutionRiskPolicy({ ...policyFields(), walletSnapshotMaxAgeMs: 109_999 });
  const shortEnvelope = createEntryEnvelope({
    payloadVersion: 2, qualification, operatorId: ENVELOPE_OPERATOR,
    perBuyQuoteAmountRaw: PER_BUY, maxBuys: 5, maxTotalExposureRaw: 50_000_000n,
    maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 120_000,
    validFromMs: NOW_MS, validUntilMs: qualification.expiresAtMs, policy: shortPolicy,
  });
  const { calls, tick } = harness({ context: context({ envelope: shortEnvelope }) });
  assert.deepEqual(await tick(), { kind: 'IDLE', reason: 'POLICY_FRESHNESS' });
  assert.equal(calls.rpc.length, 0);
});

void test('a wallet RPC failure defers without arming and without logging the URL', async () => {
  const { calls, tick } = harness({ rpcFails: true });
  const result = await tick();
  assert.deepEqual(result, { kind: 'DEFERRED', reason: 'WALLET_RPC_FAILED' });
  assert.equal(calls.arm.length, 0);
  assert.doesNotMatch(formatAutoArmTickLog(result), /https|api-key/u);
});

void test('an insufficient wallet idles without arming', async () => {
  const { calls, tick } = harness({ walletLamports: PER_BUY + FEE_RESERVE - 1n });
  assert.deepEqual(await tick(), { kind: 'IDLE', reason: 'INSUFFICIENT_WALLET' });
  assert.equal(calls.arm.length, 0);
  const enough = harness({ walletLamports: PER_BUY + FEE_RESERVE });
  assert.equal((await enough.tick()).kind, 'ARMED');
});

void test('happy path arms the candidate with the envelope limits and operator', async () => {
  const { calls, tick } = harness();
  const result = await tick();
  assert.equal(result.kind, 'ARMED');
  assert.equal(calls.expire, 1);
  assert.deepEqual(calls.read, [{
    generationId: config.generationId, minimumRemainingMs: 95_000,
    providerRefreshThresholdMs: 1, excludedIntentIds: [],
  }]);
  assert.deepEqual(calls.rpc, [{ wallet: config.walletPublicKey, lag: 8, now: DB_NOW_MS }]);
  assert.equal(calls.arm.length, 1);
  const [armed] = calls.arm;
  if (armed === undefined) throw new Error('not armed');
  const { request, authorization, envelopeId } = armed;
  assert.equal(envelopeId, envelope.envelopeId);
  assert.equal(request.maximumCapitalLamports, PER_BUY);
  assert.equal(request.maximumHoldingMs, envelope.maximumHoldingMs);
  assert.equal(request.policy.policyFingerprint, envelope.policy.policyFingerprint);
  assert.equal(request.operatorId, ENVELOPE_OPERATOR);
  assert.equal(request.operatorReason, `envelope:${envelope.envelopeId}`);
  assert.equal(request.target.intentId, INTENT_ID);
  assert.equal(request.armedAtMs, DB_NOW_MS);
  assert.ok(request.armamentExpiresAtMs <= intent().expiresAtMs);
  assert.equal(request.armamentExpiresAtMs, intent().expiresAtMs);
  assert.equal(request.runtimeLeaseMs, LEASE_MS);
  assert.equal(request.runtimeMaxFeeLamports, config.runtimeMaxFeeLamports);
  assert.equal(request.providerSnapshot.provenance, 'EXECUTOR_COUNTERS');
  assert.equal(request.providerSnapshot.usedUnits, 13n);
  assert.equal(request.providerSnapshot.measuredAtMs, DB_NOW_MS);
  assert.equal(request.walletSnapshot.stateRevision, 7n);
  assert.equal(request.walletSnapshot.realizedNetPnlRaw, -2_000_000n);
  assert.deepEqual(request.walletSnapshot.openPositions, []);
  assert.equal(authorization.operatorId, ENVELOPE_OPERATOR);
  assert.equal(authorization.contextFingerprint, request.armamentRequestFingerprint);
  assert.equal(authorization.action, 'ARM');
  assert.equal(authorization.phase, 'CANARY');
  assert.equal(authorization.issuedAtMs, DB_NOW_MS);
  assert.equal(authorization.expiresAtMs, DB_NOW_MS + 60_000);
  if (result.kind !== 'ARMED') throw new Error('not armed');
  assert.equal(result.intentId, INTENT_ID);
  const line = JSON.parse(formatAutoArmTickLog(result)) as Record<string, unknown>;
  assert.deepEqual(line, {
    service: 'sol-token-executor-auto-arm', event: 'executor.auto_arm_tick',
    result: 'ARMED', reason: 'ARMED', intentId: INTENT_ID, armamentId: result.armamentId,
  });
});

void test('CONFLICT and INVALID_DATA reject and exclude the intent until it expires', async () => {
  for (const code of ['CONFLICT', 'INVALID_DATA'] as const) {
    const { state, tick, calls } = harness({ armError: code });
    assert.deepEqual(await tick(), { kind: 'REJECTED', reason: code, intentId: INTENT_ID });
    assert.deepEqual([...state.excluded], [[INTENT_ID, intent().expiresAtMs]]);
    const next = harness({ context: context({ candidateIntent: null }) }, state);
    await next.tick();
    assert.deepEqual(next.calls.read[0]?.excludedIntentIds, [INTENT_ID]);
    assert.equal(calls.arm.length, 1);
  }
});

void test('each transient arming refusal defers without excluding the intent', async () => {
  for (const code of [
    'ARMAMENT_CONTENDED', 'PROVIDER_CARRY_FORWARD_STALE', 'ENVELOPE_NOT_ARMABLE',
    'CONTROL_STOPPED', 'DATABASE_FAILURE', 'PREFLIGHT_EXPIRED',
  ] as const) {
    const { state, tick } = harness({ armError: code });
    assert.deepEqual(await tick(), { kind: 'DEFERRED', reason: code, intentId: INTENT_ID }, code);
    assert.equal(state.excluded.size, 0, code);
  }
  const unexpected = harness({ armError: new Error('boom') });
  assert.deepEqual(await unexpected.tick(),
    { kind: 'DEFERRED', reason: 'UNEXPECTED_FAILURE', intentId: INTENT_ID });
  assert.equal(unexpected.state.excluded.size, 0);
});

void test('excluded intents are pruned once their expiry has passed', async () => {
  const state = createAutoArmState();
  state.excluded.set(INTENT_ID, DB_NOW_MS);
  state.excluded.set(OTHER_INTENT_ID, DB_NOW_MS + 1);
  const { calls, tick } = harness({ context: context({ candidateIntent: null }) }, state);
  await tick();
  assert.deepEqual(calls.read[0]?.excludedIntentIds, [OTHER_INTENT_ID]);
  assert.deepEqual([...state.excluded.keys()], [OTHER_INTENT_ID]);
});

void test('expireEnvelopes runs every tick; refresh only when providerRefreshDue', async () => {
  const state = createAutoArmState();
  const idle = harness({ context: context({ activeArmament: 'LOCKED' }) }, state);
  await idle.tick();
  await idle.tick();
  assert.equal(idle.calls.expire, 2);
  assert.equal(idle.calls.refresh.length, 0);
  // A12: once the envelope policy is known, the threshold is half its provider max age.
  assert.equal(idle.calls.read[0]?.providerRefreshThresholdMs, 1);
  assert.equal(idle.calls.read[1]?.providerRefreshThresholdMs, 150_000);
  const due = harness({ context: context({ activeArmament: 'LOCKED', providerRefreshDue: true }) }, state);
  assert.deepEqual(await due.tick(), { kind: 'REFRESHED', reason: 'PROVIDER_CARRIED_FORWARD' });
  assert.equal(due.calls.expire, 1);
  assert.deepEqual(due.calls.refresh, [{
    generationId: config.generationId, maximumAgeMs: 300_000, providerRefreshThresholdMs: 150_000,
  }]);
  assert.equal(due.calls.rpc.length, 0);
  assert.equal(due.calls.arm.length, 0);
});

void test('the refresh still runs after the envelope left ACTIVE, from the remembered policy', async () => {
  const state = createAutoArmState();
  await harness({ context: context({ activeArmament: 'LOCKED' }) }, state).tick();
  const exhausted = harness({ context: context({
    envelope: null, qualification: null, candidateIntent: null, buysArmed: 0, realizedLossRaw: 0n,
    activeArmament: 'LOCKED', providerRefreshDue: true,
  }) }, state);
  assert.equal((await exhausted.tick()).kind, 'REFRESHED');
  assert.equal(exhausted.calls.refresh[0]?.maximumAgeMs, 300_000);
  const unknown = harness({ context: context({
    envelope: null, qualification: null, candidateIntent: null,
    activeArmament: 'LOCKED', providerRefreshDue: true,
  }) });
  assert.deepEqual(await unknown.tick(), { kind: 'DEFERRED', reason: 'PROVIDER_REFRESH_POLICY_UNKNOWN' });
  assert.equal(unknown.calls.refresh.length, 0);
});

void test('a refresh error is reported and the next tick runs normally', async () => {
  const state = createAutoArmState();
  state.providerUsageMaxAgeMs = 300_000;
  for (const code of ['PROVIDER_CARRY_FORWARD_REJECTED', 'DATABASE_FAILURE'] as const) {
    const failing = harness({
      context: context({ activeArmament: 'LOCKED', providerRefreshDue: true }), refreshError: code,
    }, state);
    const result = await failing.tick();
    assert.deepEqual(result, { kind: 'DEFERRED', reason: code });
    assert.match(formatAutoArmTickLog(result), new RegExp(code, 'u'));
  }
  assert.equal((await harness({}, state).tick()).kind, 'ARMED');
});

void test('an over-limit carry-forward defers with a distinct code and no arm', async () => {
  const full = Object.freeze({ snapshot: latestProvider, localUsedUnits: 991n });
  const { calls, tick } = harness({ context: context({ provider: full }) });
  assert.deepEqual(await tick(), { kind: 'DEFERRED', reason: 'PROVIDER_CARRY_FORWARD_REJECTED' });
  assert.equal(calls.arm.length, 0);
  const missing = harness({ context: context({ provider: null }) });
  assert.deepEqual(await missing.tick(), { kind: 'DEFERRED', reason: 'PROVIDER_SNAPSHOT_UNAVAILABLE' });
  assert.equal(missing.calls.rpc.length, 0);
});

void test('a context read failure is an ERROR tick', async () => {
  const { calls, tick } = harness({ readError: 'DATABASE_FAILURE' });
  assert.deepEqual(await tick(), { kind: 'ERROR', reason: 'DATABASE_FAILURE' });
  assert.equal(calls.rpc.length, 0);
});

void test('the loop logs one line per tick, evicts on ERROR and continues until stopped', async () => {
  const stop = new AbortController();
  const lines: string[] = [];
  let evictions = 0;
  const results: AutoArmTickResult[] = [
    { kind: 'ERROR', reason: 'DATABASE_FAILURE' },
    { kind: 'DEFERRED', reason: 'PROVIDER_CARRY_FORWARD_REJECTED' },
    { kind: 'IDLE', reason: 'NO_INTENT' },
  ];
  let ticks = 0;
  await runAutoArmLoop({
    tick: async (signal) => {
      assert.equal(signal.aborted, false);
      ticks += 1;
      if (ticks === 4) throw new Error('unexpected https://rpc.example.com');
      const result = results[ticks - 1];
      if (ticks >= 4 || result === undefined) { stop.abort(); return { kind: 'IDLE', reason: 'NO_INTENT' }; }
      return result;
    },
    tickTimeoutMs: 10_000, pollMs: 1, log: (line) => { lines.push(line); },
    onError: () => { evictions += 1; },
    stop: stop.signal,
  });
  assert.equal(ticks, 5);
  assert.equal(lines.length, 5);
  assert.equal(evictions, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.service, 'sol-token-executor-auto-arm');
    assert.equal(parsed.event, 'executor.auto_arm_tick');
    assert.doesNotMatch(line, /https|lamports|balance/iu);
  }
  assert.equal((JSON.parse(lines[3] ?? '{}') as Record<string, unknown>).reason, 'UNEXPECTED_FAILURE');
});

function policyFields() {
  const { payloadVersion: _version, policyFingerprint: _fingerprint, ...fields } = policy;
  return fields;
}

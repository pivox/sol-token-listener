import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  createLiveSignableLanes,
  type LiveSignableLaneDependencies,
} from '../src/executor-live/lanes.js';
import type {
  ClaimedExecutionIntent,
  ExecutionAttemptIdentity,
} from '../src/ports/execution-intent-repository.js';

void test('recovery lanes use side-filtered LIVE_RECOVER claims and never create attempts', async () => {
  const fixture = laneFixture('SIGNED_NOT_SUBMITTED');
  const lanes = createLiveSignableLanes(fixture.dependencies);

  assert.equal(await lanes.recoverSell(signal()), 'WORKED');
  assert.equal(await lanes.recoverBuy(signal()), 'WORKED');
  assert.deepEqual(fixture.calls, [
    'claim:LIVE_RECOVER:SELL', 'recover:SELL', 'release:SELL',
    'claim:LIVE_RECOVER:BUY', 'recover:BUY', 'release:BUY',
  ]);
});

void test('fresh lane transitions, begins one attempt and exposes authenticated renewal', async () => {
  const fixture = laneFixture('PENDING');
  const lanes = createLiveSignableLanes(fixture.dependencies);

  assert.equal(await lanes.sell(signal()), 'WORKED');
  assert.deepEqual(fixture.calls, [
    'claim:LIVE_EXECUTE:SELL', 'transition:SELL', 'begin:SELL',
    'fresh:SELL:1', 'renew:SELL', 'release:SELL',
  ]);
});

void test('the BUY lane carries its canonical generation while the SELL lane does not', async () => {
  const fixture = laneFixture('PENDING');
  const lanes = createLiveSignableLanes(fixture.dependencies);

  assert.equal(await lanes.buy(signal()), 'WORKED');
  assert.equal(await lanes.sell(signal()), 'WORKED');
  assert.deepEqual(fixture.claimOptions, [
    Object.freeze({
      ownerId: 'live-signable-test', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }),
    Object.freeze({
      ownerId: 'live-signable-test', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
    }),
  ]);
});

for (const outcome of [
  'SUBMITTED', 'UNKNOWN_REQUIRES_RECONCILIATION',
] as const) {
  void test(`releases the authoritative ${outcome} claim returned by fresh execution`,
    async () => {
      const fixture = laneFixture('PROCESSING', false, outcome);

      assert.equal(await createLiveSignableLanes(fixture.dependencies).sell(signal()), 'WORKED');

      assert.deepEqual(fixture.released, [`${outcome}:4`]);
    });

  void test(`releases the authoritative ${outcome} claim returned by recovery`, async () => {
    const fixture = laneFixture('SIGNED_NOT_SUBMITTED', false, outcome);

    assert.equal(
      await createLiveSignableLanes(fixture.dependencies).recoverSell(signal()),
      'WORKED',
    );

    assert.deepEqual(fixture.released, [`${outcome}:4`]);
  });
}

void test('an empty or already aborted claim pass is idle and has no downstream effect', async () => {
  const empty = laneFixture('PENDING', true);
  assert.equal(await createLiveSignableLanes(empty.dependencies).buy(signal()), 'IDLE');
  assert.deepEqual(empty.calls, ['claim:LIVE_EXECUTE:BUY']);

  const aborted = laneFixture('PENDING');
  const controller = new AbortController();
  controller.abort();
  assert.equal(await createLiveSignableLanes(aborted.dependencies).buy(controller.signal), 'IDLE');
  assert.deepEqual(aborted.calls, []);
});

function laneFixture(
  status: ExecutionIntentV1['status'],
  empty = false,
  outcome?: 'SUBMITTED' | 'UNKNOWN_REQUIRES_RECONCILIATION',
): Readonly<{
  calls: string[];
  released: string[];
  claimOptions: unknown[];
  dependencies: LiveSignableLaneDependencies;
}> {
  const calls: string[] = [];
  const released: string[] = [];
  const claimOptions: unknown[] = [];
  const dependencies: LiveSignableLaneDependencies = Object.freeze({
    ownerId: 'live-signable-test',
    leaseMs: 60_000,
    phase: 'CANARY',
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    intents: {
      claim: (options: Parameters<LiveSignableLaneDependencies['intents']['claim']>[0]) => {
        claimOptions.push(options);
        const side = 'side' in options ? options.side : undefined;
        calls.push(`claim:${options.purpose}:${side ?? 'NONE'}`);
        return Promise.resolve(empty ? null : claimFor(side ?? 'SELL', status));
      },
      transition: (
        active: Parameters<LiveSignableLaneDependencies['intents']['transition']>[0],
        input: Parameters<LiveSignableLaneDependencies['intents']['transition']>[1],
      ) => {
        calls.push(`transition:${active.intent.side}`);
        return Promise.resolve(Object.freeze({
          ...active.intent,
          status: input.nextStatus,
          stateRevision: active.intent.stateRevision + 1n,
        }));
      },
      beginAttempt: (
        active: Parameters<LiveSignableLaneDependencies['intents']['beginAttempt']>[0],
      ) => {
        calls.push(`begin:${active.intent.side}`);
        return Promise.resolve(Object.freeze({
          claim: active,
          attempt: Object.freeze({
            intentId: active.intent.id,
            attemptNumber: 1,
            startedAtMs: 1_000,
          } satisfies ExecutionAttemptIdentity),
        }));
      },
      renew: (active: Parameters<LiveSignableLaneDependencies['intents']['renew']>[0]) => {
        calls.push(`renew:${active.intent.side}`);
        return Promise.resolve(active);
      },
      release: (active: Parameters<LiveSignableLaneDependencies['intents']['release']>[0]) => {
        calls.push(`release:${active.intent.side}`);
        released.push(`${active.intent.status}:${active.intent.stateRevision}`);
        return Promise.resolve(true);
      },
    },
    executeFresh: async (
      context: Parameters<LiveSignableLaneDependencies['executeFresh']>[0],
      _signal: AbortSignal,
      renew: Parameters<LiveSignableLaneDependencies['executeFresh']>[2],
    ) => {
      calls.push(`fresh:${context.claim.intent.side}:${context.attempt.attemptNumber}`);
      const active = await renew();
      return outcome === undefined ? active : outcomeClaim(active, outcome);
    },
    recoverPersisted: async (
      active: Parameters<LiveSignableLaneDependencies['recoverPersisted']>[0],
    ) => {
      calls.push(`recover:${active.intent.side}`);
      return outcome === undefined ? active : outcomeClaim(active, outcome);
    },
    clock: () => 1_000,
  });
  return Object.freeze({ calls, released, claimOptions, dependencies });
}

function outcomeClaim(
  claim: ClaimedExecutionIntent,
  status: 'SUBMITTED' | 'UNKNOWN_REQUIRES_RECONCILIATION',
): ClaimedExecutionIntent {
  return Object.freeze({
    ...claim,
    intent: Object.freeze({
      ...claim.intent,
      status,
      stateRevision: claim.intent.stateRevision
        + (claim.intent.status === 'PROCESSING' ? 3n : 1n),
      lastReasonCode: status === 'SUBMITTED'
        ? 'SUBMISSION_ACCEPTED' : 'RECONCILIATION_REQUIRED',
      updatedAtMs: claim.intent.updatedAtMs + 1,
    }),
  });
}

function claimFor(
  side: 'BUY' | 'SELL',
  status: ExecutionIntentV1['status'],
): ClaimedExecutionIntent {
  const started = status === 'PROCESSING' || status === 'SIGNED_NOT_SUBMITTED';
  return Object.freeze({
    intent: Object.freeze({
      id: `execution_intent_${'a'.repeat(64)}`,
      payloadVersion: 1,
      logicalOrderKey: 'logical',
      strategyId: 'strategy',
      strategyVersion: 1,
      positionId: 'position',
      logicalCommandId: 'logical',
      mint: '11111111111111111111111111111111',
      side,
      venuePolicy: side === 'BUY' ? 'PUMP_FUN_ONLY' : 'CANONICAL_EXIT',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      quoteAmountRaw: side === 'BUY' ? 1n : null,
      baseAmountRaw: side === 'SELL' ? 1n : null,
      minimumAmountOutRaw: 1n,
      decisionEventId: 'decision',
      decisionFingerprint: 'b'.repeat(64),
      requestedAtMs: 0,
      expiresAtMs: 2_000,
      status,
      attemptCount: started ? 1 : 0,
      stateRevision: status === 'SIGNED_NOT_SUBMITTED' ? 3n
        : status === 'PROCESSING' ? 1n : 0n,
      lastReasonCode: status === 'SIGNED_NOT_SUBMITTED' ? 'SIGNATURE_PERSISTED'
        : status === 'PROCESSING' ? 'EXECUTION_STARTED' : null,
      terminalAtMs: null,
      reconciliationCompletedAtMs: null,
      purgeAfterMs: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    }),
    leaseOwner: 'live-signable-test',
    leaseToken: '00000000-0000-4000-8000-000000000000',
    leaseExpiresAtMs: 61_000,
  });
}

function signal(): AbortSignal { return new AbortController().signal; }

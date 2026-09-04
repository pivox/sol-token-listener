import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  createExecutionAttemptEvaluator,
  createLiveExecutionAttemptEvaluator,
  isInternalExecutionAttemptEvaluatorError,
} from '../src/executor-simulation/attempt-evaluator.js';
import {
  LiveTransactionCandidateAuthority,
  LiveTransactionPreparer,
} from '../src/executor-live/transaction-preparer.js';
import { ProviderAffineSession } from '../src/executor-simulation/provider-session.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../src/launchpads/pumpfun/official-sdk.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  GLOBAL_CONFIG_PDA,
  OFFLINE_PUMP_AMM_PROGRAM,
  lpMintPda,
  poolPda,
  poolV2Pda,
  pumpPoolAuthorityPda,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID as PUMP_SWAP_FEE_PROGRAM_ID,
  userVolumeAccumulatorPda,
} from '../src/markets/pumpswap/official-sdk.js';
import type {
  ExecutionAccountSnapshot,
  ExecutionAddressDiscovery,
  ExecutionDiscoveryMarketGateway,
  ExecutionRpcAccount,
  ExecutionUnsignedSimulationResult,
} from '../src/ports/execution-market-gateway.js';
import type { ExecutionTransactionSigner } from '../src/ports/execution-transaction-signer.js';
import type { ExecutionVenuePool } from '../src/ports/execution-venue-repository.js';

const PUBLIC_KEY = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const HASH = 'a'.repeat(64);
const NOW = 1_800_000_000_000;
const PAYER = key(10);
const MINT = key(20);
const BLOCKHASH = key(200);
const SLOT = 123n;

void test('throws one authenticated evaluator cancellation before creating a provider session', async () => {
  let factoryCalls = 0;
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => {
      factoryCalls += 1;
      throw new Error('must not run');
    },
    clock: () => NOW,
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    evaluator.evaluate(context(), controller.signal, async () => undefined),
    (error: unknown) => {
      assert.equal(
        isInternalExecutionAttemptEvaluatorError(error, 'OPERATION_ABORTED'),
        true,
      );
      return true;
    },
  );
  assert.equal(factoryCalls, 0);
});

void test('derives a Pump.fun BUY quote and official build only from the final provider-owned snapshot', async () => {
  const fixture = pumpFunSnapshots(false);
  const session = new FakeSession(fixture.discovery, fixture.final, 'BUY');
  const renewals: string[] = [];
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({
      findFinalizedCanonicalPumpSwapPool: async () => {
        throw new Error('Pump.fun BUY must not query the database.');
      },
    }),
    sessionFactory: () => session,
    clock: () => NOW,
  }));

  const draft = await evaluator.evaluate(
    context(intentValue({ mint: MINT, quoteAmountRaw: 1_000_000n })),
    activeSignal(),
    async (boundary) => { renewals.push(boundary); },
  );

  assert.equal(draft.resultKind, 'SUCCESS');
  assert.equal(draft.effectiveVenue, 'PUMP_FUN');
  assert.equal(draft.providerId, 'primary');
  assert.equal(draft.snapshotSlot, SLOT);
  assert.equal(draft.amountInRaw, 1_000_000n);
  assert.ok((draft.expectedAmountOutRaw ?? 0n) > 0n);
  assert.ok((draft.protectedAmountOutRaw ?? 0n) > 0n);
  assert.match(draft.quoteFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.match(draft.snapshotFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.match(draft.buildFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.deepEqual(renewals, ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION']);
  assert.deepEqual(session.calls, [
    'genesis', 'discovery', 'snapshot', 'blockhash', 'fee', 'simulate',
  ]);
  assert.deepEqual(session.simulationAddresses, [
    PAYER,
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(PAYER), true).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(PAYER), true).toBase58(),
  ]);
});

void test('returns one opaque live candidate from the exact request simulated by the preparer', async () => {
  const fixture = pumpFunSnapshots(false);
  const order: string[] = [];
  const session = new FakeSession(
    fixture.discovery, fixture.final, 'BUY', null, () => { order.push('simulate'); },
  );
  const authority = new LiveTransactionCandidateAuthority();
  let preparerFactoryCalls = 0;
  let signerCalls = 0;
  const signer: ExecutionTransactionSigner = Object.freeze({
    publicKey: PAYER,
    signMessage: () => {
      signerCalls += 1;
      order.push('sign');
      return Promise.resolve(Object.freeze({ signature: new Uint8Array(64) }));
    },
    close: () => Promise.resolve(),
  });
  const evaluator = createLiveExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => session,
    clock: () => NOW,
  }), (simulationGateway) => {
    preparerFactoryCalls += 1;
    return new LiveTransactionPreparer(simulationGateway, signer, authority, 1_232);
  });

  const result = await evaluator.evaluate(context(), activeSignal(), async (boundary) => {
    order.push(boundary);
  });

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.artifact.resultKind, 'SUCCESS');
  assert.deepEqual(Object.keys(result).sort(), ['artifact', 'candidate', 'outcome', 'payloadVersion']);
  assert.deepEqual(Object.keys(result.candidate), ['payloadVersion']);
  assert.equal(Object.getPrototypeOf(result.candidate), null);
  assert.equal(preparerFactoryCalls, 1);
  assert.equal(signerCalls, 1);
  const material = authority.consume(result.candidate);
  assert.ok(material);
  assert.equal(authority.consume(result.candidate), null);
  assert.equal(material.quoteObservedAtMs, NOW);
  assert.equal(material.quoteExpiresAtMs, NOW + 3_000);
  assert.deepEqual(material.signedSimulationAccountAddresses, [
    PAYER,
    getAssociatedTokenAddressSync(
      new PublicKey(MINT), new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
    ).toBase58(),
    getAssociatedTokenAddressSync(
      NATIVE_MINT, new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
    ).toBase58(),
  ]);
  assert.equal(Object.isFrozen(material.signedSimulationAccountAddresses), true);
  assert.deepEqual(session.calls, [
    'genesis', 'discovery', 'snapshot', 'blockhash', 'fee', 'simulate',
  ]);
  assert.deepEqual(order, [
    'BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION', 'simulate', 'BEFORE_SIGNING', 'sign',
  ]);
});

void test('returns live failures without a candidate and never signs failed simulation', async () => {
  const fixture = pumpFunSnapshots(false);
  const session = new FakeSession(fixture.discovery, fixture.final, 'BUY', 'PROGRAM_ERROR');
  let signerCalls = 0;
  const signer: ExecutionTransactionSigner = Object.freeze({
    publicKey: PAYER,
    signMessage: () => {
      signerCalls += 1;
      return Promise.resolve(Object.freeze({ signature: new Uint8Array(64) }));
    },
    close: () => Promise.resolve(),
  });
  const renewals: string[] = [];
  const result = await createLiveExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => session,
    clock: () => NOW,
  }), (simulationGateway) => new LiveTransactionPreparer(
    simulationGateway, signer, new LiveTransactionCandidateAuthority(), 1_232,
  )).evaluate(context(), activeSignal(), async (boundary) => { renewals.push(boundary); });

  assert.equal(result.outcome, 'FAILURE');
  assert.equal(result.artifact.resultKind, 'SIMULATION_FAILED');
  assert.equal(result.candidate, null);
  assert.equal(signerCalls, 0);
  assert.deepEqual(renewals, ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION']);
});

void test('propagates a live pre-signing renewal failure without signing or issuing a candidate', async () => {
  const fixture = pumpFunSnapshots(false);
  const authority = new CountingCandidateAuthority();
  const renewalFailure = new Error('renewal fence marker');
  const renewals: string[] = [];
  let signerCalls = 0;
  const signer: ExecutionTransactionSigner = Object.freeze({
    publicKey: PAYER,
    signMessage: () => {
      signerCalls += 1;
      return Promise.resolve(Object.freeze({ signature: new Uint8Array(64) }));
    },
    close: () => Promise.resolve(),
  });
  const evaluator = createLiveExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => new FakeSession(fixture.discovery, fixture.final, 'BUY'),
    clock: () => NOW,
  }), (simulationGateway) => new LiveTransactionPreparer(
    simulationGateway, signer, authority, 1_232,
  ));

  await assert.rejects(evaluator.evaluate(
    context(),
    activeSignal(),
    async (boundary) => {
      renewals.push(boundary);
      if (boundary === 'BEFORE_SIGNING') throw renewalFailure;
    },
  ), (error: unknown) => error === renewalFailure);

  assert.deepEqual(renewals, [
    'BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION', 'BEFORE_SIGNING',
  ]);
  assert.equal(signerCalls, 0);
  assert.equal(authority.issueCalls, 0);
});

void test('does not construct a live preparer for a pre-terminal evaluation failure', async () => {
  const fixture = pumpFunSnapshots(false);
  let preparerFactoryCalls = 0;
  const result = await createLiveExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => new FakeSession(fixture.discovery, fixture.final, 'BUY'),
    clock: () => NOW,
  }), () => {
    preparerFactoryCalls += 1;
    throw new Error('must not construct');
  }).evaluate(
    context(intentValue({ minimumAmountOutRaw: 1_000_000_000n })),
    activeSignal(),
    async () => undefined,
  );

  assert.equal(result.outcome, 'FAILURE');
  assert.equal(result.artifact.resultKind, 'QUOTE_FAILED');
  assert.equal(result.candidate, null);
  assert.equal(preparerFactoryCalls, 0);
});

void test('derives and simulates a Pump.fun SELL from the same active final snapshot', async () => {
  const fixture = pumpFunSnapshots(false, 'SELL');
  const session = new FakeSession(fixture.discovery, fixture.final, 'SELL');
  let databaseCalls = 0;
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({
      findFinalizedCanonicalPumpSwapPool: async () => { databaseCalls += 1; return null; },
    }),
    sessionFactory: () => session,
    clock: () => NOW,
  }));

  const draft = await evaluator.evaluate(
    context(intentValue({
      side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null,
      baseAmountRaw: 1_000n,
    })),
    activeSignal(),
    async () => undefined,
  );

  assert.equal(draft.resultKind, 'SUCCESS');
  assert.equal(draft.effectiveVenue, 'PUMP_FUN');
  assert.equal(draft.amountInRaw, 1_000n);
  assert.equal(draft.simulatedBaseDeltaRaw, -1_000n);
  assert.ok((draft.simulatedQuoteDeltaRaw ?? 0n) > 0n);
  assert.equal(databaseCalls, 0);
});

void test('routes a completed curve through the database and derives a PumpSwap SELL from its 14-account final snapshot', async () => {
  const fixture = await pumpSwapSnapshots();
  const session = new FakeSession(fixture.discovery, fixture.final, 'PUMP_SWAP_SELL');
  let databaseCalls = 0;
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({
      findFinalizedCanonicalPumpSwapPool: async () => {
        databaseCalls += 1;
        return fixture.pool;
      },
    }),
    sessionFactory: () => session,
    clock: () => NOW,
  }));

  const draft = await evaluator.evaluate(
    context(intentValue({
      side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null,
      baseAmountRaw: 1_000n,
    })),
    activeSignal(),
    async () => undefined,
  );

  assert.equal(draft.resultKind, 'SUCCESS');
  assert.equal(draft.effectiveVenue, 'PUMP_SWAP');
  assert.equal(draft.amountInRaw, 1_000n);
  assert.equal(databaseCalls, 1);
  assert.equal(session.snapshotRequest?.length, 14);
  assert.equal(
    session.snapshotRequest?.[13],
    bondingCurvePda(new PublicKey(MINT)).toBase58(),
  );
  assert.deepEqual(session.simulationAddresses, [
    PAYER,
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(PAYER), true).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(PAYER), true).toBase58(),
  ]);
});

void test('rejects a forbidden PumpSwap Token-2022 extension during quote evaluation', async () => {
  const fixture = await pumpSwapForbiddenToken2022Snapshots();
  const session = new FakeSession(fixture.discovery, fixture.final, 'PUMP_SWAP_SELL');
  const draft = await createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => fixture.pool }),
    sessionFactory: () => session,
    clock: () => NOW,
  })).evaluate(
    context(intentValue({
      side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null,
      baseAmountRaw: 1_000n,
    })),
    activeSignal(),
    async () => undefined,
  );

  assert.equal(draft.resultKind, 'QUOTE_FAILED');
  assert.equal(draft.failureStage, 'QUOTE');
  assert.equal(draft.failureCode, 'QUOTE_REJECTED');
  assert.equal(draft.terminalReasonCode, 'UNSUPPORTED_TOKEN_EXTENSION');
  assert.equal(draft.snapshotSlot, SLOT);
  assert.match(draft.snapshotFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(draft.buildFingerprint, null);
  assert.equal(session.calls.includes('blockhash'), false);
});

void test('maps stale and over-protected Pump.fun quotes to closed terminal quote drafts', async () => {
  for (const entry of [
    { minimumAmountOutRaw: 1n, times: [NOW, NOW + 3_001], reason: 'QUOTE_STALE' },
    { minimumAmountOutRaw: 1_000_000_000n, times: [NOW], reason: 'MINIMUM_AMOUNT_OUT_VIOLATED' },
  ] as const) {
    const fixture = pumpFunSnapshots(false);
    const session = new FakeSession(fixture.discovery, fixture.final, 'BUY');
    let clockIndex = 0;
    const evaluator = createExecutionAttemptEvaluator(Object.freeze({
      config: simulationConfig(),
      venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
      sessionFactory: () => session,
      clock: () => entry.times[Math.min(clockIndex++, entry.times.length - 1)] ?? NOW,
    }));

    const draft = await evaluator.evaluate(
      context(intentValue({ minimumAmountOutRaw: entry.minimumAmountOutRaw })),
      activeSignal(),
      async () => undefined,
    );

    assert.equal(draft.resultKind, 'QUOTE_FAILED');
    assert.equal(draft.failureCode, 'QUOTE_REJECTED');
    assert.equal(draft.terminalReasonCode, entry.reason);
    assert.equal(draft.snapshotSlot, SLOT);
    assert.match(draft.snapshotFingerprint ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(draft.buildFingerprint, null);
    assert.equal(session.calls.includes('blockhash'), false);
  }
});

void test('rejects a quote and immutable intent which expire while simulation RPC is in flight', async () => {
  const fixture = pumpFunSnapshots(false);
  let currentMs = NOW;
  const session = new FakeSession(
    fixture.discovery,
    fixture.final,
    'BUY',
    null,
    () => { currentMs = NOW + 3_001; },
  );
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => session,
    clock: () => currentMs,
  }));

  const draft = await evaluator.evaluate(
    context(intentValue({ expiresAtMs: NOW + 3_000 })),
    activeSignal(),
    async () => undefined,
  );

  assert.equal(draft.resultKind, 'QUOTE_FAILED');
  assert.equal(draft.failureCode, 'QUOTE_REJECTED');
  assert.equal(draft.terminalReasonCode, 'QUOTE_STALE');
  assert.deepEqual(session.calls, [
    'genesis', 'discovery', 'snapshot', 'blockhash', 'fee', 'simulate',
  ]);
});

void test('pins the complete simulation configuration fingerprint vector', async () => {
  const fixture = pumpFunSnapshots(false);
  const draft = await createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => new FakeSession(fixture.discovery, fixture.final, 'BUY'),
    clock: () => NOW,
  })).evaluate(context(), activeSignal(), async () => undefined);

  assert.equal(
    draft.configurationFingerprint,
    '2ebafd91c92abbed3802920b1a39f69fd9c293c8b835915e238c71fe716854a1',
  );
});

void test('fails closed on corrupt, incomplete, or causally drifting PumpSwap curve evidence', async () => {
  const canonical = await pumpSwapSnapshots();
  const incomplete = requiredTestAccount(pumpFunSnapshots(false).final, 3);
  const corrupt = Object.freeze({
    ...requiredTestAccount(canonical.final, 13), dataBase64: 'AA==', space: 1n,
  });
  const fixtures = [
    replaceFinalAccount(canonical.final, 13, corrupt),
    replaceFinalAccount(canonical.final, 13, incomplete),
    Object.freeze({ ...canonical.final, slot: canonical.discovery.slot + 9n }),
  ];

  for (const final of fixtures) {
    const session = new FakeSession(canonical.discovery, final, 'PUMP_SWAP_SELL');
    const renewals: string[] = [];
    const draft = await createExecutionAttemptEvaluator(Object.freeze({
      config: simulationConfig(),
      venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => canonical.pool }),
      sessionFactory: () => session,
      clock: () => NOW,
    })).evaluate(
      context(intentValue({
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null,
        baseAmountRaw: 1_000n,
      })),
      activeSignal(),
      async (boundary) => { renewals.push(boundary); },
    );

    assert.equal(draft.resultKind, 'QUOTE_FAILED');
    assert.equal(draft.failureCode, 'RPC_RESPONSE_INVALID');
    assert.equal(draft.terminalReasonCode, 'EXECUTION_EVIDENCE_INVALID');
    assert.equal(draft.snapshotSlot, final.slot);
    assert.match(draft.snapshotFingerprint ?? '', /^[0-9a-f]{64}$/u);
    assert.deepEqual(renewals, ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION']);
    assert.equal(session.calls.includes('blockhash'), false);
  }
});

void test('completes both durable renewal boundaries before returning an early terminal quote draft', async () => {
  const fixture = pumpFunSnapshots(false);
  const session = new FakeSession(fixture.discovery, fixture.final, 'BUY');
  const renewals: string[] = [];
  const draft = await createExecutionAttemptEvaluator(Object.freeze({
    config: simulationConfig(),
    venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
    sessionFactory: () => session,
    clock: () => NOW,
  })).evaluate(
    context(intentValue({ minimumAmountOutRaw: 1_000_000_000n })),
    activeSignal(),
    async (boundary) => { renewals.push(boundary); },
  );

  assert.equal(draft.resultKind, 'QUOTE_FAILED');
  assert.deepEqual(renewals, ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION']);
});

void test('completes both renewal boundaries for provider, build, and simulation terminal failures', async () => {
  const cases = [
    {
      name: 'provider',
      fixture: pumpFunSnapshots(false),
      sessionFactory: (config: ConstructorParameters<typeof ProviderAffineSession>[0]) =>
        new ProviderAffineSession(config, async () => new Response('', { status: 429 })),
      expectedKind: 'PROVIDER_FAILED', expectedStage: 'PROVIDER',
    },
    {
      name: 'build',
      fixture: pumpFunSnapshots(false, 'BUY', true),
      sessionFactory: undefined,
      expectedKind: 'BUILD_FAILED', expectedStage: 'BUILD',
    },
    {
      name: 'simulation',
      fixture: pumpFunSnapshots(false),
      sessionFactory: undefined,
      expectedKind: 'SIMULATION_FAILED', expectedStage: 'SIMULATION',
    },
  ] as const;

  for (const entry of cases) {
    const renewals: string[] = [];
    const session = new FakeSession(
      entry.fixture.discovery,
      entry.fixture.final,
      'BUY',
      entry.name === 'simulation' ? 'PROGRAM_ERROR' : null,
    );
    const draft = await createExecutionAttemptEvaluator(Object.freeze({
      config: simulationConfig(),
      venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
      sessionFactory: entry.sessionFactory ?? (() => session),
      clock: () => NOW,
    })).evaluate(
      context(),
      activeSignal(),
      async (boundary) => { renewals.push(boundary); },
    );

    assert.equal(draft.resultKind, entry.expectedKind, entry.name);
    assert.equal(draft.failureStage, entry.expectedStage, entry.name);
    assert.deepEqual(
      renewals,
      ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION'],
      entry.name,
    );
  }
});

void test('propagates database and renewal-fence failures without fabricating market artifacts', async () => {
  const databaseFailure = new Error('database marker');
  const completed = pumpFunSnapshots(true);
  await assert.rejects(
    createExecutionAttemptEvaluator(Object.freeze({
      config: simulationConfig(),
      venues: Object.freeze({
        findFinalizedCanonicalPumpSwapPool: async () => { throw databaseFailure; },
      }),
      sessionFactory: () => new FakeSession(completed.discovery, completed.final, 'BUY'),
      clock: () => NOW,
    })).evaluate(
      context(intentValue({
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null,
        baseAmountRaw: 1_000n,
      })),
      activeSignal(),
      async () => undefined,
    ),
    (error: unknown) => error === databaseFailure,
  );

  const fenceFailure = new Error('fence marker');
  const active = pumpFunSnapshots(false);
  let renewalCalls = 0;
  await assert.rejects(
    createExecutionAttemptEvaluator(Object.freeze({
      config: simulationConfig(),
      venues: Object.freeze({ findFinalizedCanonicalPumpSwapPool: async () => null }),
      sessionFactory: () => new FakeSession(active.discovery, active.final, 'BUY'),
      clock: () => NOW,
    })).evaluate(
      context(intentValue({ minimumAmountOutRaw: 1_000_000_000n })),
      activeSignal(),
      async () => {
        renewalCalls += 1;
        if (renewalCalls === 2) throw fenceFailure;
      },
    ),
    (error: unknown) => error === fenceFailure,
  );
  assert.equal(renewalCalls, 2);
});

function context(intent = intentValue()) {
  const claim: ClaimedExecutionIntent = Object.freeze({
    intent,
    leaseOwner: 'worker-1',
    leaseToken: '00000000-0000-4000-8000-000000000001',
    leaseExpiresAtMs: NOW + 30_000,
  });
  return Object.freeze({
    claim,
    attempt: Object.freeze({ intentId: intent.id, attemptNumber: 1, startedAtMs: NOW }),
  });
}

function intentValue(overrides: Readonly<Record<string, unknown>> = {}): ExecutionIntentV1 {
  const draft = createExecutionIntentDraft({
    strategyId: 'strategy-1', strategyVersion: 1, positionId: 'position-1',
    logicalCommandId: 'command-1', mint: MINT, side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000_000n, baseAmountRaw: null,
    minimumAmountOutRaw: 1n, decisionEventId: 'event-1',
    decisionFingerprint: HASH, requestedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  });
  return Object.freeze({
    ...draft, status: 'PROCESSING', attemptCount: 1, stateRevision: 1n,
    lastReasonCode: 'EXECUTION_STARTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW - 1_000, updatedAtMs: NOW,
  });
}

function simulationConfig() {
  return Object.freeze({
    mode: 'simulation-only' as const,
    databaseUrl: 'postgresql://unused.invalid/db', pollMs: 1_000, leaseMs: 30_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    executorPublicKey: PAYER, providerId: 'primary',
    httpRpcUrl: 'https://rpc.invalid', expectedGenesisHash: PUBLIC_KEY,
    quoteMaxAgeMs: 3_000, slippageBps: 500n, snapshotMaxSlotLag: 8,
    maxComputeUnits: 300_000n, maxFeeLamports: 100_000n,
    maxFeePayerLamportDebit: 5_000_000n, maxPriorityFeeLamports: 0n as const,
    rpcTimeoutMs: 5_000, maxRpcCallsPerAttempt: 8,
    quoteMintAllowlist: Object.freeze([WSOL]) as readonly [string],
  });
}

function pumpFunSnapshots(
  complete: boolean,
  side: 'BUY' | 'SELL' = 'BUY',
  duplicateRecipients = false,
): Readonly<{
  readonly discovery: ExecutionAddressDiscovery;
  readonly final: ExecutionAccountSnapshot;
}> {
  const curveAddress = bondingCurvePda(new PublicKey(MINT)).toBase58();
  const zero = PublicKey.default;
  const global: Global = {
    initialized: true, authority: zero, feeRecipient: new PublicKey(key(100)),
    initialVirtualTokenReserves: new BN('1000000000'),
    initialVirtualSolReserves: new BN('100000000'),
    initialRealTokenReserves: new BN('800000000'), tokenTotalSupply: new BN('1000000000'),
    feeBasisPoints: new BN(100), withdrawAuthority: zero, enableMigrate: true,
    poolMigrationFee: new BN(0), creatorFeeBasisPoints: new BN(50),
    feeRecipients: duplicateRecipients
      ? publicKeys(101, 7).map(() => new PublicKey(key(101)))
      : publicKeys(101, 7),
    setCreatorAuthority: zero,
    adminSetCreatorAuthority: zero, createV2Enabled: true, whitelistPda: zero,
    reservedFeeRecipient: new PublicKey(key(110)), reservedFeeRecipients: publicKeys(111, 7),
    mayhemModeEnabled: false, isCashbackEnabled: true,
    buybackFeeRecipients: publicKeys(120, 8), buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('100000000'), whitelistedQuoteMints: [NATIVE_MINT],
  };
  const feeConfig = {
    bump: 1, admin: zero,
    flatFees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    feeTiers: [{
      marketCapLamportsThreshold: new BN(0),
      fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    }],
    stableFeeTiers: [],
  } as FeeConfig & { readonly bump: number; readonly stableFeeTiers: readonly unknown[] };
  const curve: BondingCurve = {
    virtualTokenReserves: new BN('1000000000'), virtualQuoteReserves: new BN('100000000'),
    realTokenReserves: new BN('800000000'), realQuoteReserves: new BN('50000000'),
    tokenTotalSupply: new BN('1000000000'), complete, creator: new PublicKey(key(30)),
    isMayhemMode: false, isCashbackCoin: true, quoteMint: NATIVE_MINT,
  };
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: zero, supply: 1_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: zero,
  }, mintData);
  const curveAccount = rpcAccount(curveAddress, PUMP_PROGRAM_ID, encodeAccount('bondingCurve', curve));
  const mintAccount = rpcAccount(MINT, TOKEN_PROGRAM_ID.toBase58(), mintData);
  const discovery = Object.freeze({
    providerId: 'primary', slot: SLOT - 1n,
    addresses: Object.freeze([curveAddress, MINT]),
    accounts: Object.freeze([curveAccount, mintAccount]),
  });
  const baseAta = getAssociatedTokenAddressSync(
    new PublicKey(MINT), new PublicKey(PAYER), true,
  ).toBase58();
  const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(PAYER), true).toBase58();
  const addresses = Object.freeze([
    GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(), MINT, curveAddress,
    PAYER, baseAta, quoteAta,
  ]);
  const final = Object.freeze({
    providerId: 'primary', slot: SLOT, addresses,
    accounts: Object.freeze([
      rpcAccount(addresses[0] ?? '', PUMP_PROGRAM_ID, encodeAccount('global', global)),
      rpcAccount(addresses[1] ?? '', PUMP_FEE_PROGRAM_ID.toBase58(), encodeAccount('feeConfig', feeConfig)),
      mintAccount, curveAccount, systemAccount(PAYER, 10_000_000n),
      side === 'SELL' ? tokenAccount(baseAta, MINT, PAYER, 1_000n, 2_039_280n, false) : null,
      side === 'SELL'
        ? tokenAccount(quoteAta, NATIVE_MINT.toBase58(), PAYER, 0n, 2_039_280n, true)
        : null,
    ]),
  });
  return Object.freeze({ discovery, final });
}

class FakeSession implements ExecutionDiscoveryMarketGateway {
  public readonly providerId = 'primary';
  public readonly calls: string[] = [];
  public simulationAddresses: readonly string[] | null = null;
  public snapshotRequest: readonly string[] | null = null;
  public constructor(
    private readonly discovery: ExecutionAddressDiscovery,
    private readonly snapshot: ExecutionAccountSnapshot,
    private readonly side: 'BUY' | 'SELL' | 'PUMP_SWAP_SELL',
    private readonly simulationFailureKind: 'PROGRAM_ERROR' | null = null,
    private readonly beforeSimulationReturn: (() => void) | null = null,
  ) {}
  public ownsAccountSnapshot(value: ExecutionAccountSnapshot): boolean { return value === this.snapshot; }
  public async verifyGenesis() {
    this.calls.push('genesis');
    return Object.freeze({
      providerId: this.providerId, expectedGenesisHash: PUBLIC_KEY, observedGenesisHash: PUBLIC_KEY,
    });
  }
  public async readAddressDiscovery(): Promise<ExecutionAddressDiscovery> {
    this.calls.push('discovery'); return this.discovery;
  }
  public async readAccountSnapshot(addresses: readonly string[]): Promise<ExecutionAccountSnapshot> {
    this.snapshotRequest = addresses;
    this.calls.push('snapshot'); return this.snapshot;
  }
  public async getLatestBlockhash(snapshotSlot: bigint) {
    this.calls.push('blockhash');
    return Object.freeze({
      providerId: this.providerId, contextSlot: snapshotSlot + 1n,
      blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n,
    });
  }
  public async getFeeForMessage(_message: string, snapshotSlot: bigint) {
    this.calls.push('fee');
    return Object.freeze({ providerId: this.providerId, contextSlot: snapshotSlot + 1n, feeLamports: 5_000n });
  }
  public async simulateUnsignedTransaction(request: Readonly<{
    readonly transactionBase64: string;
    readonly snapshotSlot: bigint;
    readonly accountAddresses: readonly string[];
  }>): Promise<ExecutionUnsignedSimulationResult> {
    this.calls.push('simulate');
    this.simulationAddresses = request.accountAddresses;
    this.beforeSimulationReturn?.();
    const base = request.accountAddresses[1] ?? '';
    const quote = request.accountAddresses[2] ?? '';
    return Object.freeze({
      providerId: this.providerId, contextSlot: request.snapshotSlot + 2n,
      failureKind: this.simulationFailureKind, logs: Object.freeze(['Program log: success']),
      unitsConsumed: 25_000n,
      accounts: Object.freeze(this.side === 'BUY' ? [
        systemAccount(PAYER, 6_955_720n),
        tokenAccount(base, MINT, PAYER, 100_000_000n, 2_039_280n, false),
        null,
      ] : this.side === 'SELL' ? [
        systemAccount(PAYER, 9_995_000n),
        tokenAccount(base, MINT, PAYER, 0n, 2_039_280n, false),
        tokenAccount(quote, NATIVE_MINT.toBase58(), PAYER, 0n, 3_039_280n, true),
      ] : [
        systemAccount(PAYER, 12_045_280n),
        tokenAccount(base, MINT, PAYER, 0n, 2_039_280n, false),
        null,
      ]),
      innerInstructions: Object.freeze([]),
    });
  }
  public usage() {
    return Object.freeze({ providerId: this.providerId, rpcCallsUsed: this.calls.length, rpcCallsLimit: 8 });
  }
}

class CountingCandidateAuthority extends LiveTransactionCandidateAuthority {
  public issueCalls = 0;

  public override issue(
    material: Parameters<LiveTransactionCandidateAuthority['issue']>[0],
  ): ReturnType<LiveTransactionCandidateAuthority['issue']> {
    this.issueCalls += 1;
    return super.issue(material);
  }
}

async function pumpSwapSnapshots(): Promise<Readonly<{
  readonly discovery: ExecutionAddressDiscovery;
  readonly final: ExecutionAccountSnapshot;
  readonly pool: ExecutionVenuePool;
}>> {
  const curveFixture = pumpFunSnapshots(true);
  const creator = pumpPoolAuthorityPda(new PublicKey(MINT)).toBase58();
  const poolAddress = poolPda(0, new PublicKey(creator), new PublicKey(MINT), NATIVE_MINT).toBase58();
  const baseVault = getAssociatedTokenAddressSync(
    new PublicKey(MINT), new PublicKey(poolAddress), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const quoteVault = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(poolAddress), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const lpMint = lpMintPda(new PublicKey(poolAddress)).toBase58();
  const pool: ExecutionVenuePool = Object.freeze({
    migrationId: 'migration-1', migrationInstruction: 'MIGRATE_V2',
    migrationConfirmationStatus: 'finalized', poolAddress, market: 'pumpswap',
    programId: PUMPSWAP_PROGRAM_ID, poolIndex: 0, creator, baseMint: MINT,
    quoteMint: WSOL, quoteDecimals: 9, baseTokenProgram: 'SPL_TOKEN',
    quoteTokenProgram: 'SPL_TOKEN', baseVault, quoteVault, lpMint,
    poolConfirmationStatus: 'finalized', activatedSlot: 100n,
    transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
  });
  const globalData = await officialPumpSwapAccountData('globalConfig', {
    admin: new PublicKey(key(30)), lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5), disableFlags: 0,
    protocolFeeRecipients: publicKeys(40, 8), coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: new PublicKey(key(50)), whitelistPda: new PublicKey(key(51)),
    reservedFeeRecipient: new PublicKey(key(52)), mayhemModeEnabled: false,
    reservedFeeRecipients: publicKeys(53, 7), isCashbackEnabled: false,
    buybackFeeRecipients: publicKeys(60, 8), buybackBasisPoints: new BN(1),
    boostAuthority: new PublicKey(key(70)), boostEnabled: false,
  });
  const feeData = await officialPumpSwapAccountData('feeConfig', {
    bump: 0, admin: new PublicKey(key(20)),
    flatFees: { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(5) },
    feeTiers: [{
      marketCapLamportsThreshold: new BN(0),
      fees: { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(5) },
    }],
    stableFeeTiers: [],
  });
  const poolData = Buffer.concat([
    await officialPumpSwapAccountData('pool', {
      poolBump: canonicalPoolBump(creator), index: 0, creator: new PublicKey(creator),
      baseMint: new PublicKey(MINT), quoteMint: NATIVE_MINT,
      lpMint: new PublicKey(lpMint), poolBaseTokenAccount: new PublicKey(baseVault),
      poolQuoteTokenAccount: new PublicKey(quoteVault), lpSupply: new BN(1_000_000),
      coinCreator: PublicKey.default, isMayhemMode: false, isCashbackCoin: false,
      virtualQuoteReserves: new BN(10_000),
    }),
    Buffer.alloc(39),
  ]);
  const baseMint = mintRpcAccount(MINT, 6, 1_000_000_000n);
  const quoteMint = mintRpcAccount(WSOL, 9, 1_000_000_000n);
  const userBase = getAssociatedTokenAddressSync(
    new PublicKey(MINT), new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const userQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const volume = userVolumeAccumulatorPda(new PublicKey(PAYER)).toBase58();
  const volumeQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(volume), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const poolV2 = poolV2Pda(new PublicKey(MINT)).toBase58();
  const curveAddress = bondingCurvePda(new PublicKey(MINT)).toBase58();
  const addresses = Object.freeze([
    GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), poolAddress,
    MINT, WSOL, baseVault, quoteVault, PAYER, userBase, userQuote,
    volume, volumeQuote, poolV2, curveAddress,
  ]);
  const final = Object.freeze({
    providerId: 'primary', slot: SLOT, addresses,
    accounts: Object.freeze([
      rpcAccount(addresses[0] ?? '', PUMPSWAP_PROGRAM_ID, globalData),
      rpcAccount(addresses[1] ?? '', PUMP_SWAP_FEE_PROGRAM_ID.toBase58(), feeData),
      rpcAccount(poolAddress, PUMPSWAP_PROGRAM_ID, poolData), baseMint, quoteMint,
      tokenAccount(baseVault, MINT, poolAddress, 500_000n, 2_039_280n, false),
      tokenAccount(quoteVault, WSOL, poolAddress, 900_000n, 2_939_280n, true),
      systemAccount(PAYER, 10_000_000n),
      tokenAccount(userBase, MINT, PAYER, 1_000n, 2_039_280n, false),
      tokenAccount(userQuote, WSOL, PAYER, 0n, 2_039_280n, true),
      null, null, null,
      curveFixture.final.accounts[3] ?? null,
    ]),
  });
  return Object.freeze({ discovery: curveFixture.discovery, final, pool });
}

async function pumpSwapForbiddenToken2022Snapshots(): Promise<Readonly<{
  readonly discovery: ExecutionAddressDiscovery;
  readonly final: ExecutionAccountSnapshot;
  readonly pool: ExecutionVenuePool;
}>> {
  const fixture = await pumpSwapSnapshots();
  const data = Buffer.alloc(170);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default,
    supply: 1_000_000_000n, decimals: 6, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  data[165] = AccountType.Mint;
  data.writeUInt16LE(ExtensionType.TransferFeeConfig, 166);
  data.writeUInt16LE(0, 168);
  const mint = rpcAccount(MINT, TOKEN_2022_PROGRAM_ID.toBase58(), data);
  const discoveryAccounts = [...fixture.discovery.accounts];
  discoveryAccounts[1] = mint;
  const finalAccounts = [...fixture.final.accounts];
  finalAccounts[3] = mint;
  return Object.freeze({
    discovery: Object.freeze({
      ...fixture.discovery,
      accounts: Object.freeze(discoveryAccounts),
    }),
    final: Object.freeze({
      ...fixture.final,
      accounts: Object.freeze(finalAccounts),
    }),
    pool: Object.freeze({ ...fixture.pool, baseTokenProgram: 'TOKEN_2022' }),
  });
}

async function officialPumpSwapAccountData(
  name: 'globalConfig' | 'feeConfig' | 'pool',
  value: unknown,
): Promise<Buffer> {
  return Buffer.from(await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode(name, value));
}

function mintRpcAccount(address: string, decimals: number, supply: bigint): ExecutionRpcAccount {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  return rpcAccount(address, TOKEN_PROGRAM_ID.toBase58(), data);
}

function canonicalPoolBump(creator: string): number {
  return PublicKey.findProgramAddressSync([
    Buffer.from('pool'), Buffer.from([0, 0]), new PublicKey(creator).toBuffer(),
    new PublicKey(MINT).toBuffer(), NATIVE_MINT.toBuffer(),
  ], new PublicKey(PUMPSWAP_PROGRAM_ID))[1];
}


function rpcAccount(address: string, owner: string, data: Uint8Array): ExecutionRpcAccount {
  return Object.freeze({
    address, lamports: 1n, owner, executable: false, rentEpoch: null,
    space: BigInt(data.byteLength), dataBase64: Buffer.from(data).toString('base64'),
  });
}

function systemAccount(address: string, lamports: bigint): ExecutionRpcAccount {
  return Object.freeze({
    address, lamports, owner: PublicKey.default.toBase58(), executable: false,
    rentEpoch: null, space: 0n, dataBase64: '',
  });
}

function tokenAccount(
  address: string,
  mint: string,
  owner: string,
  amountRaw: bigint,
  lamports: bigint,
  isNative: boolean,
): ExecutionRpcAccount {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(mint), owner: new PublicKey(owner), amount: amountRaw,
    delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
    isNativeOption: isNative ? 1 : 0, isNative: isNative ? 2_039_280n : 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return Object.freeze({
    address, lamports, owner: TOKEN_PROGRAM_ID.toBase58(), executable: false,
    rentEpoch: null, space: BigInt(data.length), dataBase64: data.toString('base64'),
  });
}

interface AccountLayoutEntry {
  readonly discriminator: readonly number[];
  readonly layout: { encode(value: unknown, destination: Buffer): number };
}

function encodeAccount(name: string, value: unknown): Buffer {
  const sdk = PUMP_SDK as unknown as {
    readonly offlinePumpProgram: {
      readonly coder: {
        readonly accounts: { readonly accountLayouts: ReadonlyMap<string, AccountLayoutEntry> };
      };
    };
  };
  const entry = sdk.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  if (entry === undefined) throw new Error(`Unknown fixture account: ${name}.`);
  const destination = Buffer.alloc(4_096);
  const length = entry.layout.encode(value, destination);
  return Buffer.concat([Buffer.from(entry.discriminator), destination.subarray(0, length)]);
}

function publicKeys(seed: number, length: number): PublicKey[] {
  return Array.from({ length }, (_unused, index) => new PublicKey(key(seed + index)));
}

function key(seed: number): string {
  return new PublicKey(Uint8Array.from(
    { length: 32 }, (_unused, index) => (seed + index) % 256,
  )).toBase58();
}

function activeSignal(): AbortSignal { return new AbortController().signal; }

function replaceFinalAccount(
  snapshot: ExecutionAccountSnapshot,
  index: number,
  account: ExecutionRpcAccount,
): ExecutionAccountSnapshot {
  const accounts = [...snapshot.accounts];
  accounts[index] = account;
  return Object.freeze({ ...snapshot, accounts: Object.freeze(accounts) });
}

function requiredTestAccount(
  snapshot: ExecutionAccountSnapshot,
  index: number,
): ExecutionRpcAccount {
  const account = snapshot.accounts[index];
  if (account === undefined || account === null) throw new Error('Missing fixture account.');
  return account;
}

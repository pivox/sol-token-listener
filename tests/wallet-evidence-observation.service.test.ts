import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WalletEvidenceObservationError,
  WalletEvidenceObservationService,
} from '../src/application/wallet-evidence-observation.service.js';
import {
  createWalletFundingAssessmentId,
  WALLET_FUNDING_PAYLOAD_VERSION,
  type WalletFundingBuy,
  type WalletFundingExtractionResult,
} from '../src/domain/wallet-funding.js';
import {
  trustedTerminalAttribution,
  type TerminalDiagnosticCode,
} from '../src/domain/terminal-attribution.js';
import {
  createBondingCurveTradeObservedEvent,
  type BondingCurveTradeObservedEventV1,
} from '../src/domain/launchpad-events.js';
import type {
  LaunchpadTrade,
} from '../src/domain/types.js';
import type {
  WalletFundingEvidenceExtractor,
} from '../src/ports/wallet-funding-evidence-extractor.js';
import type {
  WalletEvidenceBatch,
  WalletEvidenceRepository,
} from '../src/ports/wallet-evidence-repository.js';
import {
  createSolanaObservedTransaction,
  type SolanaObservedTransaction,
} from '../src/solana/rpc/observed-transaction.js';
import type {
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';

void test('sorts canonical known buys, extracts once and records one frozen batch', async () => {
  const transaction = observedTransaction();
  const later = tradeEvent(transaction, trade('later', 3));
  const earlier = tradeEvent(transaction, trade('earlier', 2));
  const calls: WalletFundingBuy[][] = [];
  const recorded: WalletEvidenceBatch[] = [];
  const extractor: WalletFundingEvidenceExtractor<NormalizedTransaction> = {
    extract(raw, buys) {
      assert.equal(raw, transaction.raw);
      calls.push([...buys]);
      return noEvidenceResult(buys);
    },
  };
  const repository: WalletEvidenceRepository = {
    async record(batch) {
      recorded.push(batch);
    },
  };
  const service = new WalletEvidenceObservationService(extractor, repository);

  const result = await service.observe(
    transaction,
    Object.freeze([later, earlier]),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.map((buy) => buy.tradeId), ['earlier', 'later']);
  assert.equal(result.assessments.length, 2);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.signature, transaction.signature);
  assert.equal(recorded[0]?.confirmationStatus, 'confirmed');
  assert.ok(Object.isFrozen(recorded[0]));
  assert.equal(recorded[0]?.assessments, result.assessments);
  assert.equal(trustedTerminalAttribution(result), null);
});

void test('ignores sells and unknown traders and performs no empty write', async () => {
  const transaction = observedTransaction();
  let extractorCalls = 0;
  let repositoryCalls = 0;
  const service = new WalletEvidenceObservationService(
    {
      extract() {
        extractorCalls += 1;
        return emptyResult();
      },
    },
    {
      async record() {
        repositoryCalls += 1;
      },
    },
  );

  const result = await service.observe(
    transaction,
    Object.freeze([
      tradeEvent(transaction, trade('sell', 2, { kind: 'SELL' })),
      tradeEvent(transaction, trade('unknown', 3, { trader: null })),
    ]),
  );

  assert.deepEqual(result, emptyResult());
  assert.equal(extractorCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(trustedTerminalAttribution(result), null);
});

void test('rejects duplicate identities before extraction', async () => {
  const transaction = observedTransaction();
  const event = tradeEvent(transaction, trade('duplicate', 2));
  let extractorCalls = 0;
  const service = new WalletEvidenceObservationService(
    {
      extract() {
        extractorCalls += 1;
        return emptyResult();
      },
    },
    noOpRepository(),
  );

  await assert.rejects(
    service.observe(transaction, Object.freeze([event, event])),
    isObservationError('validate', /duplicate/u),
  );
  assert.equal(extractorCalls, 0);
});

void test('rejects foreign signatures and transaction cursors before extraction', async () => {
  const transaction = observedTransaction();
  const event = tradeEvent(transaction, trade('foreign', 2));
  const foreignSignature = Object.freeze({
    ...event,
    signature: 'foreign-signature',
  }) as BondingCurveTradeObservedEventV1;
  const foreignSlot = Object.freeze({
    ...event,
    cursor: Object.freeze({ ...event.cursor, slot: 11n }),
  }) as BondingCurveTradeObservedEventV1;
  const service = new WalletEvidenceObservationService(
    { extract: () => emptyResult() },
    noOpRepository(),
  );

  await assert.rejects(
    service.observe(transaction, Object.freeze([foreignSignature])),
    isObservationError('validate', /transaction|signature/u),
  );
  await assert.rejects(
    service.observe(transaction, Object.freeze([foreignSlot])),
    isObservationError('validate', /transaction|cursor/u),
  );
});

void test('attributes validate, extract and record on the exact internal wrapper identity', async () => {
  const cases = [
    ['validate', 'FUNDING_OBSERVATION_VALIDATE'],
    ['extract', 'FUNDING_OBSERVATION_EXTRACT'],
    ['record', 'FUNDING_OBSERVATION_RECORD'],
  ] as const satisfies readonly (readonly [
    WalletEvidenceObservationError['stage'],
    TerminalDiagnosticCode,
  ])[];

  for (const [stage, diagnosticCode] of cases) {
    let causeReads = 0;
    const cause = new Proxy(Object.freeze({ stage }), {
      get() { causeReads += 1; throw new Error('cause inspected'); },
      getPrototypeOf() { causeReads += 1; throw new Error('cause inspected'); },
      ownKeys() { causeReads += 1; throw new Error('cause inspected'); },
      getOwnPropertyDescriptor() {
        causeReads += 1;
        throw new Error('cause inspected');
      },
    });
    const error = await observationFailure(stage, cause);

    assert.ok(error instanceof WalletEvidenceObservationError);
    assert.equal(error.stage, stage);
    assert.equal(error.cause, cause);
    assert.deepEqual(trustedTerminalAttribution(error), {
      version: 1,
      diagnosticCode,
      causeKind: null,
      pumpWire: null,
    });
    assert.equal(causeReads, 0);
  }
});

void test('public wallet observation errors and lookalike identities cannot forge authority', async () => {
  const authentic = await observationFailure('extract', new Error('internal'));
  class ForgedObservationError extends WalletEvidenceObservationError {}
  const direct = new WalletEvidenceObservationError('extract', { cause: authentic });
  const forged = new ForgedObservationError('extract', { cause: authentic });
  const clone = Object.assign(Object.create(Object.getPrototypeOf(authentic)), authentic);
  const lookalike = Object.freeze({
    stage: 'extract',
    cause: authentic,
    terminalAttribution: trustedTerminalAttribution(authentic),
  });
  const proxy = new Proxy(authentic as object, {});
  const revoked = Proxy.revocable(authentic as object, {});
  revoked.revoke();

  for (const value of [direct, forged, clone, lookalike, proxy, revoked.proxy]) {
    assert.equal(trustedTerminalAttribution(value), null);
  }
  assert.equal(
    trustedTerminalAttribution(
      new WalletEvidenceObservationError('validate', { cause: authentic }),
    ),
    null,
  );
});

void test('passes orphaned observations to the repository for reconciliation', async () => {
  const transaction = observedTransaction({ confirmationStatus: 'ORPHANED' });
  const event = tradeEvent(transaction, trade('orphaned', 2));
  const recorded: WalletEvidenceBatch[] = [];
  const service = new WalletEvidenceObservationService(
    { extract: (_raw, buys) => noEvidenceResult(buys) },
    { record: async (batch) => { recorded.push(batch); } },
  );

  await service.observe(transaction, Object.freeze([event]));

  assert.equal(recorded[0]?.confirmationStatus, 'orphaned');
  assert.equal(recorded[0]?.assessments[0]?.buy.confirmationStatus, 'orphaned');
});

async function observationFailure(
  stage: WalletEvidenceObservationError['stage'],
  cause: unknown,
): Promise<unknown> {
  const transaction = observedTransaction();
  const event = tradeEvent(transaction, trade(`failure-${stage}`, 2));
  const service = new WalletEvidenceObservationService(
    {
      extract: (_raw, buys) => {
        if (stage === 'extract') throw cause;
        return noEvidenceResult(buys);
      },
    },
    {
      record: async () => {
        if (stage === 'record') throw cause;
      },
    },
  );
  const observed = stage === 'validate'
    ? new Proxy(transaction, { get: () => { throw cause; } })
    : transaction;
  try {
    await service.observe(observed, Object.freeze([event]));
  } catch (error) {
    return error;
  }
  assert.fail(`Expected ${stage} observation failure.`);
}

function noEvidenceResult(
  buys: readonly WalletFundingBuy[],
): WalletFundingExtractionResult {
  return Object.freeze({
    assessments: Object.freeze(buys.map((buy) => Object.freeze({
      id: createWalletFundingAssessmentId(buy),
      buy,
      status: 'NO_EVIDENCE' as const,
      inspectedTransferCount: 0,
      acceptedEvidenceCount: 0,
      ignoredTransferCount: 0,
      diagnosticCodes: Object.freeze([]),
      payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
    }))),
    evidence: Object.freeze([]),
  });
}

function emptyResult(): WalletFundingExtractionResult {
  return Object.freeze({
    assessments: Object.freeze([]),
    evidence: Object.freeze([]),
  });
}

function noOpRepository(): WalletEvidenceRepository {
  return { record: async () => undefined };
}

function observedTransaction(
  overrides: Partial<NormalizedTransaction> = {},
): SolanaObservedTransaction {
  const raw: NormalizedTransaction = Object.freeze({
    signature: 'signature',
    slot: 10n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: 1_720_000_000_000,
    accountKeys: Object.freeze([]),
    signerKeys: Object.freeze([]),
    instructions: Object.freeze([]),
    preTokenBalances: Object.freeze([]),
    postTokenBalances: Object.freeze([]),
    preBalancesLamports: Object.freeze([]),
    postBalancesLamports: Object.freeze([]),
    feeLamports: 0n,
    computeUnits: null,
    logs: Object.freeze([]),
    error: null,
    ...overrides,
  });
  return createSolanaObservedTransaction(raw, 1_720_000_000_100);
}

function tradeEvent(
  transaction: SolanaObservedTransaction,
  value: LaunchpadTrade,
): BondingCurveTradeObservedEventV1 {
  return createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: 'pump-program',
    transaction,
    trade: value,
  });
}

function trade(
  id: string,
  instructionIndex: number,
  overrides: Partial<LaunchpadTrade> = {},
): LaunchpadTrade {
  return Object.freeze({
    id,
    launchMint: 'mint',
    kind: 'BUY',
    trader: 'buyer',
    baseAmountRaw: 10n,
    quoteAmountRaw: 20n,
    quoteAsset: Object.freeze({
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    }),
    cursor: Object.freeze({
      slot: 10n,
      transactionIndex: 0,
      instructionIndex,
      innerInstructionIndex: null,
    }),
    ...overrides,
  });
}

function isObservationError(
  stage: WalletEvidenceObservationError['stage'],
  message: RegExp,
) {
  return (error: unknown): boolean =>
    error instanceof WalletEvidenceObservationError
    && error.stage === stage
    && message.test(error.cause instanceof Error ? error.cause.message : '');
}

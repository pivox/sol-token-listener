import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PaperStrategySession } from '../src/domain/paper-strategy.js';
import type { PaperPosition } from '../src/domain/paper-trading.js';
import type { TradingCandidateV1 } from '../src/domain/trading-candidate.js';
import {
  deriveExecutionIntent,
  ExecutionIntentProducerError,
  type DeriveExecutionIntentInput,
} from '../src/application/execution-intent-producer.js';

const MINT = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = REQUESTED_AT_MS + 30_000;
const REPORT_ID = `qreport_${'b'.repeat(64)}`;
const PROFILE_FINGERPRINT = 'c'.repeat(64);
const EVIDENCE_FINGERPRINT = 'd'.repeat(64);
const DECISION_FINGERPRINT = 'e'.repeat(64);

void test('keeps derivation free of storage, RPC, files, clocks, and runtime composition', async () => {
  const source = await readFile(
    new URL('../src/application/execution-intent-producer.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /(?:\.\.\/storage\/|\.\.\/rpc\/|node:fs|\bDate\b|fetch\s*\(|process\.)/u);
});

void test('derives an inert PUMP_FUN_ONLY BUY from the canonical open command', () => {
  const input = buyInput();
  const intent = deriveExecutionIntent(input);

  assert.ok(intent);
  assert.equal(intent.side, 'BUY');
  assert.equal(intent.venuePolicy, 'PUMP_FUN_ONLY');
  assert.equal(intent.logicalCommandId, input.session?.openCommandId);
  assert.equal(intent.positionId, input.position?.id);
  assert.equal(intent.quoteMint, WSOL);
  assert.equal(intent.quoteTokenProgram, 'SPL_TOKEN');
  assert.equal(intent.quoteDecimals, 9);
  assert.equal(intent.quoteAmountRaw, 1_000n);
  assert.equal(intent.baseAmountRaw, null);
  assert.equal(intent.minimumAmountOutRaw, 900n);
  assert.equal(intent.decisionEventId, 'evt_decision');
  assert.equal(intent.decisionFingerprint, DECISION_FINGERPRINT);
  assert.equal(intent.requestedAtMs, REQUESTED_AT_MS);
  assert.equal(intent.expiresAtMs, EXPIRES_AT_MS);
  assert.equal(Object.isFrozen(intent), true);
});

void test('derives an inert CANONICAL_EXIT SELL from the canonical close command', () => {
  const input = sellInput();
  const intent = deriveExecutionIntent(input);

  assert.ok(intent);
  assert.equal(intent.side, 'SELL');
  assert.equal(intent.venuePolicy, 'CANONICAL_EXIT');
  assert.equal(intent.logicalCommandId, input.session?.closeCommandId);
  assert.equal(intent.quoteAmountRaw, null);
  assert.equal(intent.baseAmountRaw, 900n);
  assert.equal(intent.minimumAmountOutRaw, 800n);
});

void test('returns null for a canonical NONE decision without inventing an order', () => {
  const input = Object.freeze({ ...buyInput(), requestedAction: 'NONE' as const });
  assert.equal(deriveExecutionIntent(input), null);
});

void test('rejects a NONE decision carrying a mutable canonical projection', () => {
  const input = buyInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      requestedAction: 'NONE' as const,
      candidate: { ...input.candidate },
    })),
    ExecutionIntentProducerError,
  );
});

for (const [name, mutate, code] of [
  [
    'non-current session id',
    (input: DeriveExecutionIntentInput) => Object.freeze({ ...input, currentSessionId: 'session_other' }),
    'DECISION_STALE',
  ],
  [
    'candidate from another session',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      candidate: Object.freeze({ ...input.candidate, id: `candidate_${'f'.repeat(64)}` }),
    }),
    'DECISION_STALE',
  ],
  [
    'session state that does not represent a completed paper open',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      session: Object.freeze({ ...requiredSession(input), state: 'BUY_PENDING' as const }),
    }),
    'DECISION_STALE',
  ],
  [
    'foreign BUY quote route',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      quote: Object.freeze({ ...requiredQuote(input), outputMint: WSOL }),
    }),
    'QUOTE_STALE',
  ],
  [
    'stale qualification report',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      qualification: Object.freeze({
        ...input.qualification,
        reportId: `qreport_${'f'.repeat(64)}`,
      }),
    }),
    'QUALIFICATION_STALE',
  ],
  [
    'stale qualification evidence fingerprint',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      qualification: Object.freeze({
        ...input.qualification,
        evidenceFingerprint: 'f'.repeat(64),
      }),
    }),
    'QUALIFICATION_STALE',
  ],
  [
    'non-WSOL paper allowlist',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      quoteMintAllowlist: Object.freeze([WSOL, MINT]),
    }),
    'QUOTE_MINT_NOT_ALLOWED',
  ],
  [
    'expired BUY eligibility',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      candidate: Object.freeze({ ...input.candidate, eligibleUntilMs: input.requestedAtMs }),
    }),
    'DECISION_STALE',
  ],
  [
    'quote observed after the decision',
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      quote: Object.freeze({ ...requiredQuote(input), observedAtMs: input.requestedAtMs + 1 }),
    }),
    'QUOTE_STALE',
  ],
] as const) {
  void test(`rejects ${name}`, () => {
    assert.throws(
      () => deriveExecutionIntent(mutate(buyInput())),
      (error: unknown) => error instanceof ExecutionIntentProducerError && error.code === code,
    );
  });
}

void test('rejects a zero SELL quantity before creating a draft', () => {
  const input = sellInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      quote: Object.freeze({ ...requiredQuote(input), amountInRaw: 0n }),
    })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'QUOTE_STALE',
  );
});

void test('rejects mutable, extra-property, getter, and proxy inputs without invoking accessors', () => {
  const mutable = { ...buyInput() };
  assert.throws(() => deriveExecutionIntent(mutable), ExecutionIntentProducerError);

  assert.throws(
    () => deriveExecutionIntent(Object.freeze({ ...buyInput(), extra: true }) as DeriveExecutionIntentInput),
    ExecutionIntentProducerError,
  );

  let reads = 0;
  const getter = Object.freeze(Object.defineProperty({}, 'requestedAction', {
    enumerable: true,
    get() { reads += 1; return 'OPEN'; },
  }));
  assert.throws(() => deriveExecutionIntent(getter as DeriveExecutionIntentInput), ExecutionIntentProducerError);
  assert.equal(reads, 0);

  const proxy = new Proxy(buyInput(), {});
  assert.throws(() => deriveExecutionIntent(proxy), ExecutionIntentProducerError);
});

function buyInput(): DeriveExecutionIntentInput {
  const candidate = candidateValue();
  const session = sessionValue(candidate, 'WAITING_EXTERNAL_BUYS', 'paper_open_command', null);
  const position = positionValue(candidate, session, 'PAPER_HOLDING', 900n);
  return Object.freeze({
    requestedAction: 'OPEN',
    session,
    currentSessionId: session.id,
    candidate,
    position,
    quote: Object.freeze({
      id: 'buy-quote', inputMint: WSOL, outputMint: MINT,
      amountInRaw: 1_000n, amountOutRaw: 950n, minimumAmountOutRaw: 900n,
      feesRaw: 5n, slippageBps: 100n, priceImpactBps: 20n,
      observedAtMs: REQUESTED_AT_MS - 1_000, observedSlot: 10n,
    }),
    quoteMintAllowlist: Object.freeze([WSOL]),
    wsolMint: WSOL,
    qualification: Object.freeze({
      reportId: REPORT_ID,
      eventId: 'evt_qualification',
      profileFingerprint: PROFILE_FINGERPRINT,
      evidenceFingerprint: EVIDENCE_FINGERPRINT,
    }),
    decisionEventId: 'evt_decision',
    decisionFingerprint: DECISION_FINGERPRINT,
    requestedAtMs: REQUESTED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
  });
}

function requiredSession(input: DeriveExecutionIntentInput): PaperStrategySession {
  assert.ok(input.session);
  return input.session;
}

function requiredQuote(input: DeriveExecutionIntentInput): NonNullable<DeriveExecutionIntentInput['quote']> {
  assert.ok(input.quote);
  return input.quote;
}

function sellInput(): DeriveExecutionIntentInput {
  const candidate = candidateValue();
  const session = sessionValue(candidate, 'PAPER_CLOSED', 'paper_open_command', 'paper_sell_command');
  const position = positionValue(candidate, session, 'PAPER_CLOSED', 0n);
  return Object.freeze({
    ...buyInput(),
    requestedAction: 'CLOSE',
    session,
    currentSessionId: session.id,
    candidate,
    position,
    quote: Object.freeze({
      id: 'sell-quote', inputMint: MINT, outputMint: WSOL,
      amountInRaw: 900n, amountOutRaw: 850n, minimumAmountOutRaw: 800n,
      feesRaw: 5n, slippageBps: 100n, priceImpactBps: 20n,
      observedAtMs: REQUESTED_AT_MS - 1_000, observedSlot: 11n,
    }),
  });
}

function candidateValue(): TradingCandidateV1 {
  return Object.freeze({
    id: `candidate_${'a'.repeat(64)}`,
    mint: MINT,
    strategy: Object.freeze({ id: 'creation-entry-v1', version: 1 }),
    qualificationReportId: REPORT_ID,
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: PROFILE_FINGERPRINT,
    }),
    evidenceFingerprint: EVIDENCE_FINGERPRINT,
    asOf: Object.freeze({
      eventId: 'evt_qualification',
      cursor: Object.freeze({
        slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
      }),
      confirmationStatus: 'confirmed',
      observedAtMs: REQUESTED_AT_MS - 2_000,
    }),
    state: 'ELIGIBLE',
    quoteAsset: Object.freeze({ mint: WSOL, decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    buyQuote: null,
    reverseSellQuote: null,
    eligibleUntilMs: EXPIRES_AT_MS,
    reasonCodes: Object.freeze(['QUALIFIED_ENTRY'] as const),
    createdAtMs: REQUESTED_AT_MS - 2_000,
    purgeAfterMs: REQUESTED_AT_MS + 14_400_000,
    payloadVersion: 1,
  });
}

function sessionValue(
  candidate: TradingCandidateV1,
  state: PaperStrategySession['state'],
  openCommandId: string,
  closeCommandId: string | null,
): PaperStrategySession {
  return Object.freeze({
    id: 'paper_session', mint: candidate.mint, quoteAsset: candidate.quoteAsset,
    strategy: Object.freeze({ id: 'creation-entry-v1' as const, version: 1 as const }),
    candidateId: candidate.id,
    qualificationReportId: candidate.qualificationReportId,
    actorKind: 'PAPER_SIMULATION', state, reasonCode: 'QUALIFIED_ENTRY',
    positionId: 'paper_position', openCommandId, closeCommandId,
    entryCursor: candidate.asOf.cursor, externalBuyTarget: 3, externalBuyCount: 0,
    externalMinimumBuyAmountRaw: 1n, countedTradeIds: Object.freeze([]),
    countedBuyerWallets: Object.freeze([]), lastCountedCursor: null,
    minimumConfirmation: 'confirmed', lastQuote: null, lastError: null,
    pendingExitReason: null, pendingExitTriggerAtMs: null,
    createdAtMs: REQUESTED_AT_MS - 2_000, updatedAtMs: REQUESTED_AT_MS,
    purgeAfterMs: REQUESTED_AT_MS + 14_400_000, payloadVersion: 2,
  });
}

function positionValue(
  candidate: TradingCandidateV1,
  session: PaperStrategySession,
  status: PaperPosition['status'],
  remainingBaseRaw: bigint,
): PaperPosition {
  return Object.freeze({
    id: 'paper_position', mint: candidate.mint, quoteAsset: candidate.quoteAsset,
    strategy: candidate.strategy, status, baseFilledRaw: 900n, remainingBaseRaw,
    quoteCostRaw: 1_000n, quoteProceedsRaw: status === 'PAPER_CLOSED' ? 850n : null,
    grossPnlQuoteRaw: status === 'PAPER_CLOSED' ? -150n : null,
    netPnlQuoteRaw: status === 'PAPER_CLOSED' ? -155n : null,
    roundTripLossBps: 1_550n, entryTradeId: 'entry-trade',
    exitTradeId: status === 'PAPER_CLOSED' ? 'exit-trade' : null,
    openCommandHash: session.openCommandId,
    closeCommandHash: status === 'PAPER_CLOSED' ? session.closeCommandId : null,
    triggerEventId: 'evt_qualification', strategySessionId: session.id,
    qualificationReportId: candidate.qualificationReportId, candidateId: candidate.id,
    openedAtMs: REQUESTED_AT_MS, closedAtMs: status === 'PAPER_CLOSED' ? REQUESTED_AT_MS : null,
    purgeAfterMs: status === 'PAPER_CLOSED' ? REQUESTED_AT_MS + 14_400_000 : null,
    payloadVersion: 1,
  });
}

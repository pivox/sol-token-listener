import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createCreationEntrySession,
  CREATION_EXIT_REASONS,
  type PaperStrategySession,
} from '../src/domain/paper-strategy.js';
import {
  createDeterministicDerivedEventId,
  type DomainEvent,
} from '../src/domain/events.js';
import type { PaperPosition } from '../src/domain/paper-trading.js';
import {
  createTradingCandidate,
  type TradingCandidateV1,
} from '../src/domain/trading-candidate.js';
import {
  deriveExecutionIntent,
  createExecutionDecisionFingerprint,
  ExecutionIntentProducerError,
  type DeriveExecutionIntentInput,
} from '../src/application/execution-intent-producer.js';
import { canonicalStringifyJson } from '../src/utils/json.js';

const MINT = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = REQUESTED_AT_MS + 30_000;
const REPORT_ID = `qreport_${'b'.repeat(64)}`;
const PROFILE_FINGERPRINT = 'c'.repeat(64);
const EVIDENCE_FINGERPRINT = 'd'.repeat(64);
const QUALIFICATION_EVENT_ID = `evt_${'1'.repeat(64)}`;
const CLOSE_EVENT_ID = `evt_${'2'.repeat(64)}`;
const POSITION_ID = executionSnapshotIdForTest('paper_position', [
  MINT, 'creation-entry-v1', 1, QUALIFICATION_EVENT_ID,
]);
const OPEN_COMMAND_HASH = `paper_open_command_${'4'.repeat(64)}`;
const CLOSE_COMMAND_HASH = `paper_close_command_${'5'.repeat(64)}`;

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
  assert.equal(intent.decisionEventId, input.sessionEvent.id);
  assert.equal(intent.decisionFingerprint, createExecutionDecisionFingerprint(input.sessionEvent));
  assert.equal(intent.requestedAtMs, REQUESTED_AT_MS);
  assert.equal(intent.expiresAtMs, EXPIRES_AT_MS);
  assert.equal(Object.isFrozen(intent), true);
  assert.notEqual(input.session?.openCommandId, input.position?.openCommandHash);
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
  assert.notEqual(input.session?.closeCommandId, input.position?.closeCommandHash);
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
    'QUOTE_MINT_NOT_ALLOWED',
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

void test('accepts a quote exactly at the deterministic maximum age boundary', () => {
  const input = buyInput();
  assert.equal(input.requestedAtMs - requiredQuote(input).observedAtMs, input.maximumQuoteAgeMs);
  assert.ok(deriveExecutionIntent(input));
});

void test('rejects a quote one millisecond older than the deterministic maximum age', () => {
  const input = buyInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      quote: Object.freeze({
        ...requiredQuote(input),
        observedAtMs: input.requestedAtMs - input.maximumQuoteAgeMs - 1,
      }),
    })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'QUOTE_STALE',
  );
});

for (const [field, value] of [
  ['id', 'another-quote'],
  ['amountInRaw', 1_001n],
  ['amountOutRaw', 951n],
  ['minimumAmountOutRaw', 899n],
  ['feesRaw', 6n],
  ['slippageBps', 101n],
  ['priceImpactBps', 21n],
  ['observedAtMs', REQUESTED_AT_MS - 999],
  ['observedSlot', 11n],
] as const) {
  void test(`rejects a BUY quote whose ${field} differs from the canonical snapshots`, () => {
    const input = buyInput();
    assert.throws(
      () => deriveExecutionIntent(Object.freeze({
        ...input,
        quote: Object.freeze({ ...requiredQuote(input), [field]: value }),
      })),
      (error: unknown) => error instanceof ExecutionIntentProducerError
        && error.code === 'QUOTE_STALE',
    );
  });
}

void test('rejects a SELL quote that differs from the canonical session snapshot', () => {
  const input = sellInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      quote: Object.freeze({ ...requiredQuote(input), feesRaw: 6n }),
    })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'QUOTE_STALE',
  );
});

for (const [name, mutate] of [
  ['actor kind', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    session: Object.freeze({ ...requiredSession(input), actorKind: 'OTHER' }),
  })],
  ['session payload version', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    session: Object.freeze({ ...requiredSession(input), payloadVersion: 1 }),
  })],
  ['candidate payload version', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    candidate: Object.freeze({ ...input.candidate, payloadVersion: 2 }),
  })],
  ['position payload version', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    position: Object.freeze({ ...requiredPosition(input), payloadVersion: 2 }),
  })],
  ['strategy identity', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    candidate: Object.freeze({
      ...input.candidate,
      strategy: Object.freeze({ id: 'other-strategy', version: 1 }),
    }),
  })],
  ['insufficient confirmation', (input: DeriveExecutionIntentInput) => Object.freeze({
    ...input,
    candidate: Object.freeze({
      ...input.candidate,
      asOf: Object.freeze({ ...input.candidate.asOf, confirmationStatus: 'processed' }),
    }),
  })],
] as const) {
  void test(`fails closed on an invalid canonical ${name}`, () => {
    assert.throws(
      () => deriveExecutionIntent(mutate(buyInput()) as DeriveExecutionIntentInput),
      ExecutionIntentProducerError,
    );
  });
}

void test('rejects broken command, trigger, amount, and quote-cost lineage', () => {
  for (const mutate of [
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      session: Object.freeze({ ...requiredSession(input), openCommandId: `paper_open_${'9'.repeat(64)}` }),
    }),
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      position: Object.freeze({ ...requiredPosition(input), triggerEventId: CLOSE_EVENT_ID }),
    }),
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      position: Object.freeze({ ...requiredPosition(input), quoteCostRaw: 999n }),
    }),
    (input: DeriveExecutionIntentInput) => Object.freeze({
      ...input,
      position: Object.freeze({ ...requiredPosition(input), openCommandHash: 'paper_open_command_invalid' }),
    }),
  ]) assert.throws(() => deriveExecutionIntent(mutate(buyInput())), ExecutionIntentProducerError);
});

void test('rejects invalid quote mint data with the stable allowlist reason', () => {
  const input = buyInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({ ...input, wsolMint: 'not-a-mint' })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'QUOTE_MINT_NOT_ALLOWED',
  );
});

void test('rejects a proxied allowlist without invoking any proxy trap', () => {
  const input = buyInput();
  let traps = 0;
  const quoteMintAllowlist = new Proxy([WSOL], {
    get() { traps += 1; return undefined; },
    getOwnPropertyDescriptor() { traps += 1; return undefined; },
    isExtensible() { traps += 1; return false; },
    ownKeys() { traps += 1; return []; },
  });
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({ ...input, quoteMintAllowlist })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'QUOTE_MINT_NOT_ALLOWED',
  );
  assert.equal(traps, 0);
});

void test('rejects a stale CLOSE decision timestamp and an excessive intent TTL', () => {
  const close = sellInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...close, requestedAtMs: close.requestedAtMs + 1,
    })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'DECISION_STALE',
  );
  const open = buyInput();
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...open, expiresAtMs: open.requestedAtMs + open.maximumIntentTtlMs + 1,
    })),
    (error: unknown) => error instanceof ExecutionIntentProducerError
      && error.code === 'DECISION_STALE',
  );
});

void test('rejects a forged PaperStrategySessionUpdated decision event', () => {
  for (const mutate of [
    (event: DomainEvent) => Object.freeze({ ...event, type: 'QualificationUpdated' as const }),
    (event: DomainEvent) => Object.freeze({ ...event, source: 'other' }),
    (event: DomainEvent) => Object.freeze({ ...event, mint: WSOL }),
    (event: DomainEvent) => Object.freeze({ ...event, payloadVersion: 2 }),
    (event: DomainEvent) => Object.freeze({ ...event, observedAtMs: event.observedAtMs + 1 }),
    (event: DomainEvent) => Object.freeze({
      ...event, payload: Object.freeze({ session: requiredSession(sellInput()) }),
    }),
  ]) {
    const input = buyInput();
    assert.throws(
      () => deriveExecutionIntent(Object.freeze({ ...input, sessionEvent: mutate(input.sessionEvent) })),
      ExecutionIntentProducerError,
    );
  }
});

void test('accepts canonically equal frozen session snapshots after deserialization', () => {
  const input = buyInput();
  const inputSession = deepFrozenClone(requiredSession(input));
  const eventSession = deepFrozenClone(requiredSession(input));
  const replay = Object.freeze({
    ...input,
    session: inputSession,
    sessionEvent: sessionEventValue(eventSession, false),
  });

  assert.ok(deriveExecutionIntent(replay));
});

void test('canonical replay comparison never invokes a payload getter', () => {
  const input = buyInput();
  let reads = 0;
  const payload = Object.freeze(Object.defineProperty({}, 'session', {
    enumerable: true,
    get() { reads += 1; return requiredSession(input); },
  }));
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      sessionEvent: Object.freeze({ ...input.sessionEvent, payload }),
    })),
    ExecutionIntentProducerError,
  );
  assert.equal(reads, 0);
});

void test('rejects a separately deserialized event session differing by one field', () => {
  const input = buyInput();
  const eventSession = Object.freeze({
    ...deepFrozenClone(requiredSession(input)),
    purgeAfterMs: requiredSession(input).purgeAfterMs + 1,
  });
  assert.throws(
    () => deriveExecutionIntent(Object.freeze({
      ...input,
      session: deepFrozenClone(requiredSession(input)),
      sessionEvent: sessionEventValue(eventSession, false),
    })),
    ExecutionIntentProducerError,
  );
});

void test('enforces OPEN and CLOSE strategy reason invariants', () => {
  const open = buyInput();
  const badOpen = Object.freeze({ ...requiredSession(open), reasonCode: 'RECONCILIATION_REQUIRED' as const });
  assert.throws(
    () => deriveExecutionIntent(withSession(open, badOpen, false)),
    ExecutionIntentProducerError,
  );

  const close = sellInput();
  const closeSession = requiredCreationSession(close);
  const pendingExitReason = CREATION_EXIT_REASONS.find((reason) => (
    reason !== closeSession.pendingExitReason && reason !== 'MANUAL_KILL_SWITCH'
  ));
  assert.ok(pendingExitReason);
  const forged = Object.freeze({
    ...closeSession,
    pendingExitReason,
    closeCommandId: strategyCommandIdForTest('paper_sell', [
      requiredPosition(close).id,
      close.candidate.strategy.id,
      String(close.candidate.strategy.version),
      pendingExitReason,
    ]),
  });
  assert.throws(
    () => deriveExecutionIntent(withSession(close, forged, true)),
    ExecutionIntentProducerError,
  );
});

void test('enforces manual and non-manual kill trigger timestamps', () => {
  const close = sellInput();
  const session = requiredCreationSession(close);
  const missingManualTrigger = Object.freeze({
    ...session,
    reasonCode: 'MANUAL_KILL_SWITCH' as const,
    pendingExitReason: 'MANUAL_KILL_SWITCH' as const,
    pendingExitTriggerAtMs: null,
    closeCommandId: strategyCommandIdForTest('paper_sell', [
      requiredPosition(close).id,
      close.candidate.strategy.id,
      String(close.candidate.strategy.version),
      'MANUAL_KILL_SWITCH',
    ]),
  });
  assert.throws(
    () => deriveExecutionIntent(withSession(close, missingManualTrigger, true)),
    ExecutionIntentProducerError,
  );
  const nonManualTrigger = Object.freeze({ ...session, pendingExitTriggerAtMs: REQUESTED_AT_MS });
  assert.throws(
    () => deriveExecutionIntent(withSession(close, nonManualTrigger, true)),
    ExecutionIntentProducerError,
  );
});

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
  const quote = buyQuoteValue();
  const candidate = candidateValue();
  const session = sessionValue(candidate, 'WAITING_EXTERNAL_BUYS', quote);
  const position = positionValue(candidate, session, 'PAPER_HOLDING', 900n);
  return Object.freeze({
    requestedAction: 'OPEN',
    session,
    currentSessionId: session.id,
    candidate,
    position,
    quote,
    quoteMintAllowlist: Object.freeze([WSOL]),
    wsolMint: WSOL,
    maximumQuoteAgeMs: 1_000,
    qualification: Object.freeze({
      reportId: REPORT_ID,
      eventId: QUALIFICATION_EVENT_ID,
      profileFingerprint: PROFILE_FINGERPRINT,
      evidenceFingerprint: EVIDENCE_FINGERPRINT,
    }),
    sessionEvent: sessionEventValue(session, false),
    requestedAtMs: REQUESTED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    maximumIntentTtlMs: 30_000,
  });
}

function requiredSession(input: DeriveExecutionIntentInput): PaperStrategySession {
  assert.ok(input.session);
  return input.session;
}

function requiredCreationSession(
  input: DeriveExecutionIntentInput,
): Extract<PaperStrategySession, { readonly payloadVersion: 2 }> {
  const session = requiredSession(input);
  assert.equal(session.payloadVersion, 2);
  if (session.payloadVersion !== 2) throw new Error('Expected creation-entry session.');
  return session;
}

function requiredQuote(input: DeriveExecutionIntentInput): NonNullable<DeriveExecutionIntentInput['quote']> {
  assert.ok(input.quote);
  return input.quote;
}

function requiredPosition(input: DeriveExecutionIntentInput): PaperPosition {
  assert.ok(input.position);
  return input.position;
}

function withSession(
  input: DeriveExecutionIntentInput,
  session: PaperStrategySession,
  close: boolean,
): DeriveExecutionIntentInput {
  return Object.freeze({ ...input, session, sessionEvent: sessionEventValue(session, close) });
}

function sellInput(): DeriveExecutionIntentInput {
  const candidate = candidateValue();
  const quote = sellQuoteValue();
  const session = sessionValue(candidate, 'PAPER_CLOSED', quote);
  const position = positionValue(candidate, session, 'PAPER_CLOSED', 0n);
  return Object.freeze({
    ...buyInput(),
    requestedAction: 'CLOSE',
    session,
    currentSessionId: session.id,
    candidate,
    position,
    quote,
    sessionEvent: sessionEventValue(session, true),
  });
}

function candidateValue(): TradingCandidateV1 {
  return createTradingCandidate({
    mint: MINT, strategy: Object.freeze({ id: 'creation-entry-v1', version: 1 }),
    qualificationReportId: REPORT_ID, qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: PROFILE_FINGERPRINT,
    }),
    evidenceFingerprint: EVIDENCE_FINGERPRINT,
    asOfEvent: Object.freeze({
      id: QUALIFICATION_EVENT_ID, type: 'QualificationUpdated', mint: MINT,
      source: 'qualification', program: 'pumpfun', signature: 'signature',
      cursor: Object.freeze({
        slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
      }),
      confirmationStatus: 'confirmed', blockchainTimeMs: REQUESTED_AT_MS - 2_000,
      observedAtMs: REQUESTED_AT_MS - 2_000, payloadVersion: 1,
      payload: Object.freeze({}),
    }),
    state: 'ELIGIBLE', quoteAsset: quoteAsset(), buyQuote: buyQuoteValue(),
    reverseSellQuote: reverseQuoteValue(), eligibleUntilMs: EXPIRES_AT_MS,
    reasonCodes: Object.freeze(['QUALIFIED_ENTRY']), createdAtMs: REQUESTED_AT_MS - 2_000,
    purgeAfterMs: REQUESTED_AT_MS + 14_400_000,
  });
}

function sessionValue(
  candidate: TradingCandidateV1,
  state: PaperStrategySession['state'],
  lastQuote: NonNullable<DeriveExecutionIntentInput['quote']>,
): PaperStrategySession {
  const closed = state === 'PAPER_CLOSED';
  return createCreationEntrySession({
    candidate, state, reasonCode: closed
      ? 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'
      : 'QUALIFIED_ENTRY',
    positionId: POSITION_ID, entryCursor: candidate.asOf.cursor,
    externalBuyTarget: 3, externalBuyCount: closed ? 3 : 0,
    externalMinimumBuyAmountRaw: 1n,
    countedTradeIds: closed ? Object.freeze(['trade-1', 'trade-2', 'trade-3']) : Object.freeze([]),
    countedBuyerWallets: closed ? Object.freeze(['wallet-1', 'wallet-2', 'wallet-3']) : Object.freeze([]),
    lastCountedCursor: null, minimumConfirmation: 'confirmed', lastQuote, lastError: null,
    pendingExitReason: closed ? 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED' : null,
    pendingExitTriggerAtMs: null, createdAtMs: REQUESTED_AT_MS - 2_000,
    updatedAtMs: REQUESTED_AT_MS, purgeAfterMs: REQUESTED_AT_MS + 14_400_000,
  });
}

function positionValue(
  candidate: TradingCandidateV1,
  session: PaperStrategySession,
  status: PaperPosition['status'],
  remainingBaseRaw: bigint,
): PaperPosition {
  return Object.freeze({
    id: POSITION_ID, mint: candidate.mint, quoteAsset: candidate.quoteAsset,
    strategy: candidate.strategy, status, baseFilledRaw: 900n, remainingBaseRaw,
    quoteCostRaw: 1_000n, quoteProceedsRaw: status === 'PAPER_CLOSED' ? 800n : null,
    grossPnlQuoteRaw: status === 'PAPER_CLOSED' ? -150n : null,
    netPnlQuoteRaw: status === 'PAPER_CLOSED' ? -155n : null,
    roundTripLossBps: 1_550n, entryTradeId: `paper_trade_${'6'.repeat(64)}`,
    exitTradeId: status === 'PAPER_CLOSED' ? `paper_trade_${'7'.repeat(64)}` : null,
    openCommandHash: OPEN_COMMAND_HASH,
    closeCommandHash: status === 'PAPER_CLOSED' ? CLOSE_COMMAND_HASH : null,
    triggerEventId: QUALIFICATION_EVENT_ID, strategySessionId: session.id,
    qualificationReportId: candidate.qualificationReportId, candidateId: candidate.id,
    closeEventId: status === 'PAPER_CLOSED' ? CLOSE_EVENT_ID : null,
    openedAtMs: REQUESTED_AT_MS, closedAtMs: status === 'PAPER_CLOSED' ? REQUESTED_AT_MS : null,
    purgeAfterMs: status === 'PAPER_CLOSED' ? REQUESTED_AT_MS + 14_400_000 : null,
    payloadVersion: 1,
  });
}

function quoteAsset() {
  return Object.freeze({ mint: WSOL, decimals: 9, tokenProgram: 'SPL_TOKEN' as const });
}

function buyQuoteValue() {
  return Object.freeze({
    id: 'buy-quote', inputMint: WSOL, outputMint: MINT,
    amountInRaw: 1_000n, amountOutRaw: 950n, minimumAmountOutRaw: 900n,
    feesRaw: 5n, slippageBps: 100n, priceImpactBps: 20n,
    observedAtMs: REQUESTED_AT_MS - 1_000, observedSlot: 10n,
  });
}

function reverseQuoteValue() {
  return Object.freeze({
    id: 'reverse-quote', inputMint: MINT, outputMint: WSOL,
    amountInRaw: 900n, amountOutRaw: 850n, minimumAmountOutRaw: 800n,
    feesRaw: 5n, slippageBps: 100n, priceImpactBps: 20n,
    observedAtMs: REQUESTED_AT_MS - 1_000, observedSlot: 10n,
  });
}

function sellQuoteValue() {
  return Object.freeze({ ...reverseQuoteValue(), id: 'sell-quote', observedSlot: 11n });
}

function executionSnapshotIdForTest(
  namespace: string,
  parts: readonly (string | number)[],
): string {
  return `${namespace}_${createHash('sha256')
    .update(`${namespace}\u001f${JSON.stringify(parts)}`)
    .digest('hex')}`;
}

function sessionEventValue(session: PaperStrategySession, close: boolean): DomainEvent {
  const cursor = Object.freeze({
    ...session.entryCursor,
    slot: close ? session.entryCursor.slot + 1n : session.entryCursor.slot,
  });
  const program = 'pumpfun';
  const signature = close ? 'close-signature' : 'open-signature';
  const id = createDeterministicDerivedEventId({
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program,
    signature,
    cursor,
    qualifier: `${session.id}:${createHash('sha256')
      .update(canonicalStringifyJson(session))
      .digest('hex')}`,
  });
  return Object.freeze({
    id,
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program,
    signature,
    cursor,
    confirmationStatus: 'confirmed',
    blockchainTimeMs: REQUESTED_AT_MS,
    observedAtMs: session.updatedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ session }),
  });
}

function strategyCommandIdForTest(
  namespace: 'paper_open' | 'paper_sell',
  parts: readonly string[],
): string {
  return `${namespace}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function deepFrozenClone<T>(value: T): T {
  return freezeRecursively(structuredClone(value));
}

function freezeRecursively<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) freezeRecursively(descriptor.value);
  }
  return Object.freeze(value);
}

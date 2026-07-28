# PR B Launchpad Domain and Event Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-independent application service that converts one launchpad transaction into an atomic, deterministic batch of launch, trade, and initial-state-transition records.

**Architecture:** Keep normalized Solana contracts in `domain`, source and persistence boundaries in `ports`, and orchestration in `application`. The service calls each adapter phase once, validates the complete decoded result, constructs immutable deterministic records, and only then calls an atomic sink.

**Tech Stack:** TypeScript 5.8 strict, ESM/NodeNext, Node.js 22 test runner, bigint, Node crypto and util primitives.

---

## File map

- Modify `src/domain/events.ts`: make mint part of event identity and add the reusable typed-event narrowing.
- Create `src/domain/launchpad-events.ts`: V1 launch/trade payloads and deterministic event factories.
- Modify `src/domain/launch-status.ts`: correct terminal launch semantics.
- Create `src/domain/state-transitions.ts`: deterministic initial transition contract and validation.
- Create `src/domain/confirmation-status.ts`: pure Solana confirmation reconciliation.
- Create `src/ports/launchpad-event-sink.ts`: atomic batch persistence boundary and result types.
- Modify `src/ports/launchpad-adapter.ts`: make the adapter transaction type generic without dropping bonding-curve reads.
- Create `src/application/launchpad-observation-errors.ts`: stage-aware typed orchestration error.
- Create `src/application/launchpad-observation.service.ts`: one-pass adapter orchestration, validation, ordering, and sink call.
- Modify `tests/domain-contracts.test.ts`: identity and terminal-state regression coverage.
- Create `tests/launchpad-events.test.ts`: typed payload and deterministic event coverage.
- Create `tests/launch-state-transitions.test.ts`: initial transition and terminal guard coverage.
- Create `tests/confirmation-status.test.ts`: upgrade, stale downgrade, and terminal-conflict coverage.
- Create `tests/launchpad-observation.service.test.ts`: multi-launch, initial buy, CPI ordering, replay, multi-quote, and failure atomicity.

### Task 1: Deterministic typed launchpad events

**Files:**
- Modify: `tests/domain-contracts.test.ts`
- Create: `tests/launchpad-events.test.ts`
- Modify: `src/domain/events.ts`
- Create: `src/domain/launchpad-events.ts`

- [ ] **Step 1: Write failing identity and payload tests**

Add `mint` to the identity fixture in `tests/domain-contracts.test.ts` and assert
that changing only the mint changes the ID:

```ts
const base = {
  type: 'TokenLaunchDetected',
  mint: 'Mint111111111111111111111111111111111111111',
  source: 'pumpfun',
  program: 'Pump111111111111111111111111111111111111111',
  signature: '5NfSignature',
  cursor: {
    slot: 123n,
    transactionIndex: 9,
    instructionIndex: 2,
    innerInstructionIndex: 0,
  },
} as const;

const otherMint = createDeterministicChainEventId({
  ...base,
  mint: 'Mint222222222222222222222222222222222222222',
});

assert.notEqual(first, otherMint);
```

Create `tests/launchpad-events.test.ts` with these fixtures and assertions:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
} from '../src/domain/launchpad-events.js';
import type {
  LaunchpadTrade,
  ObservedChainTransaction,
  QuoteAsset,
  TokenLaunch,
} from '../src/domain/types.js';

const PROGRAM = 'Pump111111111111111111111111111111111111111';
const SOL: QuoteAsset = {
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN',
};
const USDC: QuoteAsset = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN',
};
const transaction: ObservedChainTransaction = {
  signature: '5NfSignature',
  confirmationStatus: 'processed',
  blockTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  cursor: { slot: 123n, transactionIndex: 9 },
  raw: null,
};
const launch: TokenLaunch = {
  mint: 'Mint111111111111111111111111111111111111111',
  creator: 'Creator111111111111111111111111111111111111',
  tokenProgram: 'SPL_TOKEN',
  quoteAssets: [SOL, USDC],
  launchpad: 'pumpfun',
  createdAt: {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex: null,
  },
  parameters: { cashback: false, mayhem: false },
};
const trade: LaunchpadTrade = {
  id: 'adapter-trade-id',
  launchMint: launch.mint,
  kind: 'BUY',
  trader: 'Buyer11111111111111111111111111111111111111',
  baseAmountRaw: 1_000_000n,
  quoteAmountRaw: 250_000_000n,
  quoteAsset: SOL,
  cursor: {
    ...transaction.cursor,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  },
};

void test('construit des événements V1 typés sans perdre le multi-quote', () => {
  const launchEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: 'Pump111111111111111111111111111111111111111',
    transaction,
    launch,
  });
  const tradeEvent = createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: 'Pump111111111111111111111111111111111111111',
    transaction,
    trade,
  });

  assert.equal(launchEvent.type, 'TokenLaunchDetected');
  assert.equal(launchEvent.payloadVersion, 1);
  assert.deepEqual(launchEvent.payload.launch.quoteAssets, [SOL, USDC]);
  assert.equal(tradeEvent.type, 'BondingCurveTradeObserved');
  assert.equal(tradeEvent.payloadVersion, 1);
  assert.equal(tradeEvent.payload.trade.quoteAmountRaw, 250_000_000n);
});

void test('conserve le même ID lors d’une montée de confirmation', () => {
  const processed = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const finalized = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction: { ...transaction, confirmationStatus: 'finalized' },
    launch,
  });

  assert.equal(processed.id, finalized.id);
  assert.equal(finalized.confirmationStatus, 'finalized');
});
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
npx tsx --test tests/domain-contracts.test.ts tests/launchpad-events.test.ts
```

Expected: compilation fails because `mint` is not accepted by
`ChainEventIdentity` and `launchpad-events.js` does not exist.

- [ ] **Step 3: Add typed event contracts and factories**

Replace `src/domain/events.ts` with:

```ts
import { createHash } from 'node:crypto';
import type { ChainConfirmationStatus, ChainCursor } from './types.js';

export const DOMAIN_EVENT_TYPES = [
  'TokenLaunchDetected',
  'TokenMetadataResolved',
  'TokenMetadataFailed',
  'SocialEvidenceCollected',
  'CreatorProfileUpdated',
  'WalletClusterDetected',
  'BondingCurveTradeObserved',
  'BondingCurveStateUpdated',
  'BondingCurveCompleted',
  'QualificationUpdated',
  'PaperPositionOpened',
  'PaperPositionUpdated',
  'PaperPositionClosed',
  'MigrationObserved',
  'PumpSwapPoolActivated',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEvent<TPayload extends object = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type: DomainEventType;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: number;
  readonly payload: TPayload;
}

export type TypedDomainEvent<
  TType extends DomainEventType,
  TPayload extends object,
> = Omit<DomainEvent<TPayload>, 'type'> & {
  readonly type: TType;
};

export interface ChainEventIdentity {
  readonly type: string;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
}

export function createDeterministicChainEventId(identity: ChainEventIdentity): string {
  const { cursor } = identity;
  const canonical = [
    identity.type,
    identity.mint,
    identity.source,
    identity.program,
    identity.signature,
    cursor.slot.toString(),
    cursor.transactionIndex.toString(),
    cursor.instructionIndex.toString(),
    cursor.innerInstructionIndex === null ? 'outer' : cursor.innerInstructionIndex.toString(),
  ].join('\u001f');
  return `evt_${createHash('sha256').update(canonical).digest('hex')}`;
}
```

Create `src/domain/launchpad-events.ts`:

```ts
import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import type {
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from './types.js';

export interface TokenLaunchDetectedPayloadV1 {
  readonly launch: TokenLaunch;
}

export interface BondingCurveTradeObservedPayloadV1 {
  readonly trade: LaunchpadTrade;
}

export type TokenLaunchDetectedEventV1 = TypedDomainEvent<
  'TokenLaunchDetected',
  TokenLaunchDetectedPayloadV1
>;

export type BondingCurveTradeObservedEventV1 = TypedDomainEvent<
  'BondingCurveTradeObserved',
  BondingCurveTradeObservedPayloadV1
>;

export type LaunchpadObservationEventV1 =
  | TokenLaunchDetectedEventV1
  | BondingCurveTradeObservedEventV1;

interface EventFactoryInput<T> {
  readonly source: string;
  readonly program: string;
  readonly transaction: ObservedChainTransaction;
  readonly value: T;
}

export function createTokenLaunchDetectedEvent(
  input: Omit<EventFactoryInput<TokenLaunch>, 'value'> & { readonly launch: TokenLaunch },
): TokenLaunchDetectedEventV1 {
  const { launch, transaction } = input;
  const type = 'TokenLaunchDetected';
  return {
    id: createDeterministicChainEventId({
      type,
      mint: launch.mint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor: launch.createdAt,
    }),
    type,
    mint: launch.mint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor: launch.createdAt,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { launch },
  };
}

export function createBondingCurveTradeObservedEvent(
  input: Omit<EventFactoryInput<LaunchpadTrade>, 'value'> & {
    readonly trade: LaunchpadTrade;
  },
): BondingCurveTradeObservedEventV1 {
  const { trade, transaction } = input;
  const type = 'BondingCurveTradeObserved';
  return {
    id: createDeterministicChainEventId({
      type,
      mint: trade.launchMint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor: trade.cursor,
    }),
    type,
    mint: trade.launchMint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor: trade.cursor,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { trade },
  };
}
```

- [ ] **Step 4: Run focused tests and strict checks**

Run:

```bash
npx tsx --test tests/domain-contracts.test.ts tests/launchpad-events.test.ts
npm run check
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the event contracts**

```bash
git add src/domain/events.ts src/domain/launchpad-events.ts tests/domain-contracts.test.ts tests/launchpad-events.test.ts
git commit -m "feat: add deterministic launchpad events"
```

### Task 2: Confirmation reconciliation and initial transitions

**Files:**
- Modify: `tests/domain-contracts.test.ts`
- Create: `tests/confirmation-status.test.ts`
- Create: `tests/launch-state-transitions.test.ts`
- Modify: `src/domain/launch-status.ts`
- Create: `src/domain/confirmation-status.ts`
- Create: `src/domain/state-transitions.ts`

- [ ] **Step 1: Write failing confirmation and transition tests**

Create `tests/confirmation-status.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfirmationStatusConflictError,
  reconcileConfirmationStatus,
} from '../src/domain/confirmation-status.js';

void test('met à jour processed vers confirmed, finalized ou orphaned', () => {
  assert.equal(reconcileConfirmationStatus('processed', 'confirmed'), 'update');
  assert.equal(reconcileConfirmationStatus('processed', 'finalized'), 'update');
  assert.equal(reconcileConfirmationStatus('processed', 'orphaned'), 'update');
});

void test('ignore un doublon ou une observation confirmée plus ancienne', () => {
  assert.equal(reconcileConfirmationStatus('confirmed', 'confirmed'), 'keep');
  assert.equal(reconcileConfirmationStatus('confirmed', 'processed'), 'keep');
  assert.equal(reconcileConfirmationStatus('finalized', 'confirmed'), 'keep');
});

void test('refuse de réécrire un état final en un autre état final', () => {
  assert.throws(
    () => reconcileConfirmationStatus('finalized', 'orphaned'),
    ConfirmationStatusConflictError,
  );
  assert.throws(
    () => reconcileConfirmationStatus('orphaned', 'finalized'),
    ConfirmationStatusConflictError,
  );
});
```

Create `tests/launch-state-transitions.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TokenLaunchDetectedEventV1 } from '../src/domain/launchpad-events.js';
import {
  assertInitialLaunchTransitionAllowed,
  createInitialDetectedTransition,
  InvalidLaunchTransitionError,
} from '../src/domain/state-transitions.js';

const PROGRAM = 'Pump111111111111111111111111111111111111111';
const launchEvent: TokenLaunchDetectedEventV1 = {
  id: 'evt_launch',
  type: 'TokenLaunchDetected',
  mint: 'Mint111111111111111111111111111111111111111',
  source: 'pumpfun',
  program: PROGRAM,
  signature: '5NfSignature',
  cursor: {
    slot: 123n,
    transactionIndex: 9,
    instructionIndex: 2,
    innerInstructionIndex: null,
  },
  confirmationStatus: 'processed',
  blockchainTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  payloadVersion: 1,
  payload: {
    launch: {
      mint: 'Mint111111111111111111111111111111111111111',
      creator: 'Creator111111111111111111111111111111111111',
      tokenProgram: 'SPL_TOKEN',
      quoteAssets: [{
        mint: 'So11111111111111111111111111111111111111112',
        decimals: 9,
        tokenProgram: 'SPL_TOKEN',
      }],
      launchpad: 'pumpfun',
      createdAt: {
        slot: 123n,
        transactionIndex: 9,
        instructionIndex: 2,
        innerInstructionIndex: null,
      },
      parameters: {},
    },
  },
};

void test('crée une transition initiale déterministe vers DETECTED', () => {
  const first = createInitialDetectedTransition(launchEvent);
  const replay = createInitialDetectedTransition(launchEvent);

  assert.equal(first.id, replay.id);
  assert.equal(first.previousStatus, null);
  assert.equal(first.newStatus, 'DETECTED');
  assert.equal(first.triggeringEventId, launchEvent.id);
  assert.deepEqual(first.evidence, { source: 'pumpfun', program: PROGRAM });
});

void test('la seule transition initiale autorisée est null vers DETECTED', () => {
  assert.doesNotThrow(() => assertInitialLaunchTransitionAllowed(null, 'DETECTED'));
  assert.throws(
    () => assertInitialLaunchTransitionAllowed(null, 'OBSERVING'),
    InvalidLaunchTransitionError,
  );
  assert.throws(
    () => assertInitialLaunchTransitionAllowed('DETECTED', 'DETECTED'),
    InvalidLaunchTransitionError,
  );
});
```

Change the existing terminal assertions in `tests/domain-contracts.test.ts`:

```ts
assert.equal(isTerminalLaunchStatus('PAPER_CLOSED'), false);
assert.equal(isTerminalLaunchStatus('REJECTED'), true);
assert.equal(isTerminalLaunchStatus('EXPIRED'), true);
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
npx tsx --test tests/domain-contracts.test.ts tests/confirmation-status.test.ts tests/launch-state-transitions.test.ts
```

Expected: missing-module failures and the old `PAPER_CLOSED` assertion fails.

- [ ] **Step 3: Implement confirmation reconciliation**

Create `src/domain/confirmation-status.ts`:

```ts
import type { ChainConfirmationStatus } from './types.js';

export type ConfirmationReconciliation = 'keep' | 'update';

export class ConfirmationStatusConflictError extends Error {
  public constructor(
    public readonly current: ChainConfirmationStatus,
    public readonly incoming: ChainConfirmationStatus,
  ) {
    super(`Cannot reconcile terminal confirmation ${current} with ${incoming}`);
    this.name = 'ConfirmationStatusConflictError';
  }
}

export function reconcileConfirmationStatus(
  current: ChainConfirmationStatus,
  incoming: ChainConfirmationStatus,
): ConfirmationReconciliation {
  if (current === incoming) return 'keep';
  if (current === 'orphaned') {
    throw new ConfirmationStatusConflictError(current, incoming);
  }
  if (current === 'finalized') {
    if (incoming === 'processed' || incoming === 'confirmed') return 'keep';
    throw new ConfirmationStatusConflictError(current, incoming);
  }
  if (current === 'confirmed' && incoming === 'processed') return 'keep';
  return 'update';
}
```

- [ ] **Step 4: Implement deterministic initial transitions**

Remove `PAPER_CLOSED` from `TERMINAL_LAUNCH_STATUSES` in
`src/domain/launch-status.ts`.

Create `src/domain/state-transitions.ts`:

```ts
import { createHash } from 'node:crypto';
import type { DomainEventType } from './events.js';
import type { TokenLaunchDetectedEventV1 } from './launchpad-events.js';
import type { LaunchStatus } from './launch-status.js';
import type { QualificationReasonCode } from './qualification-reasons.js';

export interface StateTransition {
  readonly id: string;
  readonly payloadVersion: 1;
  readonly mint: string;
  readonly triggeringEventId: string;
  readonly triggeringEventType: DomainEventType;
  readonly occurredAtMs: number;
  readonly previousStatus: LaunchStatus | null;
  readonly newStatus: LaunchStatus;
  readonly reasonCode: QualificationReasonCode | null;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export class InvalidLaunchTransitionError extends Error {
  public constructor(
    public readonly previousStatus: LaunchStatus | null,
    public readonly newStatus: LaunchStatus,
  ) {
    super(`Invalid initial launch transition: ${previousStatus ?? 'none'} -> ${newStatus}`);
    this.name = 'InvalidLaunchTransitionError';
  }
}

export function assertInitialLaunchTransitionAllowed(
  previousStatus: LaunchStatus | null,
  newStatus: LaunchStatus,
): void {
  if (previousStatus !== null || newStatus !== 'DETECTED') {
    throw new InvalidLaunchTransitionError(previousStatus, newStatus);
  }
}

export function createInitialDetectedTransition(
  event: TokenLaunchDetectedEventV1,
): StateTransition {
  assertInitialLaunchTransitionAllowed(null, 'DETECTED');
  const canonical = [event.id, 'none', 'DETECTED'].join('\u001f');
  return {
    id: `transition_${createHash('sha256').update(canonical).digest('hex')}`,
    payloadVersion: 1,
    mint: event.mint,
    triggeringEventId: event.id,
    triggeringEventType: event.type,
    occurredAtMs: event.blockchainTimeMs ?? event.observedAtMs,
    previousStatus: null,
    newStatus: 'DETECTED',
    reasonCode: null,
    message: 'Token launch detected',
    evidence: { source: event.source, program: event.program },
  };
}
```

- [ ] **Step 5: Run focused tests and strict checks**

Run:

```bash
npx tsx --test tests/domain-contracts.test.ts tests/confirmation-status.test.ts tests/launch-state-transitions.test.ts
npm run check
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit confirmation and transition rules**

```bash
git add src/domain/confirmation-status.ts src/domain/launch-status.ts src/domain/state-transitions.ts tests/confirmation-status.test.ts tests/domain-contracts.test.ts tests/launch-state-transitions.test.ts
git commit -m "feat: define launch confirmation and transition rules"
```

### Task 3: Generic adapter and atomic sink ports

**Files:**
- Create: `tests/launchpad-ports.test.ts`
- Modify: `src/ports/launchpad-adapter.ts`
- Create: `src/ports/launchpad-event-sink.ts`

- [ ] **Step 1: Write a failing compile-time port contract test**

Create `tests/launchpad-ports.test.ts` with a richer transaction subtype and
minimal fake implementations:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BondingCurveState,
  ObservedChainTransaction,
  TokenLaunch,
} from '../src/domain/types.js';
import type { LaunchpadAdapter } from '../src/ports/launchpad-adapter.js';
import type {
  LaunchpadEventBatch,
  LaunchpadEventBatchResult,
  LaunchpadEventSink,
} from '../src/ports/launchpad-event-sink.js';

interface DecodedTransaction extends ObservedChainTransaction {
  readonly decodedProgram: 'pumpfun';
}

class Adapter implements LaunchpadAdapter<DecodedTransaction> {
  public readonly source = 'pumpfun';
  public readonly programId = 'Pump111111111111111111111111111111111111111';
  public async detectLaunches(): Promise<readonly TokenLaunch[]> {
    return [];
  }
  public async decodeTrades(): Promise<readonly never[]> {
    return [];
  }
  public async readBondingCurveState(): Promise<BondingCurveState> {
    throw new Error('not used by this contract test');
  }
}

class Sink implements LaunchpadEventSink {
  public async record(batch: LaunchpadEventBatch): Promise<LaunchpadEventBatchResult> {
    return {
      events: batch.events.map((event) => ({ eventId: event.id, outcome: 'created' })),
    };
  }
}

void test('les ports acceptent une transaction spécialisée et un batch atomique', async () => {
  const adapter: LaunchpadAdapter<DecodedTransaction> = new Adapter();
  const sink: LaunchpadEventSink = new Sink();
  assert.equal(adapter.source, 'pumpfun');
  assert.deepEqual(await sink.record({
    source: adapter.source,
    program: adapter.programId,
    signature: 'signature',
    confirmationStatus: 'processed',
    events: [],
    transitions: [],
  }), { events: [] });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
npx tsx --test tests/launchpad-ports.test.ts
```

Expected: compilation fails because `LaunchpadAdapter` is not generic and the
sink module does not exist.

- [ ] **Step 3: Make the launchpad adapter generic**

Update `src/ports/launchpad-adapter.ts` while retaining all three methods:

```ts
export interface LaunchpadAdapter<
  TTransaction extends ObservedChainTransaction = ObservedChainTransaction,
> {
  readonly source: string;
  readonly programId: string;

  detectLaunches(transaction: TTransaction): Promise<readonly TokenLaunch[]>;
  decodeTrades(
    transaction: TTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]>;
  readBondingCurveState(launch: TokenLaunch): Promise<BondingCurveState>;
}
```

- [ ] **Step 4: Add the atomic sink boundary**

Create `src/ports/launchpad-event-sink.ts`:

```ts
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { StateTransition } from '../domain/state-transitions.js';

export type EventRecordOutcome = 'created' | 'duplicate' | 'confirmation_updated';

export interface EventRecordResult {
  readonly eventId: string;
  readonly outcome: EventRecordOutcome;
}

export interface LaunchpadEventBatch {
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly events: readonly LaunchpadObservationEventV1[];
  readonly transitions: readonly StateTransition[];
}

export interface LaunchpadEventBatchResult {
  readonly events: readonly EventRecordResult[];
}

export interface LaunchpadEventSink {
  record(batch: LaunchpadEventBatch): Promise<LaunchpadEventBatchResult>;
}
```

- [ ] **Step 5: Run focused tests and strict checks**

Run:

```bash
npx tsx --test tests/launchpad-ports.test.ts
npm run check
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the generic ports**

```bash
git add src/ports/launchpad-adapter.ts src/ports/launchpad-event-sink.ts tests/launchpad-ports.test.ts
git commit -m "feat: add generic launchpad persistence ports"
```

### Task 4: One-pass observation service happy paths

**Files:**
- Create: `tests/launchpad-observation.service.test.ts`
- Create: `src/application/launchpad-observation-errors.ts`
- Create: `src/application/launchpad-observation.service.ts`

- [ ] **Step 1: Write failing orchestration tests**

Create `tests/launchpad-observation.service.test.ts` with this complete test
harness before the test cases:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { LaunchpadObservationError } from '../src/application/launchpad-observation-errors.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import type {
  BondingCurveState,
  LaunchpadTrade,
  ObservedChainTransaction,
  QuoteAsset,
  TokenLaunch,
} from '../src/domain/types.js';
import type { LaunchpadAdapter } from '../src/ports/launchpad-adapter.js';
import type {
  LaunchpadEventBatch,
  LaunchpadEventBatchResult,
  LaunchpadEventSink,
} from '../src/ports/launchpad-event-sink.js';

const PROGRAM = 'Pump111111111111111111111111111111111111111';
const SOL: QuoteAsset = {
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN',
};
const USDC: QuoteAsset = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN',
};
const transaction: ObservedChainTransaction = {
  signature: '5NfSignature',
  confirmationStatus: 'processed',
  blockTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  cursor: { slot: 123n, transactionIndex: 9 },
  raw: null,
};

interface LaunchInput {
  readonly mint: string;
  readonly instructionIndex: number;
  readonly quoteAssets: readonly QuoteAsset[];
  readonly slot?: bigint;
  readonly transactionIndex?: number;
  readonly creator?: string;
}

function launch(input: LaunchInput): TokenLaunch {
  return {
    mint: input.mint,
    creator: input.creator ?? 'Creator111111111111111111111111111111111111',
    tokenProgram: 'SPL_TOKEN',
    quoteAssets: input.quoteAssets,
    launchpad: 'pumpfun',
    createdAt: {
      slot: input.slot ?? transaction.cursor.slot,
      transactionIndex: input.transactionIndex ?? transaction.cursor.transactionIndex,
      instructionIndex: input.instructionIndex,
      innerInstructionIndex: null,
    },
    parameters: {},
  };
}

interface TradeInput {
  readonly mint: string;
  readonly instructionIndex: number;
  readonly innerInstructionIndex?: number | null;
  readonly transactionIndex?: number;
  readonly kind?: 'BUY' | 'SELL';
}

function trade(input: TradeInput): LaunchpadTrade {
  return {
    id: `adapter-${input.mint}-${input.instructionIndex}-${input.innerInstructionIndex ?? 'outer'}`,
    launchMint: input.mint,
    kind: input.kind ?? 'BUY',
    trader: 'Buyer11111111111111111111111111111111111111',
    baseAmountRaw: 1_000_000n,
    quoteAmountRaw: 250_000_000n,
    quoteAsset: SOL,
    cursor: {
      slot: transaction.cursor.slot,
      transactionIndex: input.transactionIndex ?? transaction.cursor.transactionIndex,
      instructionIndex: input.instructionIndex,
      innerInstructionIndex: input.innerInstructionIndex ?? null,
    },
  };
}

class FakeAdapter implements LaunchpadAdapter {
  public readonly source = 'pumpfun';
  public readonly programId = PROGRAM;
  public detectCalls = 0;
  public readonly decodeCalls: ReadonlySet<string>[] = [];
  public detectError: Error | null = null;
  public decodeError: Error | null = null;

  public constructor(
    private readonly launches: readonly TokenLaunch[],
    private readonly trades: readonly LaunchpadTrade[],
  ) {}

  public async detectLaunches(): Promise<readonly TokenLaunch[]> {
    this.detectCalls += 1;
    if (this.detectError !== null) throw this.detectError;
    return this.launches;
  }

  public async decodeTrades(
    _transaction: ObservedChainTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]> {
    this.decodeCalls.push(new Set(trackedMints));
    if (this.decodeError !== null) throw this.decodeError;
    return this.trades;
  }

  public async readBondingCurveState(): Promise<BondingCurveState> {
    throw new Error('not used by observation service');
  }
}

class RecordingSink implements LaunchpadEventSink {
  public readonly batches: LaunchpadEventBatch[] = [];
  public error: Error | null = null;

  public async record(batch: LaunchpadEventBatch): Promise<LaunchpadEventBatchResult> {
    this.batches.push(batch);
    if (this.error !== null) throw this.error;
    return {
      events: batch.events.map((event) => ({ eventId: event.id, outcome: 'created' })),
    };
  }
}

void test('enregistre deux créations et leurs transitions dans un seul batch', async () => {
  const first = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL, USDC] });
  const second = launch({ mint: 'MintB', instructionIndex: 3, quoteAssets: [USDC] });
  const adapter = new FakeAdapter([second, first], []);
  const sink = new RecordingSink();
  const service = new LaunchpadObservationService(adapter, sink);

  const result = await service.observe(transaction, new Set(['AlreadyTracked']));

  assert.equal(adapter.detectCalls, 1);
  assert.equal(adapter.decodeCalls.length, 1);
  assert.deepEqual([...adapter.decodeCalls[0]!].sort(), ['AlreadyTracked', 'MintA', 'MintB']);
  assert.equal(sink.batches.length, 1);
  assert.deepEqual(sink.batches[0]!.events.map((event) => event.mint), ['MintA', 'MintB']);
  assert.equal(sink.batches[0]!.transitions.length, 2);
  assert.deepEqual(result.events.map((entry) => entry.outcome), ['created', 'created']);
});

void test('ordonne création puis achat initial dans la même transaction', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 2, quoteAssets: [SOL] });
  const initialBuy = trade({
    mint: created.mint,
    instructionIndex: 2,
    innerInstructionIndex: null,
  });
  const adapter = new FakeAdapter([created], [initialBuy]);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(transaction, new Set());

  assert.deepEqual(
    sink.batches[0]!.events.map((event) => event.type),
    ['TokenLaunchDetected', 'BondingCurveTradeObserved'],
  );
});

void test('ordonne les instructions externes et internes avec le curseur complet', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL] });
  const innerBuy = trade({
    mint: created.mint,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  });
  const outerSell = trade({
    mint: created.mint,
    instructionIndex: 2,
    innerInstructionIndex: null,
    kind: 'SELL',
  });
  const adapter = new FakeAdapter([created], [innerBuy, outerSell]);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(transaction, new Set());

  assert.deepEqual(
    sink.batches[0]!.events.map((event) => [
      event.cursor.instructionIndex,
      event.cursor.innerInstructionIndex,
    ]),
    [[1, null], [2, null], [3, 0]],
  );
});

void test('ne sollicite pas le sink quand la transaction ne produit aucun événement', async () => {
  const adapter = new FakeAdapter([], []);
  const sink = new RecordingSink();
  const result = await new LaunchpadObservationService(adapter, sink)
    .observe(transaction, new Set());

  assert.equal(adapter.detectCalls, 1);
  assert.equal(adapter.decodeCalls.length, 1);
  assert.equal(sink.batches.length, 0);
  assert.deepEqual(result, { events: [] });
});
```

- [ ] **Step 2: Run the service test and confirm the red state**

Run:

```bash
npx tsx --test tests/launchpad-observation.service.test.ts
```

Expected: compilation fails because the application service does not exist.

- [ ] **Step 3: Add stage-aware orchestration errors**

Create `src/application/launchpad-observation-errors.ts`:

```ts
export type LaunchpadObservationStage =
  | 'detect_launches'
  | 'decode_trades'
  | 'validate_batch'
  | 'record_batch';

export class LaunchpadObservationError extends Error {
  public constructor(
    public readonly stage: LaunchpadObservationStage,
    public readonly source: string,
    public readonly program: string,
    public readonly signature: string,
    cause: unknown,
  ) {
    super(`Launchpad observation failed during ${stage}`, { cause });
    this.name = 'LaunchpadObservationError';
  }
}
```

- [ ] **Step 4: Implement the minimal happy-path service**

Create `src/application/launchpad-observation.service.ts` with:

```ts
import { compareCursors } from '../domain/cursor.js';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  type LaunchpadObservationEventV1,
} from '../domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../domain/state-transitions.js';
import type { ObservedChainTransaction } from '../domain/types.js';
import type { LaunchpadAdapter } from '../ports/launchpad-adapter.js';
import type {
  LaunchpadEventBatchResult,
  LaunchpadEventSink,
} from '../ports/launchpad-event-sink.js';
import { LaunchpadObservationError } from './launchpad-observation-errors.js';

const EMPTY_RESULT: LaunchpadEventBatchResult = { events: [] };

export class LaunchpadObservationService<
  TTransaction extends ObservedChainTransaction = ObservedChainTransaction,
> {
  public constructor(
    private readonly adapter: LaunchpadAdapter<TTransaction>,
    private readonly sink: LaunchpadEventSink,
  ) {}

  public async observe(
    transaction: TTransaction,
    alreadyTrackedMints: ReadonlySet<string>,
  ): Promise<LaunchpadEventBatchResult> {
    const launches = await this.callStage(
      'detect_launches',
      transaction,
      () => this.adapter.detectLaunches(transaction),
    );
    const trackedMints = new Set(alreadyTrackedMints);
    for (const launch of launches) trackedMints.add(launch.mint);
    const trades = await this.callStage(
      'decode_trades',
      transaction,
      () => this.adapter.decodeTrades(transaction, trackedMints),
    );
    const events: LaunchpadObservationEventV1[] = [
      ...launches.map((launch) => createTokenLaunchDetectedEvent({
        source: this.adapter.source,
        program: this.adapter.programId,
        transaction,
        launch,
      })),
      ...trades.map((trade) => createBondingCurveTradeObservedEvent({
        source: this.adapter.source,
        program: this.adapter.programId,
        transaction,
        trade,
      })),
    ];
    events.sort(compareLaunchpadEvents);
    if (events.length === 0) return EMPTY_RESULT;
    const transitions = events
      .filter((event) => event.type === 'TokenLaunchDetected')
      .map(createInitialDetectedTransition);
    return this.callStage('record_batch', transaction, () => this.sink.record({
      source: this.adapter.source,
      program: this.adapter.programId,
      signature: transaction.signature,
      confirmationStatus: transaction.confirmationStatus,
      events,
      transitions,
    }));
  }

  private async callStage<T>(
    stage: LaunchpadObservationError['stage'],
    transaction: TTransaction,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      throw new LaunchpadObservationError(
        stage,
        this.adapter.source,
        this.adapter.programId,
        transaction.signature,
        error,
      );
    }
  }
}

function compareLaunchpadEvents(
  left: LaunchpadObservationEventV1,
  right: LaunchpadObservationEventV1,
): number {
  const cursorOrder = compareCursors(left.cursor, right.cursor);
  if (cursorOrder !== 0) return cursorOrder;
  if (left.type !== right.type) return left.type === 'TokenLaunchDetected' ? -1 : 1;
  return left.id.localeCompare(right.id);
}
```

- [ ] **Step 5: Run focused tests and strict checks**

Run:

```bash
npx tsx --test tests/launchpad-observation.service.test.ts
npm run check
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the nominal application pipeline**

```bash
git add src/application/launchpad-observation-errors.ts src/application/launchpad-observation.service.ts tests/launchpad-observation.service.test.ts
git commit -m "feat: orchestrate launchpad observations"
```

### Task 5: Batch validation, replay, and failure atomicity

**Files:**
- Modify: `tests/launchpad-observation.service.test.ts`
- Modify: `src/application/launchpad-observation.service.ts`

- [ ] **Step 1: Add failing replay and validation tests**

Append these replay and validation tests:

```ts
void test('rejoue une observation avec exactement les mêmes IDs', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL] });
  const buy = trade({ mint: created.mint, instructionIndex: 2, innerInstructionIndex: 0 });
  const firstSink = new RecordingSink();
  const secondSink = new RecordingSink();

  await new LaunchpadObservationService(new FakeAdapter([created], [buy]), firstSink)
    .observe(transaction, new Set());
  await new LaunchpadObservationService(new FakeAdapter([created], [buy]), secondSink)
    .observe({ ...transaction, confirmationStatus: 'finalized' }, new Set());

  assert.deepEqual(
    firstSink.batches[0]!.events.map((event) => event.id),
    secondSink.batches[0]!.events.map((event) => event.id),
  );
  assert.deepEqual(
    firstSink.batches[0]!.transitions.map((transition) => transition.id),
    secondSink.batches[0]!.transitions.map((transition) => transition.id),
  );
});

void test('refuse un curseur hors transaction avant tout appel au sink', async () => {
  const invalid = launch({
    mint: 'MintA',
    instructionIndex: 1,
    quoteAssets: [SOL],
    slot: transaction.cursor.slot + 1n,
  });
  const sink = new RecordingSink();

  await assert.rejects(
    new LaunchpadObservationService(new FakeAdapter([invalid], []), sink)
      .observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('refuse un trade pour un mint non suivi', async () => {
  const sink = new RecordingSink();
  await assert.rejects(
    new LaunchpadObservationService(
      new FakeAdapter([], [trade({ mint: 'Unknown', instructionIndex: 2 })]),
      sink,
    ).observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('refuse une création sans quote asset', async () => {
  const sink = new RecordingSink();
  await assert.rejects(
    new LaunchpadObservationService(
      new FakeAdapter([launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [] })], []),
      sink,
    ).observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('refuse deux définitions contradictoires du même mint', async () => {
  const first = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL] });
  const conflicting = { ...first, creator: 'OtherCreator' };
  const sink = new RecordingSink();

  await assert.rejects(
    new LaunchpadObservationService(new FakeAdapter([first, conflicting], []), sink)
      .observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('encapsule chaque échec d’adaptateur ou de sink avec son étape', async () => {
  const detectFailure = new FakeAdapter([], []);
  detectFailure.detectError = new Error('detector unavailable');
  await assert.rejects(
    new LaunchpadObservationService(detectFailure, new RecordingSink())
      .observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'detect_launches',
  );

  const sink = new RecordingSink();
  sink.error = new Error('database unavailable');
  await assert.rejects(
    new LaunchpadObservationService(
      new FakeAdapter([launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL] })], []),
      sink,
    ).observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'record_batch',
  );
});
```

```ts
void test('encapsule un échec de décodage sans appeler le sink', async () => {
  const adapter = new FakeAdapter([], []);
  adapter.decodeError = new Error('decoder unavailable');
  const sink = new RecordingSink();

  await assert.rejects(
    new LaunchpadObservationService(adapter, sink).observe(transaction, new Set()),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'decode_trades',
  );
  assert.equal(sink.batches.length, 0);
});

void test('refuse le mauvais index de transaction', async () => {
  const sink = new RecordingSink();
  const invalid = trade({
    mint: 'Tracked',
    instructionIndex: 2,
    transactionIndex: transaction.cursor.transactionIndex + 1,
  });

  await assert.rejects(
    new LaunchpadObservationService(new FakeAdapter([], [invalid]), sink)
      .observe(transaction, new Set(['Tracked'])),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('refuse deux événements ayant le même identifiant déterministe', async () => {
  const duplicate = trade({ mint: 'Tracked', instructionIndex: 2 });
  const sink = new RecordingSink();

  await assert.rejects(
    new LaunchpadObservationService(
      new FakeAdapter([], [duplicate, { ...duplicate, id: 'another-adapter-id' }]),
      sink,
    ).observe(transaction, new Set(['Tracked'])),
    (error: unknown) =>
      error instanceof LaunchpadObservationError && error.stage === 'validate_batch',
  );
  assert.equal(sink.batches.length, 0);
});

void test('déduplique deux définitions strictement identiques du même lancement', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL, USDC] });
  const sink = new RecordingSink();

  await new LaunchpadObservationService(new FakeAdapter([created, created], []), sink)
    .observe(transaction, new Set());

  assert.equal(sink.batches.length, 1);
  assert.equal(sink.batches[0]!.events.length, 1);
  assert.equal(sink.batches[0]!.transitions.length, 1);
});

void test('préserve exactement les quotes SOL et USDC après validation', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL, USDC] });
  const sink = new RecordingSink();

  await new LaunchpadObservationService(new FakeAdapter([created], []), sink)
    .observe(transaction, new Set());

  const event = sink.batches[0]!.events[0]!;
  assert.equal(event.type, 'TokenLaunchDetected');
  assert.deepEqual(event.payload.launch.quoteAssets, [SOL, USDC]);
});

void test('appelle le sink exactement une fois pour un batch valide non vide', async () => {
  const created = launch({ mint: 'MintA', instructionIndex: 1, quoteAssets: [SOL] });
  const observedTrade = trade({ mint: created.mint, instructionIndex: 2 });
  const sink = new RecordingSink();

  await new LaunchpadObservationService(
    new FakeAdapter([created], [observedTrade]),
    sink,
  ).observe(transaction, new Set());

  assert.equal(sink.batches.length, 1);
  assert.equal(sink.batches[0]!.events.length, 2);
});
```

- [ ] **Step 2: Run the service tests and confirm the red state**

Run:

```bash
npx tsx --test tests/launchpad-observation.service.test.ts
```

Expected: validation scenarios reach the sink or return an unexpected stage.

- [ ] **Step 3: Validate and normalize before constructing the batch**

Add `isDeepStrictEqual` from `node:util`, import `ChainCursor`,
`LaunchpadTrade`, `TokenLaunch`, and `StateTransition`, then replace event
construction in `observe` with:

```ts
const observation = await this.callStage(
  'validate_batch',
  transaction,
  () => this.buildValidatedObservation(
    transaction,
    launches,
    trades,
    trackedMints,
  ),
);
if (observation.events.length === 0) return EMPTY_RESULT;
return this.callStage('record_batch', transaction, () => this.sink.record({
  source: this.adapter.source,
  program: this.adapter.programId,
  signature: transaction.signature,
  confirmationStatus: transaction.confirmationStatus,
  events: observation.events,
  transitions: observation.transitions,
}));
```

Add these private helpers to the service:

```ts
private buildValidatedObservation(
  transaction: TTransaction,
  launches: readonly TokenLaunch[],
  trades: readonly LaunchpadTrade[],
  trackedMints: ReadonlySet<string>,
): {
  readonly events: readonly LaunchpadObservationEventV1[];
  readonly transitions: readonly StateTransition[];
} {
  const launchesByMint = new Map<string, TokenLaunch>();
  for (const launch of launches) {
    this.assertCursorBelongsToTransaction(transaction, launch.createdAt);
    if (launch.quoteAssets.length === 0) {
      throw new Error(`Launch ${launch.mint} has no quote asset`);
    }
    const existing = launchesByMint.get(launch.mint);
    if (existing !== undefined && !isDeepStrictEqual(existing, launch)) {
      throw new Error(`Conflicting launch definitions for ${launch.mint}`);
    }
    launchesByMint.set(launch.mint, launch);
  }
  for (const trade of trades) {
    this.assertCursorBelongsToTransaction(transaction, trade.cursor);
    if (!trackedMints.has(trade.launchMint)) {
      throw new Error(`Trade mint ${trade.launchMint} is not tracked`);
    }
  }
  const events: LaunchpadObservationEventV1[] = [
    ...[...launchesByMint.values()].map((launch) => createTokenLaunchDetectedEvent({
      source: this.adapter.source,
      program: this.adapter.programId,
      transaction,
      launch,
    })),
    ...trades.map((trade) => createBondingCurveTradeObservedEvent({
      source: this.adapter.source,
      program: this.adapter.programId,
      transaction,
      trade,
    })),
  ];
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw new Error(`Duplicate event ID ${event.id}`);
    }
    eventIds.add(event.id);
  }
  events.sort(compareLaunchpadEvents);
  const transitions = events
    .filter((event) => event.type === 'TokenLaunchDetected')
    .map(createInitialDetectedTransition);
  return { events, transitions };
}

private assertCursorBelongsToTransaction(
  transaction: TTransaction,
  cursor: ChainCursor,
): void {
  if (
    cursor.slot !== transaction.cursor.slot
    || cursor.transactionIndex !== transaction.cursor.transactionIndex
  ) {
    throw new Error(`Cursor does not belong to transaction ${transaction.signature}`);
  }
}
```

Extend `callStage` so its callback accepts synchronous or asynchronous results:

```ts
private async callStage<T>(
  stage: LaunchpadObservationError['stage'],
  transaction: TTransaction,
  action: () => T | Promise<T>,
): Promise<T>
```

- [ ] **Step 4: Run the validation suite and confirm atomic behavior**

Run:

```bash
npx tsx --test tests/launchpad-observation.service.test.ts
```

Expected: all service tests pass, including zero sink calls on detection,
decoding, and local validation failures.

- [ ] **Step 5: Run the complete quality gate**

Run:

```bash
npm run build
npm run check
npm run lint
npm test
git diff --check
```

Expected: build, strict check, lint, all existing and new tests, and whitespace
validation exit 0. Existing Raydium, execution-safety, storage, migration
contract, and configuration tests remain green.

- [ ] **Step 6: Commit validation and atomicity**

```bash
git add src/application/launchpad-observation.service.ts tests/launchpad-observation.service.test.ts
git commit -m "test: harden launchpad observation batches"
```

### Task 6: Final scope and safety audit

**Files:**
- Inspect: `src/application/launchpad-observation.service.ts`
- Inspect: `src/domain/launchpad-events.ts`
- Inspect: `src/ports/launchpad-adapter.ts`
- Inspect: `src/ports/launchpad-event-sink.ts`
- Inspect: `src/app.ts`
- Inspect: `migrations/`

- [ ] **Step 1: Prove PR B has no production wiring or execution capability**

Run:

```bash
git diff --name-status 4108d86ab6a54f7db9677fc901e4e8de2f28d4cf...HEAD
git diff 4108d86ab6a54f7db9677fc901e4e8de2f28d4cf...HEAD -- src/app.ts migrations package.json
rg -n "sendTransaction|sendRawTransaction|Keypair|private.?key|PumpFun|PumpSwap" src/application src/domain/launchpad-events.ts src/ports
```

Expected:

- no diff for `src/app.ts`, `migrations/`, or `package.json`;
- no transaction submission, signer, private-key, Pump.fun IDL, discriminator,
  or PumpSwap implementation in the new pipeline.

- [ ] **Step 2: Re-run the final verification from a clean status**

Run:

```bash
git status --short
npm run build
npm run check
npm run lint
npm test
git status --short
```

Expected: the worktree is clean before and after verification and every command
exits 0.

- [ ] **Step 3: Record the verification evidence for PR creation**

Capture the exact test count and the successful output summaries for the PR
body. Do not create an extra commit when the worktree is already clean.

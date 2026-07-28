# PR B — Launchpad Domain and Generic Event Pipeline Design

## Objective

Add an executable, source-independent application pipeline that turns launchpad
observations into deterministic domain-event batches. The pipeline must prove
that one transaction may contain multiple launches and an initial buy without
depending on Pump.fun decoding, PostgreSQL, an RPC connection, or a private key.

## Scope

PR B adds:

- typed V1 payloads for launch detection and bonding-curve trades;
- a generic `LaunchpadObservationService`;
- deterministic state-transition records;
- confirmation-status reconciliation rules;
- a batch sink port whose future PostgreSQL implementation can be atomic;
- unit tests for multi-launch, creation-plus-buy, CPI cursors, replay,
  multi-quote preservation, confirmation upgrades, and failure atomicity.

PR B does not add:

- Pump.fun program addresses, IDLs, discriminators, account layouts, or SDKs;
- a concrete `PumpFunLaunchpadAdapter`;
- PostgreSQL repositories or migrations;
- RPC subscriptions or bootstrap changes;
- metadata, qualification, paper-trading, or PumpSwap behavior.

## Chosen approach

The pipeline is a pure application service behind ports. This is preferred over:

1. type-only contracts, which cannot prove orchestration and idempotency; and
2. a general event-bus framework, which would add infrastructure before a
   concrete Pump.fun decoder exists.

The future PostgreSQL adapter will implement one batch-sink port in PR D. Until
then, tests use small in-memory fakes owned by the test suite rather than a
production in-memory database.

## Domain contracts

### Typed events

`TypedDomainEvent<TType, TPayload>` narrows the existing `DomainEvent` envelope
without changing its required Solana coordinates.

PR B defines:

- `TokenLaunchDetectedPayloadV1` with the normalized `TokenLaunch`;
- `BondingCurveTradeObservedPayloadV1` with the normalized `LaunchpadTrade`;
- `TokenLaunchDetectedEventV1`;
- `BondingCurveTradeObservedEventV1`;
- `LaunchpadObservationEventV1`, the union consumed by the batch sink.

All PR B payloads use `payloadVersion: 1`. Raw token amounts, quote amounts,
slots, reserves, and basis points remain integers. JSON serialization stays an
infrastructure concern.

### Deterministic identity

Event identity contains:

- event type;
- mint;
- adapter source;
- program;
- transaction signature;
- slot;
- transaction index;
- instruction index;
- inner-instruction index.

Confirmation status and observation time do not participate in identity. A
`processed`, `confirmed`, or `finalized` observation of the same instruction
therefore reconciles the same event instead of creating duplicates.

Transition identity contains:

- triggering event ID;
- previous state or `none`;
- new state.

### State transitions

`StateTransition` contains:

- deterministic ID and payload version;
- mint and triggering event ID/type;
- occurrence time and its `blockchain` or `observation` source;
- previous and new state;
- optional stable qualification reason code;
- human-readable message;
- immutable evidence.

The transition policy introduced in PR B validates the only transition emitted
by this pipeline: `null -> DETECTED`. It also exposes terminal-state guards for
future services, but does not invent the complete product workflow before the
metadata, qualification, paper-trading, and migration services exist. Each
later PR must add its own explicit allowed edges and tests before emitting a
new transition.

`REJECTED` and `EXPIRED` are terminal lifecycle states. `PAPER_CLOSED` closes a
paper position but is not universally terminal for the launch: a product policy
may continue through `BONDING_CURVE_COMPLETE`, `MIGRATION_PENDING`, and
`PUMPSWAP_ACTIVE`. Retention eligibility remains a separate decision requiring
both a terminal tracking decision and no open paper position.

The initial transition is exclusively `null -> DETECTED` for a non-orphaned
observation. A first-seen orphaned launch retains its domain event for audit but
does not apply that transition or create active launch state.

`reconcileTransitionOccurrence(current, incoming)` enriches occurrence metadata
independently of the event-record outcome. Blockchain time always outranks an
observation-time fallback. Within the same source, the smaller timestamp wins.
The merge is therefore commutative and order-independent: a late same-status
replay may add blockchain time, while a later fallback can never replace it.

## Generic adapter contract

`LaunchpadAdapter` becomes generic over its observed transaction type:

```ts
interface LaunchpadAdapter<
  TTransaction extends ObservedChainTransaction = ObservedChainTransaction
> {
  detectLaunches(transaction: TTransaction): Promise<readonly TokenLaunch[]>;
  decodeTrades(
    transaction: TTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]>;
  readBondingCurveState(launch: TokenLaunch): Promise<BondingCurveState>;
}
```

This keeps the port source-independent while allowing the future Pump.fun
adapter to require a normalized Solana transaction rather than casting
`raw: unknown`.

## Application flow

`LaunchpadObservationService.observe(transaction, alreadyTrackedMints)` performs:

1. call `detectLaunches` exactly once;
2. form a new set containing existing tracked mints plus all newly detected
   mints;
3. call `decodeTrades` exactly once with that set;
4. validate that every launch and trade cursor belongs to the input transaction;
5. create one launch event per launch and, unless the observation is orphaned,
   its initial transition;
6. create one trade event per decoded trade;
7. reject duplicate deterministic IDs inside the batch;
8. sort events by cursor, then place launch detection before a trade on an
   identical cursor;
9. validate the complete batch contract, including event-envelope consistency
   and exact launch-event/transition membership;
10. call the sink once with the complete immutable batch;
11. return the sink result.

This ordering allows a future Pump.fun adapter to emit both creation and initial
buy from one transaction. Calling the decoder once also prevents repeated use of
transaction-global balance deltas.

An observation that produces no events returns an empty result without invoking
the sink.

## Batch sink port and idempotency

`LaunchpadEventSink.record(batch)` accepts:

- adapter source and program;
- signature and input confirmation status;
- ordered events;
- a discriminated state-transition action, `apply` or `retract`;
- initial state transitions.

It returns one outcome per event:

- `created`;
- `duplicate`;
- `confirmation_updated`.

The contract requires a concrete sink to persist the entire batch atomically.
The sink owns durable idempotency and confirmation upgrades; deterministic IDs
make those guarantees testable before the PostgreSQL implementation exists.

The batch is a discriminated union. An `apply` batch has `processed`,
`confirmed`, or `finalized` confirmation and a transition array. A `retract`
batch has `orphaned` confirmation and an exactly empty transition tuple. The
exported runtime assertion defends JavaScript and cast boundaries by validating
that action and status agree, every event shares the batch envelope, and every
launch event in an `apply` batch has exactly one matching transition with no
transition linked outside the batch.

For `apply`, the sink atomically applies or upserts the supplied transitions,
linked to events by `triggeringEventId`. A first-seen orphaned event is retained
for audit and creates no active transition. For an existing event, `retract`
atomically invalidates or removes its transitions from the active launch
projection only after successful `processed | confirmed -> orphaned`
reconciliation, while preserving the domain event and durable invalidation
history. Raw chain input is ingested separately; the domain event preserves its
link to that audit history rather than carrying a raw payload in this batch.

This transition action and event confirmation reconciliation belong to the same
durable all-or-nothing transaction, which still returns exactly one result per
input event. PR B defines this port contract only; it does not implement a
database sink.

## Confirmation reconciliation

The pure reconciliation function returns `keep` or `update`.

Allowed upgrades:

- `processed -> confirmed | finalized | orphaned`;
- `confirmed -> finalized | orphaned`.

Repeated status and late lower-confirmation observations return `keep`.
`finalized` and `orphaned` are terminal confirmation states. A conflicting
transition out of either throws `ConfirmationStatusConflictError` so the system
cannot silently rewrite finalized history. In particular,
`finalized -> orphaned` and every transition out of `orphaned` reject the entire
batch atomically before any active-projection retraction.

On processed/confirmed/finalized replay, transition identity remains stable.
Independently of whether the event result is `created`, `duplicate`, or
`confirmation_updated`, the sink merges transition occurrence metadata with
`reconcileTransitionOccurrence`. Blockchain time outranks observation time and
the earlier timestamp wins within one source, so enrichment is deterministic
regardless of replay order.

## Validation and errors

Errors are typed:

- `LaunchpadObservationError` identifies `detect_launches`, `decode_trades`,
  `validate_batch`, or `record_batch`, plus source, program, and signature;
- `InvalidLaunchTransitionError` includes previous and requested states;
- `InvalidLaunchpadEventBatchError` identifies a contradictory or internally
  inconsistent batch at a JavaScript or cast boundary;
- `ConfirmationStatusConflictError` includes current and incoming statuses.

If detection, trade decoding, or validation fails, the sink is not called. If
the sink fails, the service reports `record_batch`; retrying remains safe
because identities are deterministic.

The service rejects:

- a launch or trade cursor from another slot or transaction index;
- a trade for a mint outside the tracked/newly-created set;
- duplicate event IDs in one batch;
- an empty quote-asset list on a new launch;
- conflicting definitions for the same newly detected mint.

## Testing

Tests run without network or PostgreSQL and cover:

1. two launches in one transaction;
2. launch plus initial buy in the same transaction;
3. external and inner-instruction cursor ordering;
4. exact preservation of multiple quote assets;
5. deterministic IDs across replay;
6. event IDs unchanged across confirmation upgrades;
7. confirmation upgrade, downgrade, and terminal conflicts;
8. valid `null -> DETECTED`, invalid initial transitions, and terminal-state
   guards;
9. invalid cursor or untracked trade rejection;
10. adapter failure with zero sink calls;
11. empty observation with zero sink calls;
12. one sink call for a complete non-empty batch;
13. first-seen and replayed orphaned launch batches retain events, request
    `retract`, and carry no transitions;
14. trade-only orphaned batches request `retract`;
15. processed-to-finalized replay keeps event/transition IDs while exposing the
    incoming canonical transition timestamp;
16. invalid action/status shapes are rejected at compile time and runtime;
17. mismatched event envelopes and missing, extra, or mismatched launch
    transitions are rejected;
18. occurrence enrichment is commutative, prefers blockchain time, and chooses
    the earlier timestamp within one source;
19. finalized-to-orphaned reconciliation rejects before any retraction.

The existing build, strict type-check, lint, migration-contract, Raydium fixture,
risk, session, and paper-execution tests must remain green.

## Acceptance criteria

- no Pump.fun-specific constants or decoding logic;
- no PostgreSQL or bootstrap changes;
- no signer, key, transaction builder, or submission dependency;
- TypeScript strict and ESM imports remain consistent;
- no `any`;
- launch and trade values remain multi-quote;
- one adapter call per detection/decode phase and one sink call per non-empty
  observation;
- creation-plus-initial-buy is represented in one ordered batch;
- replay produces identical IDs;
- normal observations request transition `apply`, while orphaned observations
  request `retract` with a frozen empty transition list;
- contradictory batch shapes are unrepresentable in TypeScript and rejected at
  runtime boundaries;
- all existing and new tests pass.

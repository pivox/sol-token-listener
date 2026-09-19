# Pump.fun Catch-up Block Classifier Design

Version: 1.0.3 — 2026-09-19 — issue #133.

## Goal and status

`PumpFunCatchUpBlockClassifier` is an inactive application service that turns
merged strict catch-up discoveries into the durable B1 classification ledger.
It hydrates complete normalized transactions through the serialized block
locator introduced by #127, decodes Pump.fun actions with the existing official
IDL-derived decoder, then persists `CatchUpClassification` values through the
existing repository port.

This PR does not compose the service in a scanner, factory or runtime. It adds
no configuration, checkpoint mutation, migration, wallet access, signing,
submission or live RPC call. Production behavior remains unchanged.

## Boundaries and dependencies

The service receives one immutable `readonly MergedCatchUpDiscovery[]`. Its
constructor dependencies are deliberately narrow:

- a transaction locator exposing only `locate(TransactionLocationTarget)`;
- `CatchUpClassificationRepository.recordCatchUpClassification`;
- an injectable millisecond clock used only for `observedAtMs` and
  `classifiedAtMs`.

The production-shaped locator dependency is satisfied by
`CachedSolanaBlockTransactionLocator`, whose shared cache key is
`(slot, effective commitment, HTTP epoch)`. Callers for the same key and
generation join one single-flight, while its admission queue guarantees at most
one active block fetch across the instance. A retained block that lacks the
target signature may trigger the cache's one allowed forced refresh. The
classifier neither constructs nor clears that cache and does not add a direct
or legacy locator fallback.

`processed` and `confirmed` discoveries use the effective uppercase
`CONFIRMED` locator commitment; `finalized` uses `FINALIZED`. The locator never
receives `PROCESSED` from this service. The classifier derives the durable
lowercase classification finality explicitly from `MergedCatchUpDiscovery`,
never from the normalized cache payload. Cache commitment and business finality
are separate concepts. Discovery `blockTimeMs`, observation time and finality
are excluded from semantic identity.

## Grouping and deterministic order

Before sampling the clock or calling the locator, the service validates and
snapshots the entire input as deeply immutable plain data. The top-level value
must be a non-proxy, dense, data-only array with no extra keys and at most
100,000 entries. Every discovery must
have exactly the merged-discovery fields, data descriptors only, no proxy or
accessor, a bounded signature, safe non-negative bigint slot, valid lowercase
finality, valid nullable block time, and one to sixteen canonical sorted unique
Solana program IDs including the Pump.fun program. Duplicate signatures are
rejected globally. Any invalid container or element rejects the call with zero
clock reads, RPC calls and writes. Requiring Pump.fun provenance at this
boundary prevents an accidental mixed PumpSwap-only feed from being persisted
as unsupported launchpad evidence.

Validated input is grouped first by slot. Each slot contains effective
`CONFIRMED` and `FINALIZED` hydration buckets. Slots are processed in ascending
order; rows inside a slot are ordered `CONFIRMED` before `FINALIZED`, then
lexically by signature. Their already canonical `programIds` are retained as
provenance.

The classifier starts every location attempt for both commitment buckets of a
slot before awaiting their settlement. Calls sharing one cache key therefore
join the same block-cache flight even when a target is absent or its payload is
unusable and cannot retain the fetched block. It waits for every attempt with
settled-result semantics, then completes every admissible decode/classification
before the first repository write for that slot. The classifier persists
classifications in effective commitment/signature order only when the complete
slot has no retryable or untrusted failure. This slot-wide barrier prevents a
late failure in the `FINALIZED` bucket from leaving earlier `CONFIRMED`
signatures durably admitted and prevents sequential cache misses from
amplifying block RPC traffic.

Slots are independent. A slot completes only after every classification has
been recorded. If persistence fails after a prefix was written, the slot
rejects immediately. Retrying the same slot safely replays that prefix through
B1 and continues; no classifier checkpoint or private progress marker is
introduced.

## Closed classification policy

The classifier applies this ordered decision table:

| Evidence | Disposition | Reason | Hint | Mints |
| --- | --- | --- | --- | --- |
| Solana transaction has a non-null execution error | `IGNORED` | `SOLANA_TRANSACTION_FAILED` | none | empty |
| Decoded create/trade evidence references more than sixteen unique mints | `QUARANTINED` | `PUMP_SCHEMA_UNSUPPORTED` | none | empty |
| At least one decoded Pump.fun creation, including a transaction with its initial buy | `ACTIONABLE` | `PUMP_ACTION_SUPPORTED` | `PUMPFUN_CREATE` | sorted unique creation/trade mints |
| No creation and trades reference exactly one mint | `DEFERRED` | `PUMP_TRADE_UNTRACKED` | `PUMPFUN_TRADE` plus its separate hint mint | that mint |
| No creation and trades reference two to sixteen mints | `QUARANTINED` | `PUMP_SCHEMA_UNSUPPORTED` | none | sorted unique trade mints |
| No supported Pump.fun create or trade | `IGNORED` | `NO_SUPPORTED_PUMP_ACTION` | none | empty |
| Trusted target normalization or trusted Pump.fun decoding failure | `QUARANTINED` | `PUMP_SCHEMA_UNSUPPORTED` | none | empty |
| Trusted locator reports the target signature absent/ambiguous | `QUARANTINED` | `PROVIDER_SIGNATURE_MISSING` | none | empty |

Creation wins over trade-only classification so a create plus initial buy is
one actionable launch, not a deferred trade. All decoded create and trade mints
are retained on that classification, canonicalized as a sorted unique set.
The sixteen-mint ledger bound is checked before the creation/trade decision. A
larger set is quarantined with empty persisted mints so domain validation cannot
turn every replay into the same failure. Its fingerprint contains the closed
`MINT_LIMIT_EXCEEDED:<count>` marker and the canonical semantic action evidence,
so replay remains stable without discarding which decoded actions caused the
overflow.
Pump migrations alone are not actionable in B2b and therefore follow
`NO_SUPPORTED_PUMP_ACTION`.

Only authority-bearing failures from the existing trusted locator and decoder
registries may become terminal quarantine evidence. A decoder origin must also
belong to the closed Pump.fun decoder-code registry; a trusted PumpSwap origin
does not grant authority at this boundary. Trusted locator failures
marked retryable, including transient RPC and block unavailability, reject the
whole slot before any write. Any unknown, forged or untrusted exception also
rejects the slot without being converted to a durable classification. Provider
messages, URLs, response bodies and exception causes never enter the ledger or
fingerprint.

Every located transaction must exactly match the discovery signature and slot
before error inspection or decoding. A mismatch is an untrusted dependency
failure and rejects the entire slot before writes; it is never converted into
provider evidence.

## Evidence fingerprint and timestamps

The V1 evidence fingerprint is lowercase SHA-256 over unambiguous
length-prefixed UTF-8 segments. The segments contain:

1. the domain tag `pumpfun-catch-up-classification-v1`;
2. signature and decimal slot;
3. disposition, reason code, action hint and hint mint (or explicit `NONE`);
4. canonical sorted mints;
5. `ACTION_COUNT:<count>` and canonical decoded semantic actions ordered by
   normalized instruction cursor, represented as
   `ACTION:<instructionIndex>:<inner-or-NONE>:<CREATE|BUY|SELL|MIGRATE>:<mint>`;
6. a precise closed outcome marker: locator quarantine includes the trusted
   locator code, decoder quarantine includes the trusted decoder origin, mint
   overflow uses `MINT_LIMIT_EXCEEDED:<count>`, and failed/unsupported outcomes
   use their stable reason marker.

This identity intentionally excludes `programIds`, confirmation status,
`blockTimeMs`, `observedAtMs` and `classifiedAtMs`. Program provenance and
finality converge separately in B1; wall-clock replay must not create a
classification conflict or extend retention.

Migrations remain non-actionable in B2b, but their cursor and mint are retained
as fingerprint evidence so a migration-only transaction is not semantically
identical to a transaction with no Pump.fun instruction.

The clock is sampled once for a classifier call. That finite safe integer is
used as both observation and classification time for every new value from the
call. `createCatchUpClassification` remains the final domain validator. A later
semantic replay may carry a newer clock value, but the repository preserves the
first stored `catch_up_classified_at`. For terminal `IGNORED` and `QUARANTINED`
rows it also preserves the original `terminal_at` and exact
`purge_after = terminal_at + 4 hours`. `DEFERRED` preserves those timestamps
while it remains deferred; promotion to tracked `PENDING` clears both according
to the existing admission lifecycle.

## Repository replay correction

B1 currently treats `classifiedAtMs` as immutable and recomputes terminal
retention from a replay's new timestamp. B2b changes only that replay rule:

- `storedClassificationMatches` compares version, slot, disposition, reason,
  immutable action key, canonical mints and fingerprint, but not timestamps or
  finality;
- an existing classified row retains its first `catch_up_classified_at`;
- ignored/quarantined replay, and deferred replay that remains deferred, reuse
  stored `terminal_at` and `purge_after` exactly;
- promotion from deferred to tracked `PENDING` clears terminal retention;
- actionable finality replay keeps the existing B1 reprocessing behavior;
- changed semantic evidence remains a `classification` conflict.

No database migration is needed because the stored shape and constraints do
not change. The correction only broadens accepted semantic replay while making
the four-hour retention deadline strictly non-extendable.

## Failure atomicity and restart behavior

Hydration and decoding produce an in-memory classification batch before writes.
A retryable locator failure therefore persists zero rows for its entire slot.
Repository writes remain one classification transaction each; a database error
may leave an already committed prefix, but replay is deterministic and B1
accepts the prefix even with a new call timestamp. Conflicting stored evidence
still fails closed.

The service owns no lease, scanner cursor or checkpoint. Restart simply presents
the same discoveries again. The deterministic fingerprint, stable ordering and
corrected B1 replay make this safe without claiming all-or-nothing persistence
across multiple signatures.

## Verification

Pure classifier tests use normalized offline fixtures and fakes only. They cover
defensive input snapshotting, group ordering, the slot-wide
all-hydrations-before-writes barrier, effective commitments,
create plus initial buy, mono-mint trade, failed transaction, no supported
action, migration evidence, multi-mint and mint-limit fail-closed quarantine,
located identity mismatch, trusted schema/normalization and missing-signature
quarantine, retryable and untrusted slot rejection, precise failure markers,
stable fingerprints across time/finality, partial-write replay and
deterministic persistence order.

An offline integration test composes the classifier with
`CachedSolanaBlockTransactionLocator` and proves that multiple absent targets
sharing a cold `(slot, commitment, epoch)` join one fetch, settle without a
write, and leave no pending locator work.

PostgreSQL 16 repository tests prove that a semantic replay with newer
`observedAtMs`/`classifiedAtMs` preserves the first classification, terminal and
purge timestamps, while a changed fingerprint or decision still conflicts.
Build, strict type-check, lint, documentation checks and whitespace validation
complete the PR. No test contacts a live RPC endpoint or imports signing and
submission code.

Any future runtime activation must either pass only Pump.fun launchpad
discoveries to this classifier or extend the classifier with explicit PumpSwap
and migration admission policy first. Feeding a mixed market stream into the
current no-supported-action branch would silently classify PumpSwap evidence as
ignored and is therefore forbidden.

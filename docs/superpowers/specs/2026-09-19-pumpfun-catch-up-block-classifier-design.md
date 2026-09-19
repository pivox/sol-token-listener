# Pump.fun Catch-up Block Classifier Design

Version: 1.0.0 — 2026-09-19 — issue #133.

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
`(slot, effective commitment, HTTP epoch)` and whose admission queue guarantees
one active block fetch. The classifier neither constructs nor clears that cache
and does not add a direct or legacy locator fallback.

`processed` and `confirmed` discoveries share the effective `CONFIRMED` cache
commitment; `finalized` uses `FINALIZED`. The requested status is still passed
per signature and the locator rewrites the returned normalized transaction
status to that exact target. The classifier nevertheless derives the durable
classification finality explicitly from `MergedCatchUpDiscovery`, never from
the cache payload. Cache commitment and business finality are separate
concepts. Discovery `blockTimeMs`, observation time and finality are excluded
from semantic identity.

## Grouping and deterministic order

Input is snapshotted and grouped by `(slot, effective commitment)`. Groups are
processed by ascending slot, then `CONFIRMED` before `FINALIZED`. Within a group,
discoveries are ordered lexically by signature; their already canonical
`programIds` are retained as provenance.

Every location attempt for a group settles before the first repository write
for that group. The classifier then decodes and classifies the settled results
in signature order and persists them in the same order. This hydration barrier
prevents a retryable failure late in a slot group from leaving earlier
signatures durably admitted.

Groups are independent. A group completes only after every classification has
been recorded. If persistence fails after a prefix was written, the group
rejects immediately. Retrying the same group safely replays that prefix through
B1 and continues; no classifier checkpoint or private progress marker is
introduced.

## Closed classification policy

The classifier applies this ordered decision table:

| Evidence | Disposition | Reason | Hint | Mints |
| --- | --- | --- | --- | --- |
| Solana transaction has a non-null execution error | `IGNORED` | `SOLANA_TRANSACTION_FAILED` | none | empty |
| At least one decoded Pump.fun creation, including a transaction with its initial buy | `ACTIONABLE` | `PUMP_ACTION_SUPPORTED` | `PUMPFUN_CREATE` | sorted unique creation/trade mints |
| No creation and trades reference exactly one mint | `DEFERRED` | `PUMP_TRADE_UNTRACKED` | `PUMPFUN_TRADE` plus its separate hint mint | that mint |
| No creation and trades reference more than one mint | `QUARANTINED` | `PUMP_SCHEMA_UNSUPPORTED` | none | sorted unique trade mints |
| Decoded create/trade evidence references more than sixteen unique mints | `QUARANTINED` | `PUMP_SCHEMA_UNSUPPORTED` | none | empty |
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
registries may become terminal quarantine evidence. Trusted locator failures
marked retryable, including transient RPC and block unavailability, reject the
whole group before any write. Any unknown, forged or untrusted exception also
rejects the group without being converted to a durable classification. Provider
messages, URLs, response bodies and exception causes never enter the ledger or
fingerprint.

## Evidence fingerprint and timestamps

The V1 evidence fingerprint is lowercase SHA-256 over unambiguous
length-prefixed UTF-8 segments. The segments contain:

1. the domain tag `pumpfun-catch-up-classification-v1`;
2. signature and decimal slot;
3. disposition, reason code, action hint and hint mint (or explicit `NONE`);
4. canonical sorted mints;
5. canonical decoded semantic actions ordered by normalized instruction cursor,
   represented as `CREATE:<mint>`, `BUY:<mint>` or `SELL:<mint>`, or the closed
   evidence marker used for failed, unsupported, schema, missing-signature or
   mint-limit outcomes. Mint overflow uses `MINT_LIMIT_EXCEEDED:<count>`.

This identity intentionally excludes `programIds`, confirmation status,
`blockTimeMs`, `observedAtMs` and `classifiedAtMs`. Program provenance and
finality converge separately in B1; wall-clock replay must not create a
classification conflict or extend retention.

The clock is sampled once for a classifier call. That finite safe integer is
used as both observation and classification time for every new value from the
call. `createCatchUpClassification` remains the final domain validator. A later
semantic replay may carry a newer clock value, but the repository preserves the
first stored `catch_up_classified_at`. For terminal `IGNORED` and `QUARANTINED`
rows it also preserves the original `terminal_at` and exact
`purge_after = terminal_at + 4 hours`.

## Repository replay correction

B1 currently treats `classifiedAtMs` as immutable and recomputes terminal
retention from a replay's new timestamp. B2b changes only that replay rule:

- `storedClassificationMatches` compares version, slot, disposition, reason,
  immutable action key, canonical mints and fingerprint, but not timestamps or
  finality;
- an existing classified row retains its first `catch_up_classified_at`;
- a terminal replay reuses stored `terminal_at` and `purge_after` exactly;
- actionable finality replay keeps the existing B1 reprocessing behavior;
- changed semantic evidence remains a `classification` conflict.

No database migration is needed because the stored shape and constraints do
not change. The correction only broadens accepted semantic replay while making
the four-hour retention deadline strictly non-extendable.

## Failure atomicity and restart behavior

Hydration and decoding produce an in-memory classification batch before writes.
A retryable locator failure therefore persists zero rows for its entire group.
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
group ordering, the all-hydrations-before-writes barrier, effective commitments,
create plus initial buy, mono-mint trade, failed transaction, no supported
action, multi-mint fail-closed quarantine, trusted schema/normalization and
missing-signature quarantine, retryable and untrusted group rejection, stable
fingerprints across time/finality, partial-write replay and deterministic
persistence order.

PostgreSQL 16 repository tests prove that a semantic replay with newer
`observedAtMs`/`classifiedAtMs` preserves the first classification, terminal and
purge timestamps, while a changed fingerprint or decision still conflicts.
Build, strict type-check, lint, documentation checks and whitespace validation
complete the PR. No test contacts a live RPC endpoint or imports signing and
submission code.

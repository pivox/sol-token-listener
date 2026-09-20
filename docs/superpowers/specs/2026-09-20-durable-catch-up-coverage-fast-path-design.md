# Durable catch-up coverage fast path

Status: approved for implementation
Version: 1.0.2
Issue: #146
Parent incident: #120
Scope: Pump.fun observe-only catch-up admission; no wallet, signer, executor,
armament, simulation or submission

Revision history:

- 1.0.0: initial coverage and failed-transaction fast-path design.
- 1.0.1: keep confirmation advancement on the existing finality replay path,
  make coverage a lock-free read-only batch compatible with tracked-mint
  synchronization, and fail closed on both directions of execution-outcome
  contradiction.
- 1.0.2: use a neutral coverage DTO, reject outcome-unknown terminal receipts
  on the direct-failure path, preserve compatible source reconciliation and
  clarify deterministic ordering and non-synthetic provenance.

## Context

The post-#145 Mainnet canary verified zero HTTP 429, bounded RPC concurrency,
idempotence, finality receipt parity, retention and RSS. It still failed with a
backlog growing from 54 to 4,881, a 90,722 ms first-processing p95 and only 136
processed transactions in fifteen minutes.

At T+5 the strict scan owned the provider-affine hydration permit and
`workerClaimReady` was false. At T+15 the WebSocket supervisor had no promoted
provider and `workerClaimReady` was still false. A page-budget pause closes the
candidate or incumbent by design and starts another bridge. The bridge cannot
finish when it hydrates every signature more slowly than Pump.fun produces the
next frozen interval.

The candidate WebSocket session is already open before its strict bridge. It
durably admits successful notifications before health is advanced. Rehydrating
the same exact signature from catch-up adds no losslessness. In addition, the
official Solana `getSignaturesForAddress` result includes `err`: `null` denotes
success and a non-null transaction error denotes failure. A failed transaction
cannot create a successful Pump.fun launch or trade and does not need a full
block download merely to recover that fact.

## Decision

Add an inactive, restart-only Pump.fun catch-up coverage fast path. For every
strict page, before block hydration:

1. snapshot the official per-signature execution outcome as the boolean
   `transactionFailed`; never retain or expose the provider error body;
2. persist a deterministic `SOLANA_TRANSACTION_FAILED` catch-up classification
   for failed discoveries without locating their block;
3. reconcile successful discoveries against durable inbox or terminal receipt
   identity;
4. return `ALREADY_ADMITTED` only for an exact, compatible durable identity;
5. hydrate and classify every remaining successful discovery using the existing
   provider-affine block path;
6. reassemble receipts in exact page order and let the existing scanner advance
   its durable cursor only after the whole page is covered.

The optimization changes neither the worker decoder nor the authority of
on-chain transaction decoding. A WebSocket row with `NONE` remains
`PENDING/NORMAL` and is fully decoded by the worker. The fast path only proves
that this exact signature already has durable work; it does not claim a launch,
trade, mint or qualification result.

## Activation envelope

The new configuration key is
`LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED`.

- default: `false`;
- accepted values: the existing strict boolean vocabulary only;
- `true` requires `EXECUTION_MODE=observe`;
- `true` requires `LISTENER_INGESTION_SCOPE=launchpad-only`;
- `true` requires `LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true`;
- a violated prerequisite fails configuration parsing;
- changing the value requires restart;
- no live execution setting is read or enabled.

Flag-off hydration, classification and receipt behavior remains compatible: the
classifier hydrates all discoveries as it does today. The internal source DTO
does gain the explicit immutable execution-outcome boolean.

## Source contract

`CatchUpSignature` and `MergedCatchUpDiscovery` gain the immutable boolean
`transactionFailed`.

The external RPC snapshot requires an own enumerable `err` data property. Its
value is observed exactly once and reduced immediately:

- `null` -> `transactionFailed=false`;
- a non-empty bounded string variant or non-null non-array object variant ->
  `transactionFailed=true`.

The value is never traversed, serialized, logged or persisted. Missing,
`undefined`, primitive non-string, array, symbol, bigint, function or
accessor-backed `err` values reject the source response. Duplicate discoveries
for the same signature must agree on slot and execution outcome. Confirmation
status and nullable block time retain the existing compatible reconciliation
rules; incompatible values remain a pagination/source failure.

Existing trusted fixtures must provide the boolean explicitly. This prevents
old tests or internal callers from silently defaulting an unknown outcome to
success.

## Durable coverage port

Add a neutral batch port used only by the Pump.fun page classifier:

```ts
interface CatchUpAdmissionCoverageRepository {
  readExistingCatchUpCoverage(
    candidates: readonly CatchUpAdmissionCoverageCandidate[],
    signal: AbortSignal,
  ): Promise<readonly CatchUpClassificationReceipt[]>;
}
```

The neutral port DTO contains only signature, slot, confirmation status and the
canonical program-ID set. It does not import the application-layer merged
discovery, block time or execution outcome. The method accepts successful
candidates only and returns receipts only for durably covered identities. The
caller derives the missing set by signature.

The PostgreSQL implementation uses one bounded read-only query for at most one
page. It acquires no advisory, mint or row lock and performs no update. This is
deliberate: `syncTrackedMint` owns the existing mint -> row order, and a batch
that held multiple row locks could deadlock with that writer. The query verifies
exact signature and slot against:

- `chain_transaction_inbox`, when the row has WebSocket provenance or an
  already persisted catch-up classification; or
- `chain_transaction_finality_replay_receipts`, when the terminal receipt is
  compatible.

For an inbox row, coverage is accepted only when WebSocket provenance or a
persisted catch-up classification already proves durable admission and the
incoming confirmation does not advance the stored target. A discovery that would advance
`processed -> confirmed`, `confirmed -> finalized`, or any other target is
reported as uncovered and follows the existing full classification/replay path;
the fast path must never create a `PROCESSED/finalized` row without its finality
replay receipt. Coverage does not add `CATCH_UP` provenance and does not change processing status, priority, hint,
attempts, lease, immutable snapshot, finality evidence, terminal timestamps or
paper state. The strict-run page cursor is the durable proof that catch-up
encountered an already admitted signature; the row remains correctly attributed
to the source that admitted it. For a terminal receipt it performs no mutation. It returns the existing canonical
`ALREADY_ADMITTED / NOT_ENQUEUED / null` receipt.

A successful discovery must not cover a stored catch-up classification whose
reason is `SOLANA_TRANSACTION_FAILED`. That inverse outcome contradiction fails
the whole batch rather than bypassing the immutable classification mismatch.
Likewise, the direct failed path rejects an existing WebSocket identity and
rejects every terminal replay receipt: the current terminal receipt schema does
not retain transaction outcome, so it cannot prove a compatible failure.
Same-outcome failed classifications remain idempotent. A later WebSocket
notification is proof of `err=null`; enqueue must reject a previously terminal
`SOLANA_TRANSACTION_FAILED` classification rather than silently retain
`IGNORED` and lose the successful observation.

An absent identity is not an error and yields no receipt. A slot conflict,
incompatible confirmation transition, malformed stored row, duplicate result,
unexpected source, or cancellation fails the entire batch. No partial page can
be reported as covered.

The method never inserts or updates an inbox row. Consequently an absent or ambiguous
successful signature always continues to full block hydration.

## Failed-transaction fast path

For `transactionFailed=true`, the classifier constructs the same version-1
classification produced today after hydrating a normalized transaction whose
`error` is non-null:

- disposition: `IGNORED`;
- reason: `SOLANA_TRANSACTION_FAILED`;
- no hint, mint or semantic action;
- evidence marker: `SOLANA_TRANSACTION_FAILED`.

The existing classification repository remains authoritative for replay,
identity, provenance, confirmation and four-hour retention. If a contradictory
WebSocket or terminal-success identity exists, the repository must fail closed;
it must not silently turn previously admitted successful work into ignored
work. Replaying the same failed classification remains idempotent.

## Page algorithm and ordering

With the flag enabled, `PumpFunCatchUpBlockClassifier.classify`:

1. snapshots and groups the input;
2. partitions failed and successful discoveries without reordering identity;
3. records failed classifications;
4. asks the coverage port for already durable successful identities;
5. hydrates only uncovered successful identities, retaining the existing
   per-slot single-flight behavior;
6. validates every returned receipt against the original signature and slot;
7. emits one receipt per discovery in the deterministic classifier-input order
   established by `mergeCatchUpDiscoveries`.

Receipt cardinality, duplicate signatures, missing results, extra results and
hostile return objects remain fail-closed. Cancellation is checked before and
after every awaited boundary.

## Observability

No signature, transaction error body, RPC URL or provider secret is exposed.
The existing bounded counters provide the canary proof:

- catch-up dispositions show failed transactions becoming `IGNORED`;
- block hydration `locates`, `fetches`, hits and misses show the avoided work;
- strict-run page/cursor progress proves the bridge convergence; per-signature
  source metrics continue to report the source that actually admitted work and
  do not claim synthetic catch-up provenance;
- `scanActive`, `workerClaimReady`, provider state and first-processing evidence
  show whether the bridge finishes.

No public schema version is changed in this PR. New cardinality-labelled metrics
are intentionally rejected.

## Rejected alternatives

### Two inbox workers first

Two workers can overlap pipeline work only while claims are allowed. They do not
help while a scan owns the permit or no provider is promoted, which was the
dominant canary state. Worker concurrency remains a later, separately measured
PR.

### Drop all WebSocket `NONE`

`NONE` includes truncated, malformed, CPI and otherwise ambiguous evidence.
Dropping it can lose creations or trades. It remains fail-open work.

### Raise RPC concurrency or cache limits

The canary already respected zero 429 and bounded memory. Raising capacity does
not remove duplicate bridge work and can regress RSS or exit capacity.

### Treat a failed source row as success

A non-null `err` is only proof that the transaction failed. It can be persisted
as ignored evidence, never as a processed launch or trade.

## Tests and acceptance

- strict RPC snapshots require `err` and reduce it without traversing content;
- merge rejects contradictory execution outcomes;
- flag defaults false and rejects every unsafe activation envelope;
- flag off preserves locator calls and receipts;
- flag on skips hydration for exact WebSocket and classified coverage;
- exact terminal receipt coverage is accepted;
- absent successful rows are hydrated;
- failed rows are recorded without locator calls;
- failed/source-success contradictions fail closed;
- mixed pages preserve input receipt order and exact cardinality;
- cancellation, replay, slot conflict and hostile repository results fail
  closed;
- PostgreSQL integration proves one bounded read-only batch, no row/mint lock,
  idempotent replay, finality compatibility, finalized-upgrade fallback to the
  existing replay path and no mutation of provenance/priority/status/finality
  evidence, including concurrency with `syncTrackedMint` and both directions of
  failed/success outcome contradiction, terminal-receipt rejection on the
  failed path, and WebSocket-after-failed-classification rejection;
- build, strict checks, lint, unit tests, PostgreSQL integration tests,
  documentation checks and deployment contracts pass;
- a separate post-merge Mainnet observe-only canary must prove the operational
  backlog and latency gates before H2e, H2c or any wallet access.

# Mainnet Terminal Attribution

Date: 2026-09-27

Issue: #170

Status: approved for implementation

Contract revision: 1.0.0

## Purpose

The 15-minute Mainnet observe-only canary on `main@efe4bd6` produced no HTTP
429, but ended with 707 `FAILED`, 166 `QUARANTINED`, 611 exhausted retries and
a growing backlog. The current evidence cannot identify every trusted failure:
catch-up folds authenticated Pump.fun decoder errors into
`PUMP_SCHEMA_UNSUPPORTED`, retries clear the previous row error, and the
canary gate can classify real failures as inconclusive.

This change adds bounded, deterministic and sanitized attribution before the
next canary. It does not change decoding decisions, retryability, scheduling,
worker counts, RPC capacity, wallet handling or transaction submission.

## Invariants

- Existing `IngestionFailure`, pipeline origin and retry contracts stay exact.
- `UNKNOWN` remains the only retryable observed-pipeline origin.
- Attribution is observational: capture or persistence failure cannot change a
  pipeline result, but missing evidence prevents a canary PASS.
- Trust comes only from exact identities registered at internal boundaries.
  Names, messages, causes, prototypes, SQL-like properties and hostile proxies
  confer no authority.
- No raw bytes, account lists, mint, wallet, provider payload, stack, URL,
  header, local path or free text enters an aggregate, log or API response.
- No Mainnet/RPC call, signer, wallet, armament or submission is used in tests.

## Selected architecture

### Separate trusted sidecar

A new internal terminal-attribution module owns exact-identity `WeakMap`
registries for:

- immutable diagnostic evidence attached to trusted runtime errors;
- inheritance onto trusted internal wrappers;
- immutable evidence attached to the exact frozen worker failure or catch-up
  classification passed to the repository.

The existing error objects and three-field `IngestionFailure` are not extended.
The existing pipeline origin taxonomy is not extended with diagnostic codes.
Thus attribution cannot accidentally change retryability or decoder quarantine
policy.

### Durable occurrence journal

Migration 057 adds one append-only, four-hour-retained terminal-attribution
table keyed by a deterministic occurrence identity. A row records only closed
and bounded columns:

- inbox signature foreign key and source `WORKER` or `CATCH_UP`;
- processing outcome and worker attempt/cycle where applicable;
- observed pipeline stage and authenticated origin when available;
- one closed diagnostic code or explicit `UNAVAILABLE`;
- optional bounded Pump wire identity;
- completeness state and database capture time.

The table cascades with inbox retention. Repository writes are in the same
transaction as `markFailed` or catch-up classification. A duplicate replay
upserts the same deterministic occurrence; it cannot multiply evidence.
Failure to derive optional runtime evidence stores an explicit unavailable
record when the terminal write itself can safely do so. It never turns a
successful terminal write into a different business decision.

Occurrences are deliberately separate from current inbox rows. A later claim
clears current error fields, and a later success can make the inbox row
nonfailed, while the bounded occurrence remains available for canary
diagnostics.

### Current population versus occurrences

`mainnet-terminal-attribution.v1` contains two reconciled sections:

1. `currentPopulation`: every current `FAILED` and `QUARANTINED` row, grouped by
   status, closed normalized error name, retryability, terminal/exhausted state,
   attempts and catch-up reason;
2. `diagnosticOccurrences`: journal rows grouped by source, stage, trusted
   origin, closed diagnostic and optional wire shape.

The artifact publishes exact totals, retained-group totals, overflow totals and
unavailable totals. It never implies that occurrence count equals current row
count. Unknown historical rows remain explicitly unavailable; free text is
never reverse-engineered into trusted evidence.

## Closed diagnostic taxonomy

Wallet graph diagnostics:

- `WALLET_GRAPH_POSTGRES_SERIALIZATION`
- `WALLET_GRAPH_POSTGRES_DEADLOCK`
- `WALLET_GRAPH_LAUNCH_MISSING`
- `WALLET_GRAPH_DATA_INVALID`
- `WALLET_GRAPH_ANALYSIS_INVALID`
- `WALLET_GRAPH_PERSISTENCE_UNKNOWN`

PumpSwap diagnostics:

- `PUMPSWAP_MUTABLE_RPC_UNAVAILABLE`
- `PUMPSWAP_RPC_CONTEXT_INVALID`
- `PUMPSWAP_MUTABLE_ACCOUNT_DECODING`
- `PUMPSWAP_MARKET_POOL_MISMATCH`
- `PUMPSWAP_MARKET_POOL_NON_CANONICAL`
- `PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION`
- `PUMPSWAP_PERSISTENCE_UNKNOWN`

The generic fallback is `UNAVAILABLE`, not arbitrary runtime text. PostgreSQL
SQLSTATE `40001` and `40P01` may be translated only around a trusted repository
query rejection. An arbitrary callback error carrying a forged `code` is not
trusted. PumpSwap mutable-RPC wrappers continue to remove decoder terminal
authority; diagnostic evidence is independent of that decision.

## Pump.fun wire evidence

For authenticated `PUMP_BORSH_INVALID`, the diagnostic group may contain:

- surface `INSTRUCTION` or `CPI_EVENT`;
- location `OUTER` or `INNER`;
- official eight-byte discriminator in lowercase hex;
- pinned IDL name or `UNKNOWN_DISCRIMINATOR`;
- total and payload byte lengths;
- suffix length or explicit `UNAVAILABLE`.

Instruction payload starts after eight bytes. A CPI event uses the second eight
bytes after the Anchor CPI tag, and payload starts after sixteen bytes. Suffix
length is recorded only where a decoder has reached its existing explicit
suffix boundary. Generic reader remainder after a failed field is not called a
suffix.

The transaction decoder attaches cursor identity only to the exact instruction
that threw. Unknown discriminators keep their current null/no-error behavior.
No new layout or discriminator is accepted by this PR.

One canonical public-chain provenance locator may be retained per diagnostic
group in the local artifact: signature, slot, transaction index, confirmation
status and instruction cursor. It is selected lexicographically and contains
no account, mint, wallet or raw instruction. It is evidence for a future
sanitized fixture, not itself a finalized fixture.

## Catch-up distinctions

Before catch-up flattens a failure to its existing durable reason, it records a
closed cause kind:

- authenticated Pump decoder origin;
- locator signature/index failure;
- normalization failure;
- Pump mint-limit overflow;
- ambiguous multi-mint trade.

The durable catch-up disposition, reason, action key and fingerprint remain
unchanged. A reason such as `PUMP_SCHEMA_UNSUPPORTED` is never used alone to
infer a decoder error.

## Deterministic capture

The capture CLI runs after listener shutdown and before retention/teardown in a
single read-only `REPEATABLE READ` PostgreSQL snapshot. It:

- reads all current `FAILED` and `QUARANTINED`, not only exhausted rows;
- reads the bounded diagnostic occurrence journal;
- validates exact schemas and safe integers;
- sorts keys and representatives by canonical bytewise tuples;
- retains at most 128 groups per section and one representative per wire group;
- caps the serialized artifact at 1 MiB;
- reports every dropped group/occurrence through exact overflow counters;
- emits byte-identical JSON for the same database snapshot.

The output file is created exclusively, without following a symlink, with mode
`0600`; ownership, regular-file type, mode and final byte count are verified.
The CLI never prints the artifact, its provenance or database errors. Logs and
API may expose only aggregate counts without representatives.

## Canary gates

- The terminal gate independently fails when the final snapshot contains any
  new terminal `FAILED` row or exhausted retry, even if attribution is absent
  or malformed.
- Retry-pending `FAILED` rows are counted but are not mislabeled terminal.
- The decoder gate cannot PASS when authenticated `PUMP_BORSH_INVALID` or a
  catch-up decoder quarantine is present.
- Missing, malformed, unreconciled or overflowed required attribution is
  fail-closed; it cannot downgrade proven failure to inconclusive or pass.
- Valid worker rows need no catch-up reason, and valid catch-up quarantines need
  no worker error code.

## Deterministic wallet-graph reproduction

A PostgreSQL integration test uses two real worker clients and explicit promise
barriers. Worker A begins `REPEATABLE READ`, takes the same-mint advisory lock,
writes and pauses before commit. Worker B begins `REPEATABLE READ`, submits the
same lock, and an observer proves through `pg_locks`/`pg_blocking_pids` that it
is blocked. Only then may A commit. B continues with its old snapshot and must
reproduce real SQLSTATE `40001`, attributed to
`WALLET_GRAPH_POSTGRES_SERIALIZATION`.

The test uses bounded query-driven polling and no sleeps. This PR does not
change isolation, locking, concurrency or retries; any correction follows in a
separate proof-driven PR.

## Migration and privileges

Migration 057 supports empty install, upgrade from 056, immediate replay and
strict named-object drift detection. It creates the journal, bounded indexes,
constraints, four-hour purge integration and minimum listener grants. `PUBLIC`
has no access. Raw-chain and business projections are unchanged.

## Acceptance

- artifact is deterministic byte-for-byte, bounded, redacted and fail-closed;
- every current failed/quarantined row and every captured occurrence reconciles
  to exact totals or explicit overflow/unavailable counters;
- worker/catch-up, instruction/CPI and outer/inner are distinct;
- closed wallet/PumpSwap diagnostics cannot be forged;
- hostile values and logger/observer failures do not affect pipeline outcome;
- deterministic two-worker PostgreSQL reproduction passes without sleep;
- migration install/upgrade/replay/drift and four-hour retention pass;
- terminal and decoder canary gates enforce the rules above;
- build, check, lint, docs, full tests, migration replay and diff checks pass;
- no wallet, signer, executor, armament, submission or live RPC is touched.

## Out of scope

- decoder layout changes or relaxed Borsh validation;
- retry, worker, cache, RPC or scheduler changes;
- wallet-graph/PumpSwap behavioral fixes;
- public provenance through logs, API or frontend;
- a new Mainnet canary before merge and green post-merge CI.

## Next step

After merge, rerun the 15-minute observe-only canary with this capture. Create a
separate correction only for a reproduced and attributed cause, then repeat the
canary before H2e/H2c readiness.

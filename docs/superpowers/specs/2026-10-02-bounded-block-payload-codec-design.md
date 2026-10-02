# Bounded block transaction payload codec — v1.0.0

## Scope and decision authority

Narrow capacity correction for #171/#120 after #210. Evidence:
[three complete blocks on Node22](2026-10-02-block-payload-measurement-results.md).
Standing user direction approves recommended technical choices without another
question round; one review cycle per PR. Version this design before code.
No wallet, signer, database migration, dependency upgrade or transaction execution.

All three current snapshots exceed the unchanged 8 MiB entry cap. Independent
deflate level1 payloads reduce them by about 70%, with exact normalized round trips.
This motivates implementation tests, not a claim of sustained capacity.

Alternatives considered:

1. Recommended: per-transaction compression, immutable text, bounded inflation.
   Small change at existing serialization boundaries; CPU cost must be measured.
2. Whole-block compression: better cross-transaction redundancy, but expands all
   transactions to locate one and worsens repeated-read allocation. Rejected.
3. Larger cache or binary mutable buffers: more memory or a new ownership model;
   neither follows the measured narrow correction. Rejected for this change.

## Module and format

Add `src/solana/rpc/block-transaction-payload-codec.ts`, depending only on Node
crypto, zlib, v8 and existing normalized types. It exports a small encode/decode
boundary and named immutable limit constants. No RPC or cache lifecycle imports.

Each payload remains a primitive string, with exact ASCII format:
`b1:<r|d>:<decoded-byte-length>:<sha256-hex>:<canonical-base64>`.
`r` stores raw V8 bytes; `d` stores raw-deflate level1 bytes. Length is positive
canonical decimal; hash is exactly 64 lowercase hex characters. Hash covers the
original V8 bytes, not compressed bytes. No external serialized cache is loaded.
The version is process-local, not a persisted API or wire-format compatibility
promise across Node versions. Cache is empty on restart; no legacy-format parser.

Encode a normalized transaction once using V8, then choose deflate only when the
complete tagged string is strictly smaller than the raw tagged string. Keep raw
when equal/larger or outside compression budgets. Do not remove fields, coerce
bigints, or keep provider graphs/closures/binary buffers in retained entries.
Avoid constructing both tagged strings when comparing their predictable lengths.

## Bounds and failure behavior

- At most 1,048,576 original V8 bytes per compressed payload.
- At most 33,554,432 original V8 bytes submitted to compression per block.
  Count every attempted input, including unsuccessful savings. Snapshot-local
  budget, not global mutable state; later payloads use raw format when exhausted.
- Larger original payloads remain raw and preserve existing selection semantics.
  Their raw decoding allocation is existing behavior, not an inflation exemption.
  Existing oversize/nonretention and malformed-block behavior remain authoritative.
- Before base64 allocation, validate format, canonical length, mode and encoded
  length. For compressed mode, declared original length must fit the 1 MiB cap
  and encoded length must not exceed the raw canonical-base64 bound for that size.
- Inflate with `maxOutputLength` equal to declared original length; reject length
  mismatch, corrupt stream, noncanonical base64, unknown version/mode or digest
  mismatch before V8 deserialization. Test valid-but-altered streams as well as
  simple truncation. Fixed redacted typed errors; no payload/error-body logging.
- Decoder operates only on trusted process-created payloads. Hash validation is
  corruption detection, not authentication of arbitrary input or V8 object schemas.
- Select and decode one transaction only. Return a fresh deserialized object on
  each locate, preserving existing mutation isolation and requested confirmation.
- A decode failure evicts the entry and follows existing trusted
  TransactionNormalizationError handling; never triggers an extra RPC or silently
  returns partial data. An encode/normalization failure remains a null payload and
  disables retention, as today; no new fallback provider or success fabrication.

These limits bound compression input and compressed expansion, not total RPC JSON
allocation, normalized object graph size, RSS or elapsed time. Synchronous zlib
can block the event loop; stress evidence and canary p95 remain required.

## Integration and accounting

`snapshotBlockTransactionData` replaces direct serialize/base64 with encoding,
maintains the per-block compression budget and keeps its public snapshot shape.
`CachedSolanaBlockTransactionLocator.locate` replaces direct deserialize with
decode; cache admission, fetch and lifecycle logic are unchanged.

Snapshot accounting remains `64 + sum(signature UTF-8 bytes + payload.length + 32)`.
Tagged payload length includes all format metadata, hash and base64. This is exact
logical retained accounting under the existing model, not JS heap measurement.
Defaults stay 8 MiB/entry, 64 MiB/global, 64 entries, 250 ms minimum fetch spacing,
existing TTLs and one physical cache fetch. Genuine oversize remains a bypass.
No changes to configuration flags, metrics schema, provider epochs, generations,
clear/close, queued admission, single-flight, trust branding or cache key identity.

## Acceptance and tests

TDD first: codec tests must fail before production code. Cover bigint, typed byte
arrays, null/error/log values, round-trip equality and independent returned graphs;
incompressible fallback; exact 1 MiB boundary and above; exact block budget and
exhaustion; canonical tags/base64; hashes; invalid lengths; corrupt/oversized
expansion; and errors without sensitive data. Prefer helper-level deterministic
byte fixtures for exact size tests rather than guessing V8 object overhead.

Integration tests must demonstrate a compressible block larger than 8 MiB in the
old representation retained under the real 8 MiB cap, then a second signature hit
without another RPC. Preserve real incompressible oversize bypass and same-flight
sharing. Verify exact accounting including tags, equality/one-byte-over cap and
global LRU eviction, malformed unrelated transaction behavior, duplicate handling,
legacy/v0/v1, confirmation isolation, epoch/clear/close and fresh-object mutation.
All existing tests remain enabled; no caps loosened or assertions removed merely
because encoded sizes change. Regenerate dynamic size fixtures where appropriate.

After build, replay the existing captures offline through the actual new snapshot
and decoder under pinned Node22. Verify all 4,220 transactions and aggregate
accounting; compare runtime/memory with the baseline without making single-run
percentile claims. No extra RPC capture is authorized by this design.
Run build/check/lint/full backend PostgreSQL/frontend suites as repository gates;
one code-review cycle, corrections and green CI before merge. Observe the <=5 GB
disk pause rule, one test database/container at a time, preserve useful evidence.

After merge, remaining measurement-clock and instruction-suffix blockers still
need resolution before the 15-minute canary. H2e/H2c and human transaction-specific
authorization are unchanged. This PR alone cannot establish readiness to trade.

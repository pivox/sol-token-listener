# Mainnet classification throughput — capacity evidence gate v1.1.1

Issue: [#218](https://github.com/pivox/sol-token-listener/issues/218).
Base: `origin/main@8a99152f776b55ebff167323a17a5d4b336c76de`.
This is an evidence-stage design. It does not authorize wallet access,
transaction submission, higher RPC concurrency, weaker canary gates, or
acceptance of the separate 24-byte `TradeEvent` wire form (#215).

## Observed failure and bounded diagnosis

The exact 15-minute observe-only canary on `ced66e7` remains FAIL. On the
post-#217 exact `8a99152` commit, two short observe-only probes had zero HTTP
429 but classification backlog grew. In the second probe, 3,331 cache locates
comprised 27 hits and 3,304 misses; the misses comprised 2,908 in-flight
joins and 396 physical block fetches. Queue delay was at most 1 ms, with no
forced refresh, oversize bypass or fetch failure. Seven completed page
admissions took 203,573 ms cumulative; classification pending was 1,742 at
T+5. These probes are diagnostic, not a canary PASS. Their task-owned raw
artifacts and PostgreSQL data were deleted after bounded aggregate retention.

The source has only signature, slot, status, time and failure status. It
cannot prove instruction identity before transaction hydration. The existing
coverage fast path was **enabled** in both probes and already skips only
source-proven failed transactions or exact durable coverage. The block cache
coalesces same-slot/same-finality callers, and the classifier already starts
next-slot hydration while writing the current slot. No further signature
filter, cross-finality cache reuse or silent backlog truncation is justified.

## Why a concurrency flag is not a sufficient fix

- The block-cache pump awaits each physical fetch. The classifier admits one
  distinct slot/status group, and `HydrationGroupAdmission` explicitly permits
  one group or an unbound worker reservation. A cache-only value of two would
  not create two useful unique block fetches.
- With multiple workers, `ListenerRpcWorkGate` serializes physical block and
  market reads. It is not a per-provider rate budget: scanner source,
  finality, pinned block RPC and health use separate connections to the same
  provider. The 250 ms spacing limits block starts, not their combined RPC
  attempts or reserved live-exit capacity.
- The heartbeat schema and the 19-gate canary verdict require
  `callerConcurrency=1` and at most one in-flight/queued fetch. A genuine
  multi-fetch mode needs a versioned observability and verdict contract, not
  an unreported bypass.
- Cache byte limits constrain retained snapshots, not concurrent raw
  `getBlock(full)` responses or parsing memory. Shutdown detaches started
  flights, so wider concurrency also needs cancellation, provider-switch,
  orphan/finality and RSS proofs.

## Evidence required before implementation

1. Record the actual Helius project/plan and fresh monthly credit quota via
   the existing H2e path. H2e's Admin `/usage` projection contains billing
   credits and a plan ID, **not** a per-project RPS, concurrency or live-exit
   allowance. Independently obtain a dated, authoritative per-project RPC
   rate-limit source from Helius dashboard, API or support, including custom
   limits if applicable; otherwise instantaneous capacity remains
   `INCONCLUSIVE` and no wider admission mode may be selected. Public
   [Helius pricing](https://www.helius.dev/pricing) and zero observed 429 are
   not project-specific capacity proof. The current local configuration has
   no `HELIUS_PROJECT_ID`, H2e API-key file or dedicated attestation key. Do
   not infer them from the RPC URL or publish credentials.
2. Capture bounded per-provider total attempts, 429, latency and maximum
   simultaneous response/parse memory for source, finality, block, worker,
   health and any other listener traffic, on an exact clean commit. Record
   workload mix and reserve a separately justified exit budget. A test with
   zero 429 is necessary but insufficient.
3. Choose and version one specific option: a shared per-provider admission
   budget with worker/exit priority and at most two distinct block groups,
   or a different source that supplies authoritative transaction identity
   without increasing requests. Do not ship a cache-only concurrency knob.

## Rollout and acceptance for a follow-up implementation

Default behavior stays observe-only and single-group. RED tests precede any
implementation. Tests must cover provider affinity, source/finality/worker
fairness, exact group keys, cancellation, failover, duplicate elimination,
commitment promotion, orphan reconciliation, response-size/RSS bounds and
shutdown. Version heartbeat/API/verdict evidence without weakening the
requirements for backlog, age, zero 429, finality, idempotence, retention,
RSS, terminal failures and cleanup. An opt-in short probe must show a causal
gain within an attested budget. Only after one independent review cycle, green
CI and merge may a fresh exact-merge 15-minute observe-only canary be assessed.
H2d/H2c, wallet and live-trade gates remain closed until that canary passes.

## Additive RPC role evidence — instrumentation slice v1.1.1

The first implementation slice measures physical HTTP fetches without changing
admission, retry, failover, decoding, orders or the existing exact-shape
`rpcHttpEvidence` V1 contract. A sibling, optional `rpcHttpRoleEvidence` V1
snapshot is persisted in the existing heartbeat JSONB and projected through
`/api/v1/health`; no SQL migration or new RPC call is needed. Absence projects
as `null`; malformed stored evidence fails health projection closed, while
overflow marks the capacity analysis `INCONCLUSIVE`. None is an implicit zero
or a canary PASS. The current 19-gate verdict continues to
consume only the unchanged `rpcHttpEvidence` V1 zero-429 evidence.

The sidecar has fixed provider IDs and four honest, fixed-cardinality roles:
`SOURCE`, `FINALITY`, `BLOCK_HYDRATION`, and `SHARED_CLIENT`. The last role
includes mixed worker, market and health calls from the existing shared
connection; it must not be labelled as any one of those traffic classes.
`BLOCK_HYDRATION` is one physical cache path used by both classifier and
worker, not separate per-caller requests. Each provider/role cell records
attempts, HTTP responses, 429 responses, fetch failures, completed
time-to-headers histogram buckets, the maximum time-to-headers and maximum
physical fetches in flight. Each failover retry is attributed to the provider
actually attempted. Measurements are monotonic, bounded integers; snapshots
contain no endpoint, method, request body, signature, error text or key.

This sidecar measures fetch start to HTTP headers only. Solana SDK response
body download/JSON parse time and transient response/parse memory are outside
its scope and require separate evidence before a throughput change. Likewise,
other processes sharing a Helius key remain invisible. Its purpose is to
identify RPC traffic mix and latency, not to infer a project rate limit or
exit reserve. Tests must prove failover attribution, abort/error decrement,
overflow behavior, strict projection, persistence, and unchanged V1 canary
handling. No concurrency flag may be turned on by this slice.

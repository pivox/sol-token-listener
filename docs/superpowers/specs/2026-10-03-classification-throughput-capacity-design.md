# Mainnet classification throughput — capacity evidence gate v1.2.0

## Operator capacity policy amendment v1.2.0 (2026-10-03)

The operator has explicitly selected a **local experiment policy**, not a
project-specific Helius attestation: nominal Free plan 10 RPC requests/s,
2 requests/s non-borrowable for a future emergency exit, and at most
8 ordinary physical HTTP RPC attempts in every rolling second. The separate
Free-plan `sendTransaction` cap is 1/s and is never included in, or enabled by,
this observe-only work. The transport budget must be shared by all listener
connections and provider roles; failover retries consume an additional
attempt. The same API key may be used by unknown external processes, so this
local cap does **not** prove provider-wide exit capacity or H2e/H2c readiness.

Implementation is staged and defaults OFF until the complete contract is
verified. First, add a bounded, abortable shared ordinary-attempt admission
budget at the physical HTTP fetch boundary (source, finality, block and shared
client). It must not reserve a token for an aborted request or record an HTTP
attempt before admission. No in-process queue may grow without bound, and
shutdown must reject waiters. Existing fetch timeout includes queue time.
Second, version a V2 block-hydration admission/heartbeat/API/canary contract
that explicitly permits two distinct slot/status groups while preserving the
V1 one-group exact shape and all 19 existing pass/fail gates. Third, enable at
most two groups only under explicit opt-in and the shared budget, while
retaining provider affinity, exact finality keys, ordered durable writes,
idempotence, worker fairness, cancellation, response-memory bounds and
rollback to V1. A short controlled observe-only comparison starts at two
hydrations in flight; three or four require a new measured amendment, not
an implicit escalation. A full fresh exact-merge 15-minute canary remains
mandatory. Zero observed 429 alone is not a PASS.

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

## Evidence required before live-readiness claims (historical v1.1.2 checklist)

1. Record the actual Helius project/plan and fresh monthly credit quota via
   the existing H2e path. H2e's Admin `/usage` projection contains billing
   credits and a plan ID, **not** a per-project RPS, concurrency or live-exit
   allowance. Independently obtain a dated, authoritative per-project RPC
   rate-limit source from Helius dashboard, API or support, including custom
   limits if applicable; otherwise provider-wide capacity remains
   `INCONCLUSIVE` and no live-readiness claim may be made. The v1.2.0
   operator policy above permits only a bounded, observe-only local trial. Public
   [Helius pricing](https://www.helius.dev/pricing) and zero observed 429 are
   not project-specific capacity proof. The current local configuration has
   no `HELIUS_PROJECT_ID`, H2e API-key file or dedicated attestation key. Do
   not infer them from the RPC URL or publish credentials.
2. Capture bounded per-provider total attempts, 429, latency and maximum
   simultaneous response/parse memory for source, finality, block, worker,
   health and any other listener traffic, on an exact clean commit. Record
   workload mix and the operator's non-borrowable local exit headroom. A test with
   zero 429 is necessary but insufficient.
3. Choose and version one specific option: a shared per-provider admission
   ordinary-attempt budget with at most two distinct block groups,
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
gain within the operator's bounded local policy; provider-wide capacity
remains unproven until H2e and independent rate-limit evidence. Only after one independent review cycle, green
CI and merge may a fresh exact-merge 15-minute observe-only canary be assessed.
H2d/H2c, wallet and live-trade gates remain closed until that canary passes.

## Additive RPC role evidence — instrumentation slice v1.1.2

The first implementation slice measures physical HTTP fetches without changing
admission, retry, failover, decoding, orders or the existing exact-shape
`rpcHttpEvidence` V1 contract. A sibling, optional `rpcHttpRoleEvidence` V1
snapshot is persisted in the existing heartbeat JSONB and projected through
`/api/v1/health`; no SQL migration or new RPC call is needed. Absence projects
as `null`; malformed stored evidence fails health projection closed, while
overflow marks the capacity analysis `INCONCLUSIVE`. None is an implicit zero
or a canary PASS. The current 19-gate verdict continues to consume only the
unchanged `rpcHttpEvidence` V1 zero-429 evidence. Its input manifest has exact
snapshot/STOPPED keys: inserting `rpcHttpRoleEvidence` there is correctly
rejected as `INVALID_EVIDENCE`. The existing canary runbook must continue to
project only its closed V1 fields; role evidence may be captured separately
as an aggregate diagnostic and never used to turn a failed gate into PASS.

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

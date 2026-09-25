# Bounded transaction-inbox worker pool design

Status: proposed for issue #166  
Version: 1  
Parent: #120  
Operational gate: #149 section 5

## Problem

The Mainnet observe-only canary on `e12d301` showed zero HTTP 429 responses and
healthy resource bounds, but the actionable inbox backlog grew from 127 to
16,213 while first-processing p95 reached 813,522 ms. Provider-affine block
hydration now permits safe worker progress during a same-provider periodic
scan, but the production listener still runs exactly one serial
`TransactionInboxWorker`.

The application needs bounded internal parallelism without increasing the
provider-affine HTTP request concurrency, weakening leases, or changing any
wallet or execution path.

## Decision

Introduce a `TransactionInboxWorkerPool` runtime component containing between
one and four existing `TransactionInboxWorker` instances. The configurable
`LISTENER_WORKER_COUNT` defaults to one, preserving current production
behaviour until an operator explicitly raises it.

Every member shares the same PostgreSQL inbox repository, provider-affine
locator, global block cache and observed-transaction pipeline. PostgreSQL's
durable scheduler and `FOR UPDATE SKIP LOCKED` claims remain the authority for
work allocation. Each member retains its own lease token and renewal guard.

The shared `ProviderAffineCatchUpHydration` remains the only worker HTTP route.
Its admission coordinator and global block cache keep one fetch start at a
time, enforce pacing and allow concurrent members targeting the same slot to
join one in-flight request. Increasing the worker count does not change the
reported `callerConcurrency=1` contract.

A shared FIFO `ListenerRpcWorkGate` of capacity one is placed in front of both
the worker locator and the PumpSwap account reader used by the observed
pipeline. This matters because a hydrated transaction can trigger additional
market-account reads after the block lookup. The gate prevents a second pool
member from adding HTTP concurrency during that phase as well. Other existing
runtime components keep their current behaviour; this PR adds no new HTTP
caller.

## Configuration

`LISTENER_WORKER_COUNT` is an integer in `[1,4]` with default `1`. It is
forwarded only to the listener application service, documented in
`.env.example`, exposed as an effective non-secret startup value and covered by
deployment contracts. Invalid, fractional or out-of-range values fail closed
during configuration parsing.

Counts above one require `LISTENER_BLOCK_HYDRATION_ENABLED=true`; otherwise
configuration fails closed because same-block single-flight cannot be
attested. The first external canary uses count two. Counts three and four are
considered only after fresh backlog, p95, RSS, lease and RPC evidence.

No migration is required. A single global claim-scheduler row remains durable
and serializes fairness counter updates across all pool members.

## Lifecycle and state

The pool is one `ListenerRuntime` component.

- `start()` starts every configured member exactly once.
- `RUNNING` requires all members to be running.
- any degraded or unexpectedly stopped member makes the aggregate state
  `DEGRADED`.
- `close()` first requests closure of every member, then awaits every member
  with `Promise.allSettled` semantics so one failure cannot prevent another
  lease from draining.
- the provider-affine hydration/cache is closed only after every member has
  settled. If a member close fails, hydration is still closed and the pool
  reports a typed, redacted failure.
- repeated `start()` and `close()` calls are idempotent; a closed pool cannot
  restart.

The existing listener shutdown timeout remains the outer fail-closed bound.

## Ordering and projection coherence

Parallel claims do not permit a trade to overtake an unknown launch:

1. Pump.fun trades for an untracked mint remain `DEFERRED` and are not
   claimable.
2. The creation pipeline commits `token_launches` before `syncTrackedMint`
   activates those deferred trades under the existing per-mint inbox lock.
3. Later trade pipelines may overlap remaining creation work, but participant,
   wallet-graph and qualification rebuilds already serialize per mint and load
   canonical committed inputs. A later rebuild therefore includes every
   committed event instead of applying a stale delta.
4. Signature identity, immutable snapshots, lease ownership and terminal
   finality receipts remain unchanged.

The pool does not add an in-memory ordering authority. PostgreSQL remains the
restart-safe source of truth.

## Invariants

- worker count is bounded to four and defaults to one;
- no inbox signature can be owned by two live leases;
- claim fairness remains the durable 32:1 urgent/normal and 3:1 launch/tracked
  policy;
- provider-affine HTTP fetch concurrency remains one;
- worker locator and PumpSwap account reads share one FIFO HTTP-work gate;
- same-slot hydration joins the existing global in-flight request;
- provider, epoch or promotion-revision changes reject stale hydration results;
- shutdown drains all member leases before closing hydration resources;
- logs, health and errors expose no provider endpoint or credential;
- no wallet, signer, arming, executor or transaction-submission path changes.

## Verification

Unit tests cover bounds, default compatibility, aggregate lifecycle/state,
parallel member progress, complete drain after one close failure and
idempotence. Gate tests prove that worker locator and market reads never
overlap, including rejection paths. Existing cache/hydration tests attest
same-slot reuse and one HTTP caller. PostgreSQL integration tests retain concurrent `SKIP LOCKED`
claim uniqueness, durable fairness and deferred-trade activation. Production
factory tests cover member count, shared dependencies and hydration-after-pool
shutdown ordering. Configuration, startup log, Compose and deployment smoke
contracts cover the effective setting.

After merge, the 15-minute Mainnet observe-only canary is repeated with a
bounded count selected from local evidence. This PR alone does not mark the
backlog, latency or finality gates as passed.

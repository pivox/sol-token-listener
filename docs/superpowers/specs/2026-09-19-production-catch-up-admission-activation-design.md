# Production Catch-up Admission Activation Design

Version: 1.0.2 — 2026-09-19 — issue #137, sub-task 120-B3b.

## Goal and status

Activate the page-level Pump.fun catch-up classifier and admission path built by
120-B1, B2 and B3a in the production listener. Activation is restart-only,
disabled by default and limited to observation. This design does not authorize a
wallet, executor, armament or transaction submission.

The existing behavior remains byte-for-byte selectable by leaving
`LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false`. A Mainnet
observe-only canary is a post-merge operation and is not evidence supplied by
this pull request.

## Decision

Use one provider-affine hydration coordinator around one
`CachedSolanaBlockTransactionLocator`. The coordinator serializes block access,
pins each strict scan to the provider that supplied its signature page, and
invalidates the cache epoch whenever that provider context changes.

The alternatives are rejected:

- the current global failover RPC may hydrate a page from a different provider;
- one cache per provider can exceed the global four-fetches-per-second budget
  and multiplies the retained raw-block memory bound;
- injecting the B3a admitter without coordinating the worker permits mixed
  provider evidence and competes for the same RPC capacity.

## Configuration contract

Add the exact boolean variable:

```dotenv
LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false
```

Only the canonical text `true` activates the path. The value is read once by
`parseConfig`; no hot reload exists. When it is false, configuration and factory
behavior remain compatible with the current production listener.

When it is true, configuration fails before database or network access unless
all of these conditions hold:

- `LISTENER_ENABLED=true`;
- `EXECUTION_MODE=observe`;
- `LISTENER_INGESTION_SCOPE=launchpad-only`;
- `LISTENER_CATCH_UP_POLICY=live-edge`;
- `LISTENER_BLOCK_HYDRATION_ENABLED=true`;
- `SOLANA_EXPECTED_GENESIS_HASH` is the canonical configured cluster hash;
- every configured provider has one valid matching HTTP/WebSocket pair.

Rollback consists of setting the flag to `false` and restarting the listener.
The durable classification and admission receipts remain valid historical
evidence and continue to expire according to their existing four-hour rules.

## Provider-affine hydration coordinator

Create `ProviderAffineCatchUpHydration`. It owns:

- a read-only block RPC instance for each catalog provider;
- a routing RPC whose `httpTransportEpoch` is monotonic;
- exactly one `CachedSolanaBlockTransactionLocator`;
- one bounded FIFO admission queue shared by the worker and strict scanners;
- the current promoted provider selection and its revision;
- the active scan provider, if any;
- close and cancellation state.

The existing cache remains the only source of fetch pacing. Production keeps
one active fetch and `listenerBlockHydrationFetchIntervalMs >= 250`, therefore no
more than four fetches start per second across all providers and callers.
Every provider-pinned `getBlock` continues to use the official `Connection`,
but its fetch receives the combined cache, scan and shutdown cancellation
signal. A total request deadline equal to `listenerShutdownTimeoutMs` remains
active through response-body consumption; timeout and cancellation expose only
the fixed redacted retryable failure.

### Worker locate

For an inbox worker locate:

1. snapshot `PromotedProviderSelector.selection()`;
2. reject retryably when no provider is promoted;
3. wait behind any queued or active strict scan;
4. bind the routing RPC to the snapshotted provider and revision;
5. call the shared cache locator;
6. read the promoted selection again;
7. return only if provider and revision are unchanged.

A selection change increments the routing epoch and clears retained cache
entries and queued cache admissions. An already-started SDK request may settle
for its original caller, but its result cannot be retained or returned across a
changed promotion revision.

### Strict scan

`runStrictScan(providerId, scanner, signal)` obtains an exclusive scan permit
before calling the existing `StrictCatchUpCoordinator`. Once a scan is queued,
new worker locates queue behind it; at most the worker locate already in flight
finishes first. The complete strict scan, including all page classifications and
receipt persistence, stays bound to `providerId`.

Each provider gets a `PumpFunCatchUpBlockClassifier` and
`PumpFunStrictCatchUpPageAdmitter` whose locator is a frozen provider-bound view
of the coordinator. That view is valid only while the matching scan permit is
active. Calls outside it fail retryably instead of silently selecting another
provider.

The hydration permit is acquired before invoking the existing
`StrictCatchUpCoordinator`. It serializes concurrent provider-affine wrapper
calls; once inside that permit, the coordinator still prevents overlapping
scanner executions within its own boundary. Concurrent wrappers therefore
queue at the hydration permit instead of being guaranteed to join one shared
coordinator flight.

The same page admitter is supplied to both scanner constructions:

- the live-edge bootstrap scanner, which performs no historical admission on a
  fresh checkpoint but becomes strict when durable progress already exists;
- the recovery scanner used for restart and WebSocket gap repair.

PumpSwap is never passed to the Pump.fun page classifier. It retains the legacy
enqueue path; the activation precondition additionally limits this first canary
to `launchpad-only`.

## Worker claim gate

Extend `TransactionInboxWorkerOptions` with an optional synchronous
`canClaim(): boolean` gate.

- absent: current behavior is unchanged;
- `false`: `runOnce()` returns the frozen `idle` result before reading the clock
  or calling `repository.claim`;
- thrown, proxied or non-boolean results: fail closed, mark the worker degraded
  and expose only `TransactionInboxWorkerError('claim-gate')`; the public stage
  union gains this stable redacted value;
- present in B3b: true only when the coordinator is open, a provider is
  promoted and no strict scan owns or is waiting for the exclusive permit.

The gate prevents creating a database lease that cannot yet be hydrated. It is
not an authorization gate and does not change retry or finality semantics.

## Composition and lifecycle

With the flag off, the factory constructs the current block hydration and
legacy catch-up scanners exactly as before.

With the flag on, the factory:

1. builds the provider catalog and promoted selector;
2. builds the provider-affine coordinator with the existing cache limits;
3. builds one Pump.fun classifier/admitter per provider;
4. injects those admitters into the corresponding bootstrap and recovery
   scanners;
5. wraps each strict scan with the provider-affine permit;
6. gives the worker the coordinator locator and claim gate;
7. exposes the coordinator metrics through the heartbeat;
8. invokes worker close synchronously to stop new claims, closes the
   coordinator/cache immediately to abort active hydration, then awaits the
   worker drain.

Shutdown stops admitting work, rejects queued waiters with redacted retryable
failures, aborts bounded in-flight hydration under the existing listener
shutdown deadline, and closes the single cache once. No raw block, URL,
credential, signature or mint is logged by the coordinator.

## Metrics

Keep `heartbeat.blockHydration.version=1` compatible. Add an optional,
independent `catchUpAdmission` V1 object to the heartbeat payload:

```ts
interface RuntimeCatchUpAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly providerId: RpcProviderId | null;
  readonly scanActive: boolean;
  readonly workerClaimReady: boolean;
  readonly actionableBacklogBySource: Readonly<{
    websocketOnly: number;
    catchUpOnly: number;
    websocketAndCatchUp: number;
  }>;
  readonly actionableBacklogByPriority: Readonly<{
    normal: number;
    launchCandidate: number;
    trackedTrade: number;
  }>;
  readonly deferredCount: number;
  readonly ignoredCount: number;
  readonly quarantinedCount: number;
}
```

Source categories are mutually exclusive. Priority totals equal the actionable
backlog. Repository `counts()` obtains these values in its existing aggregate
query with `FILTER` clauses, not a second table scan. All counts remain bounded
safe integers and fail closed on malformed PostgreSQL values.

The public health API and diagnostic frontend accept the additive optional
object. They expose only provider identifiers from the fixed public enum and
aggregate counts, never URLs or chain payloads.

## Error handling and invariants

- RPC, provider change and cancellation before complete page persistence cause
  no strict run or checkpoint advance.
- Temporary hydration failures remain retryable locator failures.
- Non-Pump transactions retain durable `IGNORED` evidence.
- Ambiguous Pump schema retains durable `QUARANTINED` evidence.
- Untracked trades retain durable `DEFERRED` evidence.
- WebSocket/catch-up overlap uses the B3a receipt and never counts or admits the
  same work twice.
- A cache entry is keyed by epoch, slot and effective confirmation and cannot be
  reused after provider promotion changes.
- Finality reconciliation and orphan handling continue through their existing
  provider-pinned paths and are not coupled to the catch-up coordinator.
- The listener cannot start with the activation flag in paper or any live
  execution mode.

## Tests

Configuration tests cover the default, exact boolean parsing, every missing
precondition independently, early rejection without I/O and historical
configurations with the flag off.

Coordinator unit tests cover a single global cache, global pacing, provider
binding, epoch invalidation, old-provider result rejection, scanner priority,
worker exclusion, promotion ABA, cancellation, close and secret redaction.

Worker tests prove zero claim calls while gated, reactivation after promotion,
fail-closed gate errors and unchanged behavior when the option is absent.

Factory and offline integration tests cover fresh live-edge bootstrap, a restart
gap, create plus initial buy, tracked and untracked trades, ignore/quarantine,
WebSocket overlap, exact page checkpointing, restart replay, finality and orphan
reconciliation, PumpSwap legacy isolation and lifecycle close order.

PostgreSQL repository, API contract and frontend tests prove disjoint metric
categories, exact totals, optional backward compatibility and redaction.

The final local/CI gate is:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=postgresql://... npm test
```

## Acceptance and deferred work

B3b is complete when the flag is off by default, off behavior is unchanged,
unsafe activation fails before I/O, every classified page is provider-affine,
the global fetch limits are preserved, worker/scanner shutdown is bounded, all
tests pass and operations documentation describes activation and rollback.

No migration is added. No Mainnet request is required by this PR. After merge,
the next operation is the separate 15-minute Mainnet observe-only canary from
#120. H2e, H2c, wallet preparation, funding and any trade remain blocked until
that canary passes.

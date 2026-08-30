# Solana WebSocket supervisor activation design

Date: 2026-08-28
Issue: #63
Parent issue: #57
Version: 1.0.3
Status: approved through the standing instruction to use the recommended option

Revision 1.0.3 makes the delayed activation path as strict as the former paper
startup barrier. Paper readiness now requires both a running promoted
WebSocket provider and a successful current finality pass, with a fence before
claim and every durable paper mutation. It also serializes supervisor cleanup
before downstream workers, defines candidate completion versus promotion,
fences, aborts and detaches every incumbent, then waits for its single bounded
close attempt before publishing `UNRECOVERABLE`. It keeps the genesis hash
optional in deployment wiring only when the listener is disabled.

## Purpose

Activate the acknowledged Pump.fun and PumpSwap WebSocket path delivered by
issues #59–#62. The production listener must acquire one durable owner before
any Solana network call, accept notifications only through the durable inbox,
prove the missed interval with provider-pinned strict HTTP catch-up, and never
publish `RUNNING` before both program subscriptions and both exact frontiers
are proven.

The change remains strictly observational. It supports only `observe` and
`paper`, adds no wallet, signer, private key, transaction builder, simulation
submission or transaction submission, and does not claim same-slot delivery,
sellability or profit.

## Audited baseline

Production still composes the policy-aware `CatchUpScanner` and web3.js
`SolanaProgramSubscriber`. `SolanaListenerRuntime` performs HTTP health, a
legacy scan, subscription, then a second legacy scan before starting workers.
That sequence performs network I/O before durable WebSocket owner acquisition
and cannot expose server acknowledgements or controlled failover.

The inactive foundations already provide:

- a positional HTTP/WS provider catalog;
- a native session that resolves only after Pump.fun and PumpSwap ACKs;
- a provider-pinned, genesis-validated strict scanner and checkpoint CAS;
- an idempotent PostgreSQL transaction inbox;
- provider-affine finality passes;
- a generation-fenced WebSocket health repository and reporter;
- API and deployment health projections that become strict when supervision is
  `ACTIVE`.

The legacy subscriber and scanner remain in the repository for diagnostics and
secondary use, but are removed from the production Pump listener composition.

## Selected architecture

```text
PostgreSQL owner acquisition (no network)
             |
             v
PersistentWebSocketHealthReporter
             |
             v
WebSocketFailoverSupervisor ---------------------------+
  one incumbent + at most one candidate                |
  dual Pump.fun/PumpSwap ACK                            |
  one strict scan/provider/cycle                        |
  bounded rotation + equal-jitter backoff               |
  one coalesced 30-second frontier scan                 |
             |                                          |
             +--> acknowledged native WS session -------+
             |          |                               |
             |          +--> durable inbox <------------+
             |                                          |
             +--> provider-pinned strict HTTP scan -----+
             |
             +--> promoted provider selector
                          |
                          +--> provider-pinned finality pass
```

`WebSocketFailoverSupervisor` is one application lifecycle component. It owns
provider rotation, sessions, recovery scheduling and promotion. It depends on
ports and existing adapters; it does not import PostgreSQL, web3.js
`Connection`, API, qualification, paper strategy or execution code directly.

The production factory owns concrete construction. `SolanaListenerRuntime`
starts the supervisor before inbox, finality, paper, social and heartbeat
workers. The legacy pre-scan, web3.js subscriber and pre-owner HTTP health call
are absent from the active production sequence.

## Explicit deployment configuration

`SOLANA_EXPECTED_GENESIS_HASH` is an operator-supplied canonical base58 value
that decodes to exactly 32 bytes. It is required when `LISTENER_ENABLED=true`
and is nullable only for an explicitly disabled listener. It is never learned
from any RPC during the same boot and has no embedded cluster default.

Activation also makes the primary HTTP/WS pair strict even without fallbacks:

- `https:` pairs only with `wss:` and `http:` only with `ws:`;
- fragments are rejected;
- fallback cardinality, canonical uniqueness and the one-to-three fallback
  bound remain unchanged;
- validation failures name configuration fields only and never include a URL,
  hostname, query, header or supplied hash.

The hash is present as a blank value in safe examples. Compose passes it with
an empty default so listener-disabled smoke and migration jobs remain valid;
application validation makes it mandatory only when the listener is active.
Operations documentation obtains and independently verifies it; examples must
not pretend that a placeholder is a real cluster hash.

## Supervisor contract

The application service exposes the existing lifecycle shape:

```ts
interface WebSocketFailoverSupervisor {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
  activeProviderId(): RpcProviderId | null;
}
```

`start()` performs the durable owner acquisition, starts its fenced health
touch, persists the initial waiting state and arms exactly one recovery loop.
It then resolves without waiting indefinitely for a provider. This lets the
public health API expose `CONNECTING`, `RECOVERING` or `DEGRADED` while
recovery continues, then `UNRECOVERABLE` if the terminal proof stops automatic
recovery. It rejects only when the owner, initial health transition or
recovery-loop scheduling cannot be established safely.

The runtime projection reports `RUNNING` only when the supervisor's durable
phase is `RUNNING`. Connecting and recovering map to `STARTING`; transient and
unrecoverable states map to `DEGRADED`. Close first maps to `STOPPING`, then to
`STOPPED` only after complete cleanup; a rejected or timed-out cleanup rejects
with fixed evidence and leaves the runtime `DEGRADED`.

## Notification boundary

The supervisor maps the native session's allowlisted notification into the
existing immutable transaction notification:

```ts
{
  signature,
  slot,
  source: 'WEBSOCKET',
  programIds: program === 'pumpfun' ? [PUMP_PROGRAM_ID] : [PUMPSWAP_PROGRAM_ID],
  confirmationStatus: 'confirmed',
  observedAtMs: validatedLocalClock,
}
```

It then calls `PersistentWebSocketHealthReporter.observe`, which preserves the
mandatory order:

```text
inbox.enqueue(notification)
  -> health.recordObservation(ownerGeneration, sessionGeneration, slot)
```

The first acknowledged subscription may therefore enqueue before the second
ACK. It cannot cause `ACKNOWLEDGED`, `RECOVERING`, checkpoint movement or
promotion. WebSocket traffic never advances a catch-up checkpoint.

## Startup and candidate lifecycle

For a fresh process:

1. `beginOwner(primary)` persists `ACTIVE/CONNECTING` and allocates the first
   candidate generation before any Solana call.
2. The reporter starts its five-second durable touch.
3. `WAITING_FOR_ACKS` is persisted with recovery reason `STARTUP`, or the
   unresolved restart reason preserved by `beginOwner`.
4. The candidate native session is opened.
5. Only its successful dual-ACK resolution permits `ACKNOWLEDGED`.
6. `RECOVERING/IN_PROGRESS` is persisted.
7. Exactly one strict scan of both programs runs on the candidate's paired
   HTTP provider.
8. Only a successful scan, including every enqueue and required checkpoint
   CAS, permits the candidate-to-active `RUNNING/RECOVERED` transition.
9. A serialized local promotion fence orders lifecycle events before the
   transition is sent. The successful durable transition is the publication
   point, and the promoted provider selector is updated immediately afterward.
10. Any incumbent is detached and receives one bounded close attempt. Its late
    completion cannot modify the promoted generation; a rejected close
    degrades the new active generation with fixed cleanup evidence.

Every new candidate generation is the exact next value authorized by the
health repository revision fence. Candidate setup failure or failed recovery
triggers one bounded cleanup attempt before that candidate is removed from
durable health. A rejected attempt produces the fixed cleanup failure and
cannot authorize promotion. At most one incumbent and one candidate exist.

## Recovery, rotation and backoff

A session completion, protocol failure, enqueue failure or failed periodic
frontier scan immediately persists `DEGRADED` with a fixed allowlisted reason.
The supervisor then performs one finite cycle in positional catalog order,
starting after the last promoted provider and wrapping once.

Each provider receives exactly this budget per cycle:

```text
one candidate setup
  -> if and only if dual ACK succeeds: one strict two-program scan
  -> success promotes, any failure ends this provider attempt
```

There is no nested retry. HTTP 429, network failure, malformed response,
genesis unavailability, checkpoint conflict and repository failure are
transient. A cycle containing any transient result remains `DEGRADED`.

After a fully transient/exhausted cycle, the next cycle uses capped
equal-jitter exponential backoff:

```text
exponentialCap = min(60_000 ms, 1_000 ms * 2^failedCycleCount)
delay = floor(exponentialCap / 2 + random * exponentialCap / 2)
```

The random source and scheduler are injectable and strictly validated for
deterministic tests. The failed-cycle count resets only after durable
promotion. Fixed V1 bounds are not environment knobs.

## Exact unrecoverable proof

`StrictCatchUpWindowExceededError` gains an internal immutable copy of both
captured checkpoints and a trusted `sameFrontier` comparison. The frontier is
not enumerable, serializable, logged or exposed through health. This lets the
supervisor require that every configured provider in one complete cycle
returned `CATCH_UP_WINDOW_EXCEEDED` from the same exact launchpad and market
frontiers.

Only that unanimous result persists `UNRECOVERABLE/FAILED` with
`CATCH_UP_WINDOW_EXCEEDED`. A mixed cycle is transient. `UNRECOVERABLE` stops
automatic rotation and remains fail-closed until process restart or later
operator-controlled recovery work. Restart always re-enters dual ACK and
strict catch-up; it never selects `live-edge`.

Before persisting `UNRECOVERABLE`, publication is fenced, provider selection is
cleared, and every candidate and incumbent is aborted, detached and subjected
to its single bounded close attempt, including a still-connected incumbent.
The terminal transition waits for that attempt to settle. A rejected close
does not reopen publication or recovery: the supervisor persists the
fail-closed terminal state, records cleanup failure internally, and its later
`close()` rejects with the fixed cleanup error. Notifications arriving after
the fence cannot enter the durable inbox. The terminal snapshot therefore
exposes no active or candidate provider pair. No setup, backoff, periodic or
recovery timer remains armed. Qualification may retain evidence already
persisted before the terminal fence, but paper readiness is false and no paper
position mutation is authorized.

## Cooperative scan cancellation

The strict scanner and coordinator accept an `AbortSignal`. The scanner checks
it before and after every awaited checkpoint, page, enqueue, failure write and
CAS boundary. web3.js does not expose transport cancellation for the selected
RPC call, so an in-flight request may settle later, but an aborted scan can no
longer perform a subsequent durable write.

A crash or abort after some enqueues or one checkpoint CAS remains safe: the
next strict scan replays through the idempotent inbox and captures the new
exact boundaries. Abort is a fixed internal shutdown result, not a provider
failure and not evidence for `UNRECOVERABLE`.

## Periodic completeness frontier

After promotion, one fixed 30-second timer triggers a strict scan on the active
provider. The timer rearms only after settlement; WebSocket volume never
schedules scans. A concurrent failure signal is coalesced into the single
supervisor recovery loop.

A successful unchanged or advanced frontier keeps `RUNNING`. A failed scan
immediately degrades and starts candidate recovery. The scan remains pinned to
the provider captured at its start.

## Provider-affine finality

The production factory preconstructs one immutable finality pass per catalog
provider. `FinalityProviderPassSource.openPass()` reads the supervisor's
promoted provider exactly once and returns that provider's pass. A pass never
switches provider mid-run. Before first promotion it throws one fixed redacted
unavailable result.

The recurring finality controller retries initial unavailability in both
observe and paper modes instead of terminating the process. It exposes a
read-only readiness bit that becomes true only after a coherent pass succeeds,
returns false again whenever the controller is degraded, and never substitutes
an earlier provider's success for the current promoted provider. This replaces
the issue #61 paper startup barrier with an equally strict dynamic barrier that
can coexist with an observable background WebSocket activation. Existing
orphan proof rules remain unchanged: same-provider missing sequence, higher
finalized root, canonical finalized block and transactional generation
precondition.

## Paper safety while degraded

The paper worker receives one injected readiness predicate that is true only
when the supervisor is `RUNNING`, a provider is promoted, and the current
finality controller has completed a successful pass. The worker checks this
fence before manual-kill-switch wake-up, before claim, after every awaited
external operation that can cross a health transition, and immediately before
each decision, session, trade or position write. If readiness is lost after a
claim, only bounded lease release/retry bookkeeping may be persisted; no new
paper decision or position mutation is allowed.

The worker remains scheduled and self-resumes only after the joint predicate
becomes true. Observe mode continues read projections without creating paper
actions. This dynamic barrier preserves and strengthens the issue #61 rule
that paper effects require a successful initial finality pass; it does not add
an execution capability.

## Runtime and shutdown ordering

The active runtime order becomes:

```text
supervisor.start (durable owner first, recovery loop armed)
  -> inbox worker
  -> finality reconciler
  -> paper worker
  -> social worker
  -> generic runtime heartbeat
  -> public API created by runApplication
```

Shutdown wins every race. The runtime first awaits supervisor close to stop
acceptance, abort setup/backoff/scan and drain both native sessions. Only after
that settlement does it close paper, social and finality producers, then drain
the inbox worker, and finally stop the generic heartbeat. Every stage consumes
the same global deadline; the runtime does not reintroduce parallel
producer/consumer close.
The reporter owns `STOPPING`, bounded session cleanup and the final `STOPPED`
or explicit failed-cleanup transition.

`close()` is idempotent. Old timer, callback and completion generations cannot
restart recovery or alter health. A scheduler, transition, touch or cleanup
failure is redacted, aggregated by the runtime, and leaves state degraded
rather than inventing a clean stop.

Candidate completion and promotion share one serialized session record. A
completion processed before the local promotion fence marks that candidate
invalid, aborts its scan and forbids `RUNNING`. A completion delivered after
the fence while the PostgreSQL transition is pending is queued, not discarded.
If the transition commits, the queued completion belongs to the newly active
session and immediately persists degradation; if the transition fails, the
candidate never becomes active and the same completion invalidates it before
one bounded close attempt. A rejected attempt produces the fixed cleanup
failure. No simple invocation is treated as a successful durable promotion,
and a role-changing candidate completion is never mistaken for a stale
generation.

## Crash and idempotence matrix

- Before or after either ACK: restart opens a new candidate and rescans.
- During page reads: no inbox or checkpoint mutation occurs.
- After some enqueues: replay merges the same signature and slot.
- After one program CAS: the other boundary is replayed independently.
- After both CAS operations but before promotion: restart performs an empty or
  overlapping strict scan before promotion.
- During incumbent/candidate overlap: signature identity deduplicates both
  sockets and HTTP; program IDs and discovery sources merge.
- After promotion: stale callback health writes return `STALE_SESSION`; stale
  completion handlers cannot demote the active generation.
- After `UNRECOVERABLE`: restart repeats strict recovery and retains unresolved
  evidence until an exact later scan resolves it.

Raw chain events remain separate from projections. No new unbounded lifecycle
journal is introduced; the current health snapshot and four-hour resolved
evidence retention remain authoritative.

## Public health and operations

The API V1 shape is unchanged. Production now emits `supervision=ACTIVE` and
the already documented detailed phases. Aggregate `OK` still requires a fresh
generic heartbeat, a fresh WebSocket heartbeat, `phase=RUNNING`, recovered or
not-required recovery, and no unresolved strict failure. Deployment
`--require-ok` uses the same projection.

Structured logs expose only event names, positional provider IDs, fixed reason
codes, cycle/attempt counts and bounded delays. They never include RPC URLs,
hashes, signatures, frames, remote reasons, database messages or caught error
objects.

README, API documentation, system overview, deployment guide and RPC runbook
must replace the “inactive until #63” wording with the active contract and a
rollback procedure. Rollback stops the process cleanly; it never enables the
legacy subscriber automatically inside the same boot.

## Verification matrix

The PR must prove:

- owner acquisition before any network or API resource;
- ACKs in either order, partial ACK, timeout and rejection;
- disconnect/protocol/enqueue failures and bounded cleanup;
- incumbent/candidate overlap and stale-generation isolation;
- notifications during outage, partial ACK, recovery and promotion;
- one attempt/provider/cycle, HTTP 429, rotation and equal-jitter bounds;
- multi-page strict catch-up, CAS conflicts and no partial pre-walk writes;
- abort/crash after every durable boundary;
- WS/WS/HTTP deduplication;
- unanimous exact-frontier `UNRECOVERABLE` and mixed-cycle degradation;
- periodic scan serialization and provider-pinned finality selection;
- joint WebSocket/finality paper fences before claim and every paper mutation;
- active API/deployment health, redaction and four-hour retention;
- absence of wallet, signer, transaction construction, simulation submission
  and transaction submission from the complete production import graph.

All focused tests, PostgreSQL integration tests, build, TypeScript checks,
lint, documentation checks, backend tests and frontend tests must pass. GitHub
review is limited to three correction/review cycles.

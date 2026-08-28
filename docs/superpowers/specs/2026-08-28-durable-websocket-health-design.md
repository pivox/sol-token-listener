# Durable Solana WebSocket health design

Date: 2026-08-28
Issue: #62
Parent issue: #57
Version: 1.0.0
Status: approved through the standing instruction to use the recommended option

## Purpose

Persist and expose the real lifecycle of the future acknowledged Solana
WebSocket supervisor without activating that supervisor in production. The
delivery is additive to API V1, compatible with the legacy subscriber, and
strictly limited to `observe` and `paper` execution modes.

The public health contract must distinguish `STOPPED`, `CONNECTING`,
`ACKNOWLEDGED`, `RECOVERING`, and `DEGRADED`. It must expose only positional
provider identifiers and fixed reason codes. It must never expose an RPC URL,
hostname, header, query parameter, signature, remote close text, raw frame,
database error, wallet, signer, private key, or transaction-submission
capability.

## Audited baseline

The production `PersistentListenerHeartbeat` writes one
`listener_heartbeats` row immediately at start and stop, then every five
seconds. Its upsert replaces the generic payload and is guarded by the row-wide
`updated_at`. Production intentionally writes `last_websocket_slot` and
`last_signature` as `NULL`.

Issue #59 provides an inactive native dual-ACK WebSocket session with a
durable asynchronous notification callback and fixed redacted failure reasons.
Issue #60 provides an inactive provider-pinned strict catch-up scanner,
checkpoint compare-and-swap, and durable strict-window failures. Issue #61
provides primary-pinned finality reconciliation. Production still uses the
legacy `SolanaProgramSubscriber`; issue #63 alone may activate the supervisor.

`GET /api/v1/health` currently reads the latest generic heartbeat, applies a
30-second freshness bound, and returns `OK` or `DEGRADED`. It does not expose a
WebSocket lifecycle or check unresolved strict catch-up failures. The frontend
polls health and accepts additive fields through loose object schemas.

## Considered storage approaches

### JSONB in the generic heartbeat

Rejected. The five-second writer replaces the payload, PostgreSQL cannot
enforce the cross-field lifecycle, and a periodic write can erase an immediate
transition.

### More columns on `listener_heartbeats`

Rejected. Explicit columns improve constraints but keep two independent
writers on the same row and row-wide timestamp guard. WebSocket state has a
different owner, cadence, crash lifecycle, and freshness proof.

### Dedicated bounded snapshot

Selected. A single canonical row in `listener_websocket_health` isolates
periodic touches from lifecycle transitions, supports owner/session generation
fencing, uses strong SQL checks, and stays bounded without an unbounded
transition journal.

## Durable schema

Migration `030_listener_websocket_health.sql` creates one snapshot row per
service with these logical fields:

```text
service_key                     TEXT PRIMARY KEY
payload_version                 SMALLINT = 1
supervision                     INACTIVE | ACTIVE
owner_generation                BIGINT >= 0
revision                        BIGINT >= 0
active_session_generation       BIGINT | null
candidate_session_generation    BIGINT | null
provider_id                     RpcProviderId | null
candidate_provider_id           RpcProviderId | null
phase                           WebSocketHealthPhase
acknowledged_at                 timestamptz | null
last_observation_at             timestamptz | null
last_observation_slot           numeric(78,0) | null
disconnect_occurred_at          timestamptz | null
disconnect_reason_code          WebSocketDisconnectReasonCode | null
recovery_status                 WebSocketRecoveryStatus
recovery_started_at             timestamptz | null
recovery_completed_at           timestamptz | null
recovery_reason_code            WebSocketRecoveryReasonCode | null
heartbeat_at                    timestamptz | null
updated_at                      timestamptz
evidence_purge_after            timestamptz | null
```

The canonical `transaction-listener` row is seeded as version 1, generation
and revision zero, `INACTIVE`, `STOPPED`, and `NOT_REQUIRED`. Existing legacy
WebSocket slots and signatures are not copied because their durable-enqueue
provenance cannot be established. Applying the migration to an empty database,
after migrations 001–029, or replaying its SQL directly must be safe.

The primary key is the only lookup index required for this bounded snapshot.
No URL, signature, arbitrary message, remote reason, raw payload, or process
secret has a storage column.

### SQL invariants

- Provider IDs are `primary`, `fallback-1`, `fallback-2`, or `fallback-3`.
- Provider and matching session generation are jointly null or non-null.
- Active and candidate provider/session pairs are distinct.
- Generations and revision are nonnegative and cannot overflow PostgreSQL
  `BIGINT` at an application boundary.
- Observation timestamp and slot are jointly null or non-null; the slot is a
  finite nonnegative integer.
- Disconnect timestamp and reason are jointly null or non-null.
- Every timestamp is finite and recovery completion cannot precede recovery
  start.
- `INACTIVE` implies generation zero, `STOPPED`, no provider/session/ACK, and
  recovery `NOT_REQUIRED`.
- `STOPPED` has no provider, candidate, session generation, or ACK.
- `CONNECTING` and `WAITING_FOR_ACKS` have a candidate provider/session and no
  ACK.
- `ACKNOWLEDGED` and `RECOVERING` have a candidate provider/session and an ACK.
- `RUNNING` has one active provider/session, no candidate, and an ACK.
- `DEGRADED`, `UNRECOVERABLE`, and `STOPPING` are available only under active
  supervision and may retain the exact active/candidate pairs needed for
  cleanup or recovery; they cannot invent an ACK without a session pair.
- Recovery `NOT_REQUIRED`, `REQUIRED`, `IN_PROGRESS`, `RECOVERED`, and `FAILED`
  have coherent timestamp and fixed-reason combinations.

## Domain vocabulary

Detailed durable phases are:

```text
STOPPED
CONNECTING
WAITING_FOR_ACKS
ACKNOWLEDGED
RECOVERING
RUNNING
DEGRADED
UNRECOVERABLE
STOPPING
```

The public five-state projection is deterministic:

```text
STOPPED                                      -> STOPPED
CONNECTING | WAITING_FOR_ACKS                -> CONNECTING
ACKNOWLEDGED | RUNNING                       -> ACKNOWLEDGED
RECOVERING                                   -> RECOVERING
DEGRADED | UNRECOVERABLE | STOPPING          -> DEGRADED
```

Disconnect reasons reuse the safe issue #59 vocabulary and add restart
evidence only:

```text
SETUP_TIMEOUT
ABORTED
SOCKET_ERROR
REMOTE_CLOSE
PROTOCOL_INVALID
NOTIFICATION_FAILED
CLEANUP_FAILED
UNEXPECTED_RESTART
```

Recovery reasons are fixed to:

```text
STARTUP
UNEXPECTED_RESTART
SESSION_FAILURE
RPC_UNAVAILABLE
CHECKPOINT_CONFLICT
CATCH_UP_WINDOW_EXCEEDED
```

No unknown remote text is normalized into these fields. Unsupported or hostile
input fails with a typed, redacted domain or repository error.

## Repository and concurrency contract

The neutral `WebSocketHealthRepository` exposes:

```ts
read(): Promise<WebSocketHealthSnapshot>;
beginOwner(input): Promise<WebSocketHealthSnapshot>;
transition(input): Promise<WebSocketHealthSnapshot>;
touch(ownerGeneration): Promise<void>;
recordObservation(input): Promise<'RECORDED' | 'STALE_SESSION'>;
```

`beginOwner` locks the canonical row and captures one PostgreSQL clock instant.
An `INACTIVE` or clean `STOPPED` row starts a new owner generation. A fresh
active owner is rejected with fixed code `ACTIVE_INSTANCE`; a heartbeat older
than 30 seconds is replaced by a new generation with `CONNECTING`, recovery
`REQUIRED`, and `UNEXPECTED_RESTART`. Generation zero is never an active owner.

Every immediate transition compares the exact owner generation and revision,
then increments the revision. A stale transition fails without modifying the
row. `touch` updates only `heartbeat_at` for the current owner generation and
does not rewrite lifecycle fields or increment the transition revision.

Active and candidate sessions have distinct monotonically allocated session
generations. `recordObservation` updates the diagnostic watermark only when
both the owner and session generations still identify the current active or
candidate session. A late callback from a retired generation returns
`STALE_SESSION` and cannot regress health.

Database time supplies transition, heartbeat, and observation timestamps.
Concurrent observations preserve the slot associated with the latest completed
health write; the value is not `MAX(slot)` because Solana notifications may be
observed out of order.

## Durable observation ordering

The issue #62 reporter wraps the future issue #63 session callback in this
strict order:

```ts
await inbox.enqueue(notification);
await websocketHealth.recordObservation({
  ownerGeneration,
  sessionGeneration,
  slot: notification.slot,
});
```

An enqueue failure cannot advance health. A crash between the two calls leaves
the watermark conservatively behind while the inbox remains authoritative. A
health write failure after enqueue rejects the asynchronous callback and the
native session reports fixed `NOTIFICATION_FAILED`; replay remains safe and
idempotent. Refactoring the mature inbox transaction merely to make a
diagnostic watermark atomic would add locking and regression risk without
proving stream completeness.

The last observation is explicitly a watermark, never a catch-up checkpoint or
continuity proof. It contains only PostgreSQL observation time and slot.

## Immediate transitions and periodic heartbeat

`PersistentWebSocketHealthReporter` owns no network connection and performs no
provider selection. It persists transitions synchronously, schedules one
bounded periodic `touch`, serializes or coalesces touches, and fences shutdown
against an in-flight write. Transition persistence failure degrades in memory
and fails closed. Graceful shutdown writes `STOPPING` immediately and `STOPPED`
only after the caller has drained and closed sessions; cleanup failure remains
`DEGRADED/CLEANUP_FAILED`.

The reporter and repository are delivered inactive. They are not constructed
by `createProductionListenerRuntime`, `runApplication`, or configuration in
issue #62. Issue #63 must activate generation one and write `CONNECTING` before
opening any listener network resource or public API.

## Restart semantics

- A clean `STOPPED` predecessor starts normally.
- A fresh active predecessor refuses a second owner with `ACTIVE_INSTANCE`.
- A stale active predecessor records `UNEXPECTED_RESTART`, preserves its last
  observation, and requires fresh dual ACK plus strict catch-up.
- `UNRECOVERABLE` always retries strict recovery and never authorizes a
  live-edge rebaseline.
- A prior cleanup failure remains abnormal and follows the same recovery path.
- Owner and session generations prevent old timers, closes, callbacks, and
  provider-ID ABA from modifying the replacement owner.

Issue #62 proves these semantics without performing the startup call in
production. Issue #63 owns activation and deployment behavior.

## Retention and privacy

The bounded current snapshot remains so health has an explicit `STOPPED`
foundation. Resolved disconnect and recovery evidence is retained for exactly
four hours, then the retention transaction clears its timestamps and reason
codes. A running snapshot keeps its current ACK and observation watermark; a
stopped snapshot clears ACK and observation evidence after the same four-hour
window. Purging evidence never refreshes `heartbeat_at` and therefore cannot
make stale health look current.

Unresolved recovery or cleanup evidence has no purge deadline. No unbounded
transition journal is added. Existing resolved strict catch-up failures keep
their four-hour retention from issue #60.

## Public API V1

`ApiHealth.heartbeat` gains required backend field `websocket`:

```ts
interface ApiWebSocketHealth {
  readonly version: 1;
  readonly supervision: 'INACTIVE' | 'ACTIVE';
  readonly state:
    | 'STOPPED' | 'CONNECTING' | 'ACKNOWLEDGED' | 'RECOVERING' | 'DEGRADED';
  readonly phase: WebSocketHealthPhase;
  readonly providerId: RpcProviderId | null;
  readonly candidateProviderId: RpcProviderId | null;
  readonly updatedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly lastObservation: Readonly<{ observedAt: string; slot: string }> | null;
  readonly disconnect: Readonly<{
    occurredAt: string;
    reasonCode: WebSocketDisconnectReasonCode;
  }> | null;
  readonly recovery: Readonly<{
    status: WebSocketRecoveryStatus;
    startedAt: string | null;
    completedAt: string | null;
    reasonCode: WebSocketRecoveryReasonCode | null;
  }>;
}
```

Generation and revision values remain internal. The existing V1
`heartbeat.lastSignature` key remains for shape compatibility but the backend
stops selecting its stored value and always returns `null`.

The migration backfill exposes `INACTIVE/STOPPED`. While supervision is
`INACTIVE`, WebSocket state does not affect aggregate health; this avoids both
a false ACK and a deployment-wide degradation before #63. When supervision is
`ACTIVE`, `OK` requires:

- a fresh generic runtime heartbeat;
- a fresh WebSocket heartbeat;
- phase exactly `RUNNING` and public state `ACKNOWLEDGED`;
- recovery `NOT_REQUIRED` or `RECOVERED`;
- no unresolved `listener_strict_catch_up_failures` row;
- every pre-existing dependency and pipeline condition.

All other active states are `DEGRADED`. PostgreSQL unavailability preserves the
existing HTTP 503 behavior; an available database with degraded WebSocket
health returns HTTP 200 and `data.status=DEGRADED`.

No health event is added to the domain SSE stream. That stream requires mint,
signature, cursor, and domain-event replay semantics; technical health remains
a polled read model.

## Frontend compatibility

The backend always emits the new object after migration. The frontend schema
keeps `heartbeat.websocket` optional during rolling deployment:

- an old frontend ignores the additive object because health objects are
  loose;
- a new frontend accepts an old backend and displays “Non disponible — backend
  antérieur”;
- a future breaking API version may make it mandatory client-side.

The diagnostic card renders only allowlisted state, phase, positional provider
IDs, ACK time, observation watermark, disconnect reason, and recovery fields.
It labels the observation as diagnostic, not a continuity frontier. Additive
hostile fields are never rendered as generic JSON.

## Delivery boundaries

Issue #62 adds migration 030, domain and repository contracts, inactive
reporter, API/backend/frontend projection, retention, documentation, and tests.
It does not:

- construct or activate the native WebSocket session;
- construct or schedule the strict scanner/coordinator;
- promote or rotate a provider;
- change production configuration;
- alter the legacy subscriber;
- add wallet, signing, simulation submission, or live execution;
- claim same-slot delivery, sellability, or profit.

## Acceptance tests

- Migration 030 applies after 001–029 and on an empty database, backfills the
  canonical inactive row, rejects every invalid invariant, and replays safely.
- Domain validators reject hostile objects, invalid generations, timestamps,
  phases, providers, states, and reason codes without retaining input.
- Fresh-owner exclusion, stale restart, generation exhaustion, revision CAS,
  session ABA, transition immediacy, periodic coalescing, and shutdown fencing
  are covered.
- Enqueue rejection leaves the watermark unchanged; enqueue success followed
  by a health failure leaves only durable inbox data and fails the callback.
- Partial-ACK observations are accepted after durable enqueue without claiming
  full acknowledgement.
- Retention clears only resolved evidence after four hours and cannot refresh
  freshness.
- API tests cover all five public states, every detailed phase, inactive
  compatibility, active degradation, unresolved strict failure, timestamps,
  redaction, and `lastSignature=null`.
- Frontend schema and rendering cover new backend, old backend, hostile additive
  fields, and the diagnostic-watermark label.
- Bootstrap tests prove issue #59/#60 components remain inactive and #63 is not
  enabled.
- Build, strict check, lint, docs, migration replay, backend/frontend tests,
  deployment contract, and frontend end-to-end tests pass.

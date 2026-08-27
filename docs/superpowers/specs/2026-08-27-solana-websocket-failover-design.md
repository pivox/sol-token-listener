# Solana WebSocket failover design

Date: 2026-08-27
Umbrella issue: #57
Delivery issues: #59, #60, #61, #62, #63
Version: 1.0.5
Status: approved through the standing instruction to use the recommended option

Revision 1.0.5 makes setup failure await the actual socket close under the
five-second cleanup bound, including the partial-ACK notification path.

Revision 1.0.4 makes active-failure cleanup await the real socket close,
defines local-close race precedence, and validates catalog uniqueness at its
own boundary.

Revision 1.0.3 makes provider URL resolution non-enumerable, preserves the
legacy primary-only URL behavior, requires an explicit notification `err`
field, and bounds observer draining when setup fails after a partial ACK.

Revision 1.0.2 fixes the recovery budget to one strict scan per paired
provider and cycle, and requires unanimous same-frontier window exhaustion
before persisting `UNRECOVERABLE`.

Revision 1.0.1 preserves the HTTP-only fallback configuration from issue #56,
bounds frontier scans to one coalesced periodic schedule, unifies lifecycle and
health phases, and tightens durable notification and recovery semantics.

## Purpose

The Pump.fun and PumpSwap listener must detect a WebSocket interruption,
replace the affected session, recover the exact missed interval through HTTP,
and refuse to report `RUNNING` when continuity cannot be demonstrated. The
design keeps the durable transaction inbox as the at-least-once convergence
boundary and adds no live execution capability.

This work remains strictly `observe` or `paper`. It adds no wallet, signer,
private key, transaction construction, submission, same-slot promise,
sellability promise, or profit claim. The unexecuted Mainnet paper validation
in issue #49 remains separate.

## Audited baseline

The current `SolanaProgramSubscriber` registers two `Connection.onLogs()`
callbacks and immediately reports `RUNNING`. The returned identifiers are
local web3.js listener identifiers, not server acknowledgements. The private
web3.js subscription machinery retries indefinitely, does not expose a stable
ACK lifecycle, and may log raw errors.

The runtime only performs `strict-or-live-edge scan -> subscribe -> scan` at
startup. WebSocket notifications do not advance catch-up checkpoints and no
periodic scan maintains a reachable frontier. The production default permits
live-edge rebaselining, which is intentionally unsuitable for automatic
recovery.

The inbox already provides the required overlap safety: a signature is the
durable identity, the slot must remain identical, sources and program IDs are
merged, and confirmation only advances monotonically.

## Selected architecture

```text
paired provider catalog
  primary:    HTTP + WS
  fallback-1: HTTP + WS
  fallback-2: HTTP + WS
  fallback-3: HTTP + WS
          |
          v
native acknowledged WS session
  Pump.fun ACK + PumpSwap ACK
          |
          v
WS failover supervisor --------------------------+
  active session + at most one candidate         |
  bounded rotation/backoff                       |
  strict provider-pinned recovery                |
          |                                      |
          +--> durable idempotent inbox <---------+
          |
          +--> durable WS health / strict failure evidence
          |
          +--> periodic coalesced strict frontier scan
```

`@solana/web3.js Connection` remains available to existing HTTP consumers.
The acknowledged program-log session uses Node 22's native `WebSocket` behind
a small injectable port. No private web3.js property or transitive
`rpc-websockets` API becomes an application dependency.

## Paired provider configuration

`SOLANA_HTTP_RPC_URL` and `SOLANA_WS_RPC_URL` remain the mandatory primary
pair. `SOLANA_HTTP_RPC_FALLBACK_URLS` and the new
`SOLANA_WS_RPC_FALLBACK_URLS` are optional ordered comma-separated lists with
one to three entries.

HTTP fallbacks without a WebSocket fallback list preserve the behavior already
delivered by issue #56. When `SOLANA_WS_RPC_FALLBACK_URLS` is present, the HTTP
fallback list must also be present with identical cardinality. Providers are
paired by position. The catalog serializes only `primary`,
`fallback-1`, `fallback-2`, or `fallback-3`. Configuration rejects empty
entries, fragments, canonical duplicates and incompatible protocols. An
`https:` HTTP endpoint requires `wss:`; an `http:` endpoint requires `ws:`.
No validation error, public health object, structured event or persisted
diagnostic may contain a URL, hostname, provider name, header, query secret,
close reason, raw frame or remote error.

Before a candidate can be promoted, its provider-pinned HTTP client must
report the expected genesis hash. Issue #60 must define that expectation from
a reviewed closed mapping for standard clusters or an explicit validated
custom-cluster value; it must never derive the expectation from the primary
endpoint during the same boot. Ordinary HTTP consumers may keep the bounded
request-level failover introduced by issue #56; one logical recovery or
finality proof must instead remain pinned to one provider.

## Acknowledged program-log session

The low-level session owns JSON-RPC request IDs and server subscription IDs.
Its `open()` operation resolves only after both `logsSubscribe` requests have
received valid acknowledgements for the canonical Pump.fun and PumpSwap
program IDs at `confirmed` commitment.

An acknowledgement is valid only when:

- `jsonrpc` is exactly `2.0`;
- the response ID matches one outstanding request exactly once;
- no JSON-RPC error exists;
- the result is a unique non-negative safe integer.

Duplicate responses, duplicate subscription IDs, malformed or oversized JSON,
unknown active subscription notifications, socket errors, remote closes and
setup timeout are fixed typed protocol failures. A notification is accepted
only when it maps to an acknowledged server subscription, carries a
non-negative safe-integer slot, an `err: null` transaction result, and a
canonical base58 signature decoding to exactly 64 bytes. Failed transactions
are ignored. Logs and raw frames are never forwarded.

The durable callback returns `Promise<void>`. The `err` field must be present;
`null` identifies a successful notification and any non-null value identifies
a failed transaction to ignore. A notification received for the first
acknowledged program before the second ACK is passed to that callback
immediately. Callback rejection is a session failure. In-flight callbacks are
tracked and drained during bounded close and during setup failure after a
partial ACK. A stuck callback converts cleanup to a fixed failure after five
seconds; observations are never buffered only in process memory.

The session exposes a one-shot redacted completion promise and an idempotent,
bounded close. Graceful close attempts `logsUnsubscribe` only for server
subscription IDs actually acknowledged and waits for their boolean replies,
then closes the socket. Timeout or abort force the local close and remove every
listener and timer. A remote close code `1000` is still a failure unless close
was locally initiated.

V1 fixed bounds are:

- setup ACK timeout: 10 seconds;
- cleanup timeout: 5 seconds;
- text frame maximum: 1 MiB.

These bounds are intentionally not environment tuning knobs in the first
version.

## Completeness frontier and strict recovery

WebSocket traffic must never advance a catch-up checkpoint. Solana PubSub has
no resumable sequence or completeness proof: persisting one notification does
not prove that an earlier notification was not dropped or reordered.

A checkpoint means:

> the newest confirmed program signature for which every signature between
> the previous exact `(slot, signature)` boundary and this head was durably
> enqueued by one provider-pinned strict backward page walk.

Checkpoint advancement uses an exact compare-and-swap from the checkpoint
read by the scan to the new head. A conflicting writer makes the scan stale;
the coordinator ends that provider attempt and starts the next cycle from a
fresh boundary. A scan never mixes pages from different providers.

Automatic startup, restart, periodic maintenance and failover recovery are
always strict when a checkpoint exists. They never invoke `live-edge` and
never silently rebaseline. The legacy live-edge policy is outside the
failover supervisor; #63 must ignore or reject it whenever an existing
checkpoint makes automatic recovery necessary.

An unresolved strict failure is not a live-edge gap. It is persisted
idempotently with the exact checkpoint key and boundary, redacted provider ID,
observed head slot, fixed reason, and detected/resolved timestamps. It is not
automatically purged while unresolved. Once resolved, it is retained for four
hours and then purged. Checkpoints remain unchanged until a later strict scan
reaches the same boundary.

To limit quota without weakening the invariant, the supervisor serializes and
coalesces strict scans on one fixed 30-second V1 interval. It never starts a
second scan while one is running and never triggers an unbounded scan storm
from WebSocket volume. If the configured page window cannot reach the exact
boundary, the listener fails closed instead of increasing traffic without
limit. This trades a known bounded HTTP request floor for an explicit detected
capacity limit.

## Supervisor lifecycle

```text
STOPPED
  -> CONNECTING(provider)
  -> WAITING_FOR_ACKS
  -> RECOVERING(provider)
  -> RUNNING(provider)

RUNNING
  -> DEGRADED immediately on disconnect, protocol or enqueue failure
  -> CONNECTING(next provider)
  -> WAITING_FOR_ACKS
  -> RECOVERING(next provider)
  -> RUNNING(candidate)
  -> retire old session

strict boundary unreachable across every configured paired provider
  -> UNRECOVERABLE, fail closed

any active phase -> STOPPING -> STOPPED
```

The candidate may enqueue notifications as soon as each subscription ACK maps
its server subscription ID. Both ACKs are mandatory before strict catch-up
starts. A surviving incumbent remains accepting during candidate setup and
catch-up. Promotion occurs only after strict recovery has verified both program
boundaries and completed every required durable enqueue/checkpoint CAS; an
unchanged boundary requires no checkpoint write and may still promote.
The incumbent is retired after promotion; a stale close/error from an older
generation cannot demote the promoted candidate.

There is at most one incumbent and one candidate. Setup attempts rotate in
positional order. Each provider is tried once per cycle. Exhausted transient
cycles use capped equal-jitter exponential backoff with a one-second base and
60-second cap, then self-heal through another finite cycle. The attempt counter
resets only after full promotion to `RUNNING`, never after socket open or a
partial ACK. Network failure, ACK timeout, HTTP 429 and CAS conflict remain
transient `DEGRADED` conditions.

The exact recovery budget is one candidate setup and, after dual ACK, one
strict scan of both programs per paired provider per cycle. A 429, network or
response failure, timeout, or CAS conflict ends that provider's current
attempt; there is no nested immediate retry. After the last provider, the
supervisor applies the bounded jittered backoff before a new cycle.

`UNRECOVERABLE` is persisted only when every paired provider in one complete
cycle returns explicit `CATCH_UP_WINDOW_EXCEEDED` for the same exact durable
frontier. A cycle containing any transient failure is only `DEGRADED`, even if
other providers reported window exhaustion. It never constitutes gap proof.

Shutdown wins every lifecycle race: stop accepting, abort setup/backoff/scan,
await in-flight enqueues, close candidate and incumbent, and expose cleanup
failure without restarting recovery.

## Crash and overlap semantics

Every process start with an existing checkpoint performs fresh dual ACK then
strict catch-up before `RUNNING`. This makes recovery independent of an
in-memory transition journal:

- a crash before or after either ACK creates a fresh session and rescans;
- a crash during page reads writes no checkpoint;
- a crash after some or all enqueues replays and deduplicates them;
- a crash after one program checkpoint replays only the remaining boundary;
- a crash after both checkpoints but before promotion performs an empty or
  overlapping strict scan before promotion;
- an incumbent left open during process death may duplicate observations, but
  the inbox remains authoritative;
- a restart after an unrecoverable window repeats strict recovery and never
  selects live-edge automatically.

## Provider-affine finality

One finality reconciliation pass pins status reads, finalized root and block
proof to the same provider. The inbox records the positional provider ID that
returned a missing status. A provider change resets the consecutive-missing
counter. A signature can become `ORPHANED` only after the configured number of
same-provider misses, a strictly higher same-provider finalized root, and a
same-provider finalized block proof that the signature is absent.

Unavailable archive or block evidence retries and degrades; it does not prove
orphaning. This closes the cross-provider contradiction exposed by the HTTP
fallback audit.

## Durable health and public API

The runtime heartbeat gains an additive versioned WebSocket object:

```text
providerId: primary | fallback-1..3 | null
candidateProviderId: primary | fallback-1..3 | null
phase: STOPPED | CONNECTING | WAITING_FOR_ACKS | RECOVERING | RUNNING |
       DEGRADED | UNRECOVERABLE | STOPPING
acknowledgedAt: ISO timestamp | null
lastObservation: { observedAt, slot } | null
disconnect: { occurredAt, reasonCode } | null
recovery: { status, startedAt, completedAt, reasonCode }
```

The last observation is updated only after durable enqueue succeeds. It is a
watermark, not a completeness frontier. Signatures remain private to internal
storage and are not added to the public object. A stale heartbeat that claimed
an active session at process start becomes `UNEXPECTED_RESTART` and requires
the same strict recovery before health can return `OK`.

Before any network or public API startup, the new process durably records
`CONNECTING` and `UNEXPECTED_RESTART` when the prior heartbeat claimed an
active phase. `OK` requires exactly `phase=RUNNING` plus recovery
`NOT_REQUIRED` or `RECOVERED`. Connecting, waiting for ACKs, recovering,
unresolved strict failure, stale heartbeat, stopping and failed cleanup are
`DEGRADED`. Deployment `--require-ok` uses the same rule. Stable structured
events expose only positional IDs and fixed reason codes.

## Delivery sequence

The umbrella issue is delivered as five independent PRs:

1. #59 — paired configuration and inactive native dual-ACK session;
2. #60 — provider-affine strict scans, checkpoint CAS and unresolved failure
   evidence;
3. #61 — provider-affine finality reconciliation;
4. #62 — durable heartbeat, API/frontend health and migration;
5. #63 — production supervisor wiring, operational activation and closure of
   #57.

The first four PRs do not replace the production subscriber. This prevents a
half-built recovery state from becoming operational. PR #63 activates the
complete path only after all foundations are merged.

Every PR versions its affected specification, is developed with TypeScript
strict/ESM and bigint-safe boundaries, runs build/check/lint/docs plus focused
and full PostgreSQL tests, and receives at most three GitHub review cycles.

## Acceptance matrix

The combined delivery must cover:

- ACKs in either order, partial ACK, timeout and RPC rejection;
- malformed/oversized frames, duplicate request/subscription IDs and unknown
  notifications;
- disconnect/error before and after ACK, abort and bounded cleanup;
- incumbent/candidate overlap and stale-generation isolation;
- events during outage, between ACK and catch-up, and between scan and
  promotion;
- HTTP 429 and transient recovery failures without checkpoint movement;
- strict catch-up beyond one page, pagination inconsistency and exact window
  exhaustion;
- checkpoint CAS conflicts and crashes after every durable transition;
- deduplication across both programs, both sockets and HTTP catch-up;
- same-provider finality evidence and provider-switch reset;
- migration/backfill, four-hour operational evidence where applicable, API
  redaction, frontend parsing and deployment health;
- complete absence of signing or transaction submission capability.

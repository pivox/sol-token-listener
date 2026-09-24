# Finality Reconciler Diagnostics Design

Version: 1.0.3 — 2026-09-24 — issue #151

Status: approved under the standing operator instruction to use the recommended
safe option without pausing for resolvable questions

## Goal

Make every finality pass failure that moves the durable listener into
`DEGRADED`, and the following pass recovery, attributable through bounded
structured logs. Cleanup-timeout degradation remains governed by its existing
typed shutdown error and is deliberately outside this diagnostic family. This
change is observability-only: it does not change finality classification, retry
cadence, provider promotion, readiness, paper decisions or execution authority.

## Current limitation

`RecurringFinalityReconciler` converts initial and scheduled pass failures into
`DEGRADED` and retries. The heartbeat persists only `reconcilerState`. A canary
can therefore prove that the reconciler is unhealthy but cannot distinguish an
unavailable promoted provider, a provider epoch change, a typed finality stage
failure or an unexpected internal failure.

The inner `FinalityReconciler` already exposes a closed error stage vocabulary:
`list`, `pass`, `history`, `root`, `poll`, `block`, `revision`, `clock` and
`finality-contradiction`. The outer recurring controller currently replaces two
provider-selection failures with generic `Error` instances and discards every
failure after updating its state.

## Selected architecture

Add one optional diagnostic sink to `RecurringFinalityOptions`. The controller
classifies only trusted internal errors, builds an exact frozen diagnostic and
invokes the sink through a no-throw boundary. The production factory maps the
diagnostic to one stable Pino event. Tests may inject a monotonic-safe wall clock
through the options; production uses `Date.now`.

This keeps the finality algorithm free of logging dependencies and avoids a
PostgreSQL migration or public API change. The existing heartbeat remains the
authority for readiness. Logs explain state changes but never make the state
healthy.

Rejected alternatives:

- Persisting diagnostics in the heartbeat would widen storage and public API
  contracts before a consumer requires them.
- Logging inside `FinalityReconciler` would not observe provider-selection
  failures or the later recovery transition and would couple domain work to
  Pino.
- Adding a `Promise.race` timeout around provider RPC would leave an
  uninterruptible request running and could overlap a later pass. Transport
  cancellation requires separate evidence and design.

## Closed reason taxonomy

The public-in-process reason union is:

```text
PROVIDER_UNAVAILABLE
PROVIDER_CHANGED
FINALITY_LIST
FINALITY_PASS
FINALITY_HISTORY
FINALITY_ROOT
FINALITY_POLL
FINALITY_BLOCK
FINALITY_REVISION
FINALITY_CLOCK
FINALITY_CONTRADICTION
UNKNOWN
```

Provider-selection failures are represented by a private error type, not by
matching error messages. An `instanceof FinalityReconcilerError` maps its closed
stage to the corresponding `FINALITY_*` value; a structurally similar ordinary
object does not. Because this exported class is constructible, the contract
does not claim provenance beyond the instance check. Classification is wholly
inside a no-throw boundary so a primitive, proxy or unexpected rejection falls
back to `UNKNOWN` without property inspection.

## Diagnostic contract

Every emitted object is an exact frozen own-data object:

```ts
interface FinalityReconcilerDiagnosticV1 {
  readonly version: 1;
  readonly phase: 'DEGRADED' | 'RECOVERED';
  readonly reasonCode: FinalityReconcilerDiagnosticReason | null;
  readonly degradedAtMs: number;
  readonly observedAtMs: number;
  readonly durationMs: number;
  readonly consecutiveFailures: number;
  readonly suppressedFailures: number;
}
```

All numbers are non-negative safe integers. Counts saturate at
`Number.MAX_SAFE_INTEGER`. `observedAtMs` never regresses below the prior
diagnostic clock sample. `durationMs` is `observedAtMs - degradedAtMs`.

For `DEGRADED`, `reasonCode` is non-null and `consecutiveFailures >= 1`. For
`RECOVERED`, `reasonCode` is null, `consecutiveFailures` is the complete
saturating failure count for the incident and `suppressedFailures` reports how
many failures were not individually emitted.

The contract contains no provider URL, signature, slot, mint, transaction,
payload, error message, stack, thrown value, wallet or secret.

## Emission and bounding

An incident starts on the first failed pass after a non-degraded state. Emit a
`DEGRADED` diagnostic immediately. While the controller remains degraded:

- retain the latest closed reason code without emitting on each change;
- suppress repeated failures;
- emit one bounded summary on every twelfth consecutive failure, carrying the
  latest reason code;
- saturate all counters instead of overflowing.

A separate cadence counter cycles from 1 to 12 independently of the saturating
incident totals. Summaries therefore continue at a bounded one-in-twelve rate
even after `consecutiveFailures` reaches `Number.MAX_SAFE_INTEGER`.
The validated tracker state preserves the exact mathematical relation between
cadence and suppressed failures after total-count saturation until the
suppressed counter itself saturates. Once both counters are saturated, every
cadence position is reachable and remains valid.

`consecutiveFailures` is the total saturating failure count for the current
incident. `suppressedFailures` is the cumulative number of failures in that
incident which did not produce a `DEGRADED` diagnostic. The first diagnostic
therefore reports zero suppressed failures; a summary at failure 12 reports
ten suppressed failures because failures 2 through 11 were suppressed. Both
counts are retained on the recovery diagnostic and reset only after it has
been offered to the sink.

The public diagnostic factory enforces this suppression invariant exactly for
every unsaturated total. At the saturated total it requires at least the
mathematical baseline reached on the first saturated failure; every higher
suppression value up to saturation is reachable even though cadence is no
longer represented in the public diagnostic.

With `FAIL_START`, the first `DEGRADED` diagnostic is offered before the
original startup failure is rethrown; no retry is scheduled. On the first
successful pass after any incident, whether reached by a scheduled retry or a
later explicit `start()`, emit exactly one `RECOVERED`
diagnostic, reset the incident counters and retain the existing `RUNNING`
transition. A successful startup from `STOPPED` emits nothing. Closing an
in-flight controller does not emit recovery after closure. A close timeout
keeps its existing typed cleanup error and state; it is not reclassified as a
provider pass failure.

The sink and optional diagnostic clock are internal composition dependencies,
not untrusted extension points. They are captured once by the constructor. The
sink is called synchronously only after the diagnostic is fully validated and
frozen; a sink exception is contained and cannot alter state, retry scheduling,
readiness or shutdown. Blocking or re-entrant callbacks are unsupported and no
stronger safety claim is made.

The production logger adapter also consumes a native Promise returned by an
accidentally asynchronous logger method and attaches a rejection handler
without awaiting it. An asynchronous logging rejection therefore cannot become
an unhandled process rejection or delay retry scheduling. Arbitrary external
thenables remain outside this internal trusted boundary.

An injected diagnostic clock that throws or returns an invalid value falls
back to the trusted production `Date.now()` clock. Every accepted sample is
clamped to the previous diagnostic timestamp, so an incident stays in one
non-regressing time domain and cannot create a negative duration.

## Production logging

The production factory provides a fixed sink:

- `listener.finality_reconciler_degraded` at `warn`;
- `listener.finality_reconciler_recovered` at `info`.

The application-supplied Pino record includes only the diagnostic fields plus
the stable event name; Pino may add its normal `level`, `time`, `service` and
`msg` fields. The human message is fixed French text. No raw error is passed to
Pino.

## Unchanged safety boundaries

- `initialFailureMode='DEGRADED_RETRY'` still retries at the configured interval.
- `FAIL_START` still rejects startup and schedules no retry.
- readiness still requires `RUNNING` and the same promoted-provider selection.
- paper readiness remains blocked while finality is degraded.
- provider promotion and finality reconciliation semantics are unchanged.
- no RPC endpoint, database row, API response or frontend schema is added.
- no wallet, key, signing, submission, Mainnet request or execution capability
  is introduced.

## Tests

Unit tests cover:

- initial `DEGRADED_RETRY` classification for every trusted reason family;
- default fail-start diagnostic before rethrow, without retry regression;
- scheduled-pass degradation and recovery;
- provider-unavailable and provider-changed classification without message
  matching;
- `UNKNOWN` for primitive, hostile proxy and structurally forged errors;
- immediate first event, suppressed reason changes, twelfth-failure summary
  carrying the latest reason, saturating counters and an independent cadence;
- non-regressing time and exact duration;
- exact frozen own-data diagnostics with no extra or sensitive fields;
- a throwing sink, a throwing/invalid clock, close during an in-flight pass and
  close timeout;
- production logger mapping with fixed event names, contained synchronous and
  asynchronous logger failures, and no raw rejection data.

The normal project build, check, lint, backend/frontend tests and documentation
check remain required. The Mainnet canary is explicitly outside this PR.

## Acceptance

- A future finality pass failure that transitions the controller to `DEGRADED`
  yields a stable reason code without exposing external data.
- A recovery yields one duration-bearing structured event.
- Repeated identical failures cannot create one log per retry indefinitely.
- Diagnostic failures cannot affect finality state or retry scheduling.
- Existing finality and readiness tests remain unchanged in meaning.
- CI and post-merge CI are green.

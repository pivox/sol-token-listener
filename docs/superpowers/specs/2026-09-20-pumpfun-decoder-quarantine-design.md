# Pump.fun Decoder Quarantine and Replay Design

Version: 1.0.1 — 2026-09-20 — issue #148

Status: approved for implementation under the standing operator instruction

## Goal

Keep a Pump.fun transaction whose immutable normalized evidence cannot be decoded
out of automatic retry loops while making it explicitly replayable after a
decoder upgrade. The four-hour product retention remains authoritative.

This change is observation-only. It does not read a wallet, sign, arm, submit,
fund, quote, select a token, or change any execution gate.

## Problem

The worker already saves a normalized transaction and its SHA-256 fingerprint
before invoking the observed pipeline. A trusted Pump.fun decoder failure is
then persisted as a terminal, non-retryable `FAILED` row. This correctly avoids
retrying the same immutable bytes, but the only recovery command accepts
retryable failures that exhausted their retry budget. A decoder upgrade cannot
therefore replay the retained snapshot.

The strict catch-up classifier has a distinct pre-admission state named
`QUARANTINED`. Its PostgreSQL contract requires zero attempts, no snapshot and
catch-up classification evidence. Reusing that status for a worker-owned row
would conflate two lifecycle phases and break migration 049 constraints.

## Considered approaches

### Make known decoder failures retryable

Rejected. The immutable snapshot cannot change between attempts. This creates a
tight loop, consumes RPC/database capacity, and cannot repair an unsupported
schema.

### Move worker failures to `processing_status='QUARANTINED'`

Rejected. That status is the catch-up pre-admission classification. Its current
contract intentionally requires no worker attempt and no normalized snapshot.
Widening it would make two unrelated authorities share one ambiguous state.

### Keep terminal `FAILED` and add an explicit decoder recovery

Selected. The existing worker state already preserves the snapshot, fingerprint,
attempt counters, exact versioned stage/origin name and four-hour terminal
deadline. A dedicated recovery operation can reopen only a strictly recognized
decoder quarantine and leave ordinary non-retryable failures closed.

## Decoder-quarantine taxonomy

Version 1 recognizes only these exact trusted observed-pipeline failures:

- `ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED`;
- `ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_TRUNCATED`.

The two codes mean that the Pump.fun transaction reached the launchpad decoder
but the installed schema could not safely consume its bytes. Similar-looking
external error properties, messages, other stages, PumpSwap codes,
`PUMP_BORSH_INVALID`, `PUMP_ACCOUNT_MISSING`, and `UNKNOWN` are not eligible.
`PUMP_BORSH_INVALID` can describe malformed evidence rather than a missing
schema version and therefore stays terminal until a separate evidence-backed
decision broadens the allowlist.

A domain helper owns this closed allowlist. Worker failures remain:

```text
processing_status = FAILED
error_retryable = false
normalized_transaction != NULL
immutable_fingerprint = SHA-256(snapshot)
terminal_at != NULL
purge_after = terminal_at + 4 hours
```

This is the durable worker quarantine. It has no success timestamp, checkpoint,
finality receipt or business event.

The catch-up classifier keeps its existing pre-admission representation:
`processing_status='QUARANTINED'`,
`catch_up_reason_code='PUMP_SCHEMA_UNSUPPORTED'`, plus its bounded evidence
fingerprint. Its decoder marker already contributes the trusted origin code to
that fingerprint. This is the same decoder-incompatible taxonomy at an earlier
lifecycle phase, not the same storage status.

## Explicit recovery

`TransactionInboxRepository.recoverDecoderQuarantine(signature)` is separate
from `recoverExhausted`. The existing command and its retry-exhaustion semantics
do not change.

The new local-only CLI requires both:

```text
--signature=<exact signature>
--confirm=<same exact signature>
```

It accepts only a retained worker quarantine matching the exact allowlist, with
a valid normalized snapshot and immutable fingerprint. Replay retains and uses
that snapshot, so it does not call RPC again.

A catch-up quarantine is deliberately not eligible in V1. Its public reason
`PUMP_SCHEMA_UNSUPPORTED` groups decoder origins, normalization failure,
multi-mint ambiguity and bounded-classification overflow. The exact marker is
represented only through a one-way evidence fingerprint, so recovery cannot
prove that a historical row belongs to the closed allowlist. Rehydrating such a
row would be fail-open. A later version may persist a new explicit, constrained
origin for future catch-up classifications; it must not infer one from existing
hashes.

Inside one PostgreSQL transaction the operation locks the row, verifies the
retention deadline against `clock_timestamp()`, inserts an immutable recovery
receipt, and transitions the row to `PENDING`. It clears lease, error, retry,
processed, terminal and purge fields; resets `attempts_in_cycle`; increments the
existing `manual_recovery_count`; and sets `last_manual_recovery_at`. It never
changes signature, slot, discovery sources, program IDs, observed time, target
finality, catch-up classification, normalized snapshot, immutable fingerprint,
first-detection evidence, or first-success evidence.

Stable results are:

- `DECODER_RECOVERY_SCHEDULED`;
- `DECODER_RECOVERY_ALREADY_SCHEDULED`;
- `DECODER_RECOVERY_NOT_FOUND`;
- `DECODER_RECOVERY_EXPIRED`;
- `DECODER_RECOVERY_NOT_ELIGIBLE`.

Concurrent commands serialize on the inbox row. Exactly one inserts a receipt
and schedules replay; the other observes the already-scheduled state. An old or
stale worker lease cannot overwrite the recovery because every worker write
still requires its exact lease token and `PROCESSING` state.

## Recovery evidence and retention

Migration `051_transaction_inbox_decoder_quarantine_recovery.sql` creates
`transaction_inbox_decoder_recoveries`. It stores no raw transaction and no
arbitrary message. Each row contains only:

- signature;
- quarantine kind: `WORKER_SNAPSHOT`;
- exact bounded worker reason code;
- the applicable 64-hex snapshot/classification fingerprint;
- original quarantine time;
- recovery time;
- source `LOCAL_CLI`;
- `purge_after = recovered_at + 4 hours`.

The primary key is `(signature, quarantined_at)`. There is no foreign key to the
mutable inbox row, so normal inbox deletion cannot silently delete the audit
receipt. Shared retention deletes the receipt at its own exact deadline.

An explicit recovery is a new processing need and therefore starts a new
four-hour inbox lifecycle. Without recovery, the original terminal deadline is
never extended by rediscovery, classification replay or a repeated failure call.

The migration is transactional, replayable, compatible with a database created
from zero, and fail-closed when the table, constraints or indexes already exist
with incompatible definitions. Existing binaries can continue writing inbox
rows because no existing non-null column or method contract is changed.

## Replay outcome

After recovery the ordinary claim path owns the row:

- a fixed decoder processes the exact retained snapshot;
- all normal idempotence and projection constraints apply;
- success uses the existing `markProcessed` path;
- the same recognized incompatibility returns to terminal `FAILED` with a fresh
  four-hour deadline;
- an unknown/transient error follows the unchanged retry policy;
- finality and orphan reconciliation remain unchanged.

Recovery never declares the old transaction successful. It merely schedules one
normal processing cycle under the current decoder.

## Bounded observability

Inbox counts gain `decoderQuarantined`, computed in PostgreSQL from the exact
closed worker taxonomy. Catch-up quarantines are not included because their
exact origin is not recoverably encoded. The value is a non-negative safe
integer and exposes no signature, mint, raw payload, URL, error message or
wallet data.

The listener heartbeat gains a separate optional
`decoderQuarantine: RuntimeDecoderQuarantineMetricsV1` object containing only
`version: 1` and `unresolvedCount`. It does not add a key to the existing strict
`catchUpAdmission` V1 object. `/api/v1/health` projects the separate object;
historical or legacy absence is `null`, never a synthesized zero. Strict
decoders reject extra fields, unsafe counts and unsupported versions. The CLI
output is one stable JSON event with result code and signature; dependency
errors are redacted.

## Safety invariants

- No automatic recovery and no retry loop over an immutable incompatible
  snapshot.
- No permissive Borsh length, discriminator or schema fallback.
- No mutation of catch-up identity or evidence during recovery.
- No checkpoint, receipt or first-success timestamp before genuine pipeline
  success.
- No retention extension from rediscovery alone.
- No public endpoint can trigger recovery.
- No wallet, signing, executor, arming or submission dependency in the command.
- No JavaScript floating-point financial calculation is introduced.

## Verification

Unit tests cover the exact taxonomy, hostile values, CLI confirmation, redacted
errors, and worker behavior. PostgreSQL tests cover worker quarantine, catch-up
recovery rejection, snapshot retention, no automatic claim,
concurrent/idempotent recovery, stale leases, replay success/failure,
rediscovery, exact deadlines, audit purge, migration replay and partial-schema
rejection.

The PR gate requires build, check, lint, docs, all backend/frontend tests, live
PostgreSQL migration/repository tests, and `git diff --check`. Two review cycles
maximum apply. Mainnet canary work resumes only after merge and green
post-merge CI.

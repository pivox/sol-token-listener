# Durable Retry Cap and Manual Recovery Design

## Scope

This change makes transaction-inbox retries finite, durable, observable, and manually recoverable. It does not change Pump.fun decoding, send a Solana transaction, add an HTTP mutation, or require a private key.

## Retry policy

`RPC_RETRY_MAX_ATTEMPTS` counts claims in one automatic retry cycle, including the first claim. `RPC_RETRY_BASE_DELAY_MS` drives exponential backoff, capped at 60 seconds. Both values are validated with explicit upper bounds and snapshotted on each newly enqueued inbox row so a restart or later environment change cannot alter an in-flight cycle silently.

The existing `attempts` column remains the lifetime claim count. A new `attempts_in_cycle` column is incremented with it on every claim. A manual recovery resets only `attempts_in_cycle`; it never erases lifetime history or the immutable normalized transaction snapshot.

## Exhaustion and terminal retention

A retryable failure is automatically scheduled only while `attempts_in_cycle < retry_max_attempts`. At the limit it becomes a retryable-but-exhausted terminal failure:

- `next_attempt_at` is cleared;
- `retry_exhausted_at` and `terminal_at` are set atomically;
- `purge_after` is exactly four hours after `terminal_at`;
- the last typed ingestion error remains available as evidence.

A non-retryable failure is also terminal and retained for four hours. Expired processing leases follow the same cap: an expired lease below the cap can be reclaimed; one at the cap becomes `WORKER_LEASE_EXPIRED`, exhausted, and terminal before another row is selected.

Legacy retryable rows are backfilled with the default policy. Their cycle count is bounded to the stored maximum and the first claim pass reconciles already-exhausted rows without executing them again.

## Manual recovery

Recovery is deliberately a local operator CLI, not a public API endpoint. The command requires both the exact signature and an independent confirmation value equal to that signature. It can recover only a retained retryable exhausted failure.

The repository locks the row and atomically:

1. appends one audit record keyed by the signature and prior exhaustion timestamp;
2. changes the row to `PENDING`;
3. resets only the cycle attempt count;
4. snapshots the current configured retry policy for the new cycle;
5. clears failure, terminal, and purge scheduling fields;
6. increments the durable manual-recovery count.

Repeating the same command while that recovered row is already pending or processing returns `RECOVERY_ALREADY_SCHEDULED` without changing counters. Missing and ineligible rows return stable result codes. Database failures are redacted.

## Observability

Inbox counts distinguish scheduled retryable failures from exhausted failures. The listener heartbeat and `GET /api/v1/health` expose `exhaustedCount` independently from actionable `backlogCount`; exhausted work therefore never looks like runnable backlog and never disappears silently.

## Data model

Migration `011_transaction_inbox_retry_recovery.sql` adds row policy, cycle, exhaustion, and manual-recovery fields, widens lifecycle constraints for terminal failures, and creates the append-only `transaction_inbox_recoveries` audit table. Migration replay is idempotent and compatible with migrations 001–010 on an empty database.

## Safety invariants

- All counters and millisecond policies are integers.
- No secret, endpoint, raw database error, signing capability, or transaction submission capability reaches CLI output or the public API.
- Recovery cannot alter a processed row, a non-retryable failure, or a non-exhausted failure.
- Purge remains ordered before raw chain-event deletion and removes only rows whose durable four-hour retention elapsed.
- Observe and paper execution modes remain the only accepted modes.

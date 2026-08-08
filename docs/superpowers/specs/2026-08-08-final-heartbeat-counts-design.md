# Final heartbeat counts design

## Problem

The compiled mainnet dry run stopped cleanly and persisted every component as
`STOPPED`, but the final heartbeat retained a pre-drain backlog and one leased
transaction. The actual inbox no longer contained processing rows.

`PersistentListenerHeartbeat.write()` currently refreshes inbox counts only
for `RUNNING`. The runtime already stops producers, drains the worker and closes
the reconciler before calling `heartbeat.stop('STOPPED')`, so reusing the last
periodic snapshot discards the strongest available shutdown evidence.

## Approved solution

Before writing the durable `STOPPED` heartbeat, refresh only `inbox.counts()`.
Do not call Solana RPC during shutdown: the last HTTP and finalized slots remain
the most recent successfully observed values. Convert pending, processing and
retryable-failed counts through the existing bigint-safe bounded helper, and
persist the current processing count as `leasedCount`.

The current lifecycle remains unchanged:

```text
close producers -> drain worker -> close reconciler
                -> refresh inbox counts -> write STOPPED heartbeat
```

If the final count read or heartbeat write fails or times out, heartbeat
shutdown remains `DEGRADED` and returns the existing typed, redacted cleanup
error. A stale successful `STOPPED` snapshot must not be emitted.

## Verification

- start records the initial running counts;
- stop performs a second count read after the simulated drain;
- the final heartbeat contains the refreshed backlog and zero leases;
- stop makes no additional slot RPC calls;
- a final count failure emits no `STOPPED` heartbeat and returns a redacted
  dependency cleanup error;
- concurrent stop calls remain idempotent;
- build, check, lint and the full PostgreSQL suite remain green.


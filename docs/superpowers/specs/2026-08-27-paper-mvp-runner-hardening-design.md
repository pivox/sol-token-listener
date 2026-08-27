# Paper MVP Runner Hardening Design

## Context

The resumable Paper MVP runner holds a PostgreSQL advisory lock, but it currently checks lock ownership only while polling. A broken lock connection can therefore allow startup or persistence work to continue after ownership is lost. The durable run row also has no owner token, so a stale runner could mutate a run after a replacement runner resumes it.

Timeout and signal completion are also represented inconsistently. A late target can be stored as `FAILED` without a report, while another interrupted run can be stored as `COMPLETED` with a report whose payload does not state why collection stopped. Operational interruption and validation failure are therefore conflated.

## Decisions

### Continuous lifecycle ownership

`runApplication` receives an application lifecycle guard with an asynchronous `checkpoint()` operation. Production uses a no-op guard. The Paper MVP runtime supplies a guard backed by the prepared runner lease.

The application checkpoints:

- immediately after `beforeStart` acquires the lease;
- before and after database migrations;
- before listener construction, before and after listener startup;
- before API construction, before and after API startup; and
- before entering the application wait callback.

If ownership is lost during an asynchronous startup stage, that stage may settle, but the following checkpoint prevents the next stage. Normal cleanup closes any resource that was started. The CLI additionally checkpoints before and after `startOrResume`, each collection, terminalization, durable reload, and report export.

### Durable owner fencing

Each acquired runner lease has a random opaque `ownerId`. Migration 021 adds `runner_owner_id` to `paper_mvp_runs`.

`startOrResume(configuration, ownerId, nowMs)` claims the compatible active run for that owner or creates a run with that owner. `recordProgress` and `terminalize` require the same owner. Their locked SQL path verifies the owner before any write. A replacement process that acquires the advisory lock claims the active run, immediately fencing the stale process from progress or terminalization.

An observed advisory-lock loss is operational failure: the stale CLI exits with code 1 and does not try to mark the run failed. The active row remains resumable. Any later stale write is rejected with `RUN_OWNERSHIP_LOST`.

### Durable completion reason

Reports and completed run rows use:

```ts
type PaperMvpCompletionReason =
  | 'TARGET_REACHED'
  | 'TIMEOUT'
  | 'SIGINT'
  | 'SIGTERM'
  | 'LEGACY';
```

New CLI executions never emit `LEGACY`. `TARGET_REACHED` retains the existing validation behavior. `TIMEOUT` adds `RUN_TIMED_OUT`; `SIGINT` and `SIGTERM` add `RUN_INTERRUPTED`. Those non-target reasons always yield `technicalStatus: 'DEGRADED'` and `verdict: 'FAIL'`, even if the last collection reaches the sample target.

Timeout and signals therefore complete the durable run, export the canonical report, and exit 2. Lock loss and other operational failures may leave a resumable run or transition it to `FAILED` without a report, and exit 1.

### Migration compatibility

Migration 021 is additive and migration 020 remains byte-identical. It adds `runner_owner_id` and `completion_reason`, backfills active rows with a bounded compatibility owner, and backfills completed rows with `LEGACY` both in the column and in `report_payload.completionReason`.

The backfill must preserve every historical report field, especially `technicalStatus`, `verdict`, and `failedGateCodes`; it only adds `completionReason`. `LEGACY` report reconstruction likewise preserves historical validation behavior.

Database constraints require:

- `RUNNING`: non-null owner and null completion reason;
- `COMPLETED`: null owner, non-null allowed completion reason, and matching report payload reason;
- `FAILED`: null owner, null completion reason, and no report.

Terminalization stores the completion reason and clears the owner atomically. Historical completed rows are temporarily unfenced from the existing terminal-row immutability trigger only while the migration adds the compatibility field, after which the trigger is restored.

## Verification

Deterministic tests inject ownership loss during migration, listener startup, before `startOrResume`, during the final collection, and immediately before terminalization. Repository tests prove that replacement ownership fences stale progress and terminal writes. Domain, migration, CLI, deployment, documentation, lint, typecheck, build, and the complete test suite must pass with zero skipped tests.

## Review cycle 1 addendum

The durable run claim occurs in a dedicated application hook after the migration
stage and before listener or API construction. The prepared repository, run,
collector, stop controller, and scoped lease are then passed into the wait loop.
If later startup fails, cleanup terminalizes the run with the stable operational
failure only while the owner still matches, before teardown releases the session
lease.

Ownership changes use a second fixed advisory key. `startOrResume` takes its
exclusive transaction lock; progress and terminalization take its shared
transaction lock. A replacement therefore waits for every already-started old
mutation, commits the new owner, and fences every later stale mutation.

Collection accepts an abort signal and is raced against the immutable run
deadline, first and second process signals, and lease loss. The first signal
permits one final collection with a five-second production grace; a second signal
or lease loss aborts immediately. Late collector rejection is observed and cannot
become an unhandled rejection or overwrite a terminal report. The Paper MVP pool
alone uses finite connection, query, statement, lock, and idle-transaction
timeouts; ordinary application pool defaults are unchanged.

While a matching run is `RUNNING`, retention protects launches detected in its
inclusive time window and rejected/expired candidates that contribute to the
same strategy/version coverage. Terminalization releases that protection.
Migration 022 adds the two coverage indexes, while both materialized coverage
sets stop at 1,000,001 rows so the existing one-million validator fails closed.

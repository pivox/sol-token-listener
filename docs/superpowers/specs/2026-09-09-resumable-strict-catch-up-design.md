# Resumable strict catch-up design

Status: approved for implementation  
Version: 2
Issue: #100  
Scope: listener ingestion only; no signer, submission, wallet loading, or armament

## Revision history and implementation decisions

- v1 (2026-09-09): approved durable page-resumption design.
- v2 (2026-09-12): records the implemented terminal lookup, exact failing-key
  comparison, durable counters, atomic completion and operational pause contract.
- After no active run, `readStrictCatchUpRun` looks up retained history by
  checkpoint key, previous slot/signature and provider across every state.
  `previous.updatedAtMs` remains evidence, not identity. A matching `FAILED`
  immediately rethrows its window failure without source reads, enqueue, creation
  or duplicate failure evidence. Unexpected `COMPLETED`/`SUPERSEDED` at the still
  current frontier is a retryable consistency failure, not a recreated run ID.
- `sameFrontier` compares only the failed checkpoint key and its exact boundary
  (including null); the other program's frontier cannot affect unanimity.
- `pagesScanned` counts pages whose eligible tail cursor was durably persisted,
  not all RPC reads. A boundary-only or empty response adds no durable page.
  Scanner success counts remain invocation-local; pause counters are cumulative.

## Incident background

The Mainnet H2i rehearsal reached a durable Pump.fun checkpoint that was older
than the configured strict scan window. The scanner read the same bounded
window on every provider, found no exact boundary, persisted
`CATCH_UP_WINDOW_EXCEEDED`, and the supervisor correctly became
`UNRECOVERABLE`. During the attempt, the RPC endpoint also returned repeated
HTTP 429 responses. Its monthly allowance was mostly unused; the failure was
instantaneous request capacity, not monthly quota exhaustion.

The previous scanner buffered all discovered signatures until it found the old
checkpoint. It therefore made no durable progress when `maxPages` was reached.
Raising that bound may recover one outage, but it does not make recovery
restart-safe and can create another long, rate-limited request burst.

## Decision

Strict catch-up becomes paginated and resumable. A bounded pass is allowed to
stop with an explicit `PAUSED` outcome, while its durable run stays `ACTIVE`.
Only proven missing history produces a terminal window failure. Structurally
inconsistent pagination remains a typed retryable source failure, never proof
of irrecoverability.

The existing `live-edge` policy is unchanged. This change applies only to the
strict scanner used by the WebSocket failover supervisor.

## Rejected alternatives

### Configuration-only larger window

Using `LISTENER_CATCH_UP_PAGE_SIZE=1000` remains a useful optional operational
setting. Without durable cursors, a larger `MAX_PAGES * PAGE_SIZE` still loses
all scan progress on restart or page-budget exhaustion. It is not the durable fix.

### Silent rebaseline or checkpoint deletion

Resetting the checkpoint, deleting inbox rows, or treating the current head as
healthy would hide an observation gap. H2i and live readiness must remain
closed rather than claim lossless coverage without evidence.

### Higher worker concurrency

The current Mainnet rate already caused 429 responses. Unbounded or immediate
worker concurrency would increase pressure and does not repair catch-up
semantics. Throughput optimization and tracked-mint trade priority belong to a
separate PR.

## Durable run model

Migration `046_listener_strict_catch_up_runs.sql` adds
`listener_strict_catch_up_runs`. A run is immutable in identity and mutable only
through a revision-checked progress transition.

Each run stores:

- deterministic `run_id`, versioned from checkpoint key, exact previous
  checkpoint, and provider identity;
- checkpoint key and the exact previous slot/signature;
- pinned provider ID;
- observed head slot/signature from the first accepted page;
- `before_signature`, the cursor for the next page;
- last accepted slot/signature, used to validate monotonic continuation;
- pages scanned and signatures enqueued as PostgreSQL `BIGINT` counters;
- state `ACTIVE`, `COMPLETED`, `FAILED`, or `SUPERSEDED`;
- optional stable terminal reason;
- optimistic `revision`;
- start/update/completion timestamps and a purge deadline.

There is at most one `ACTIVE` run per checkpoint key. The active run must match
the checkpoint still stored in `processing_checkpoints`. A stale run is marked
`SUPERSEDED` before a new run can be created. Completed, failed, and superseded
runs are retained for four hours and then removed by the existing maintenance
path. Active runs are never age-purged.

No RPC URL, API key, private key, raw logs, or transaction payload is stored in
this table.

## Run identity and provider affinity

The run ID uses a stable SHA-256 canonical representation and an explicit
identity version. The initial implementation pins a run to one already
genesis-verified provider. This preserves the provider-affine recovery model
and avoids combining pagination views from different RPC nodes.

When a pass pauses because its local page budget is exhausted, the supervisor
retries that same provider after bounded jitter. It does not rotate through all
providers and duplicate the same partial walk. A transient request failure also
keeps the durable run resumable. Provider replacement during an active run is
out of scope; an explicit future recovery operation may supersede it only with
durable evidence.

Before any provider network access, the supervisor asks the repository-backed
coordinator for the provider pinned by active runs of configured keys, without
caching. If one exists, that provider is placed first
and is the only provider attempted for that cycle. Active runs for different
checkpoint keys with different providers are invalid durable state and keep
recovery degraded, as do invalid reads or a removed provider, without network
access. A transient scan failure triggers a fresh affinity read before rotation
because that scan may have committed its first page. Periodic scans enforce the
same rule. This rule also restores affinity after a process restart.

## Page protocol

For each configured program, the scanner follows this protocol:

1. Read the canonical checkpoint and the active run.
2. Validate the active run's exact checkpoint and pinned provider, superseding
   stale active state first; if absent, check retained historical identity.
3. Read a page using the persisted `before_signature` cursor.
4. Validate bounds, order, unique signatures, and continuation against the
   last accepted row.
5. Stop before the exact old checkpoint; it is not enqueued. A row below the
   previous slot without that exact match proves a missing boundary. Never
   enqueue this row or anything older; other signatures at the same slot remain
   eligible.
6. Enqueue every newly discovered signature through the existing idempotent
   inbox contract.
7. Only after every eligible enqueue succeeds, create the first run or
   compare-and-swap its revision to persist the eligible tail cursor and counters.
8. Repeat until the checkpoint is found, provider history is exhausted, or the
   per-pass page budget is reached.

A crash between step 6 and step 7 replays the page. Existing inbox identity and
finality reconciliation make that replay safe. A crash after step 7 resumes at
the next page. No ordering permits a cursor to move past a page that was not
fully enqueued.

Cross-program duplicates remain safe because `enqueue` merges discovery
program IDs for an existing transaction signature.

## Completion and checkpoint rules

Finding the exact old slot/signature completes the page walk. The scanner then
CAS-advances the canonical checkpoint from that exact boundary to the frozen
head and marks the run `COMPLETED` in one repository transaction, resolving
failure evidence atomically. The current pass observation time is the completion
and checkpoint-update time and must not precede the run update. A resumed final
page with eligible rows persists progress before completion; a boundary-only
page completes without advancing the cursor. If the boundary is in the first
page with no active run, existing direct checkpoint CAS remains sufficient.

If the first page is empty for a missing checkpoint, existing cold-start
semantics remain unchanged. If the old checkpoint is non-null and the provider
returns a short or empty page (or passes below the previous slot) before finding
it, eligible progress is persisted first, then existing failure evidence is
recorded before the exact run becomes `FAILED` with `CATCH_UP_WINDOW_EXCEEDED`.
An empty result without a run records failure directly. Pagination corruption
remains a typed source failure, never a pause.

## Application contracts

`StrictCatchUpRepository` gains focused operations to:

- read active or retained terminal runs and create an exact checkpoint/provider run;
- CAS-persist one completed page of progress;
- mark a stale run superseded;
- complete or fail a run.

The existing maintenance transaction purges terminal runs when
`state <> 'ACTIVE' AND purge_after <= clock_timestamp()` and returns the typed
`listenerStrictCatchUpRuns` counter. ACTIVE runs have no purge deadline and are
never age-purged. Listener grants are SELECT/INSERT/UPDATE/DELETE; retention
grants are SELECT/DELETE only.

The scanner returns its existing complete result when all configured programs
are recovered. Page-budget exhaustion throws a typed retryable
`StrictCatchUpPausedError` containing only provider ID, checkpoint key, run ID,
and aggregate counters. It contains no signatures or endpoints in its public
message.

The supervisor treats this error as a recoverable degraded cycle pinned to the
same provider. It must not call `becomeUnrecoverable`, promote the WebSocket
session, or report readiness `RUNNING` while any active run remains incomplete.
The next scheduled recovery resumes the run.

## Failure and concurrency behavior

- Run writes use the same checkpoint-key advisory transaction lock as canonical
  checkpoint writes.
- Every mutable update uses the expected revision and exact active state.
- A CAS conflict aborts the pass as a retryable scanner error.
- Enqueue failure leaves the cursor unchanged.
- Cursor persistence failure may cause safe duplicate enqueue on retry.
- A canonical checkpoint change supersedes the stale active run; it cannot be
  reused for the new frontier.
- Cancellation is checked before and after every awaited RPC or repository
  operation. Already committed inbox rows remain valid.
- No error is downgraded merely to make health green.

## Observability and readiness

Structured logs expose stable event names, provider ID, checkpoint key, run ID,
page/signature counters, and state where diagnostics are emitted. They never
expose signatures, RPC URLs, or secrets. No new public progress endpoint is
introduced. `CATCH_UP_PAGE_BUDGET_EXHAUSTED` is a retryable scanner outcome, not
an inbox terminal error or a durable health reason. After candidate/incumbent
cleanup, API health remains `DEGRADED`, recovery `REQUIRED`, durable reason
`RPC_UNAVAILABLE`, with one bounded jitter and no promotion or rotation. A
single pinned window failure never proves `UNRECOVERABLE`, even for a
single-provider catalogue: unanimity must cover the entire unpinned catalogue
with matching failing key and boundary.

After deployment, H2i must still pass an operational soak. A successful code
path alone is insufficient. The gate requires, over a representative 15-minute
window:

- zero HTTP 429 and zero exhausted endpoints;
- non-growing inbox backlog over 1, 5, and 15 minute windows;
- create-to-admissible BUY/SELL pair p95 no greater than 45 seconds;
- supervisor `RUNNING`, finality ready, and no unresolved strict failure;
- no signer loaded and transaction submission disabled.

Provider evidence must be fresh. For the observed Pump.fun rate, capacity must
be demonstrated rather than inferred from monthly quota. A separate executor
reserve remains mandatory for the eventual exit transaction.

## Tests

Unit tests cover run validation and deterministic IDs; first page, multi-page
pause, resume, exact boundary, short history, malformed continuation,
cancellation, enqueue failure, progress CAS conflict, and stale checkpoint.

Repository tests with real PostgreSQL cover migration replay, one active run per
key, exact identity replay, page progress CAS, crash-safe duplicate enqueue,
checkpoint completion ordering, stale-run supersession, terminal retention, and
concurrent writers.

Supervisor tests prove that `PAUSED` schedules the same provider with bounded
backoff, never promotes readiness, never rotates providers, and never becomes
`UNRECOVERABLE`; a genuinely exhausted history preserves the existing
unrecoverable behavior.

The PR must pass build, TypeScript check, lint, documentation validation, the
targeted unit/integration suites, migration replay on an empty PostgreSQL 16
database, and the complete existing test suite.

## Explicit non-goals

- no tracked-mint trade priority;
- no worker concurrency or transaction batching;
- no RPC-plan purchase or provider configuration change;
- no backlog deletion or silent rebaseline;
- no change to Pump.fun decoding or qualification thresholds;
- no wallet file access, signer, transaction construction, submission, or live
  armament;
- no claim that paper Mainnet issue #49 passed.

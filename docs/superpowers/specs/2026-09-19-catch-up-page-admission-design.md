# Strict Catch-up Page Admission Design

Version: 1.0.4 — 2026-09-19 — issue #135, sub-task 120-B3a.

## Goal and status

This change introduces the inactive page-level admission boundary required to
compose the Pump.fun catch-up classifier with `StrictCatchUpScanner`. It makes
classification, admission accounting, cancellation and restart behavior
explicit without changing production wiring.

The production factory does not construct the new page admitter, no feature
flag is added, and the legacy scanner path remains the default. There is no
live RPC, wallet, signer, transaction submission or executor dependency.

## Why a durable admission receipt is required

The strict run already stores `signatures_classified` and
`signatures_enqueued`, but B2 returned no result from either the classifier or
the repository. Once irrelevant catch-up traffic is deferred or terminalized,
these counters can differ. A crash can also occur after a prefix of a page has
been classified but before the run cursor advances.

Every repository write therefore returns an immutable receipt with:

- signature and slot identity;
- persisted classification disposition;
- persistence outcome: first record or semantic replay;
- admission outcome: catch-up enqueued the row, or it did not;
- durable ingestion priority when catch-up performed an admission.

`chain_transaction_inbox.catch_up_enqueued` and
`chain_transaction_inbox.catch_up_admission_priority` record the immutable
admission decision made by the first catch-up classification. Both are nullable
only while no catch-up classification exists; otherwise a true admission has
one enum priority and a false admission has no priority. New actionable
catch-up rows set the pair to `true` and their current priority; an actionable
signature already admitted by WebSocket sets it to `false` and `null`.
Terminal classifications set it to `false` and `null`, and deferred
classifications retain the actual tracked-mint decision made atomically by the
repository. Later mint tracking changes do not rewrite this historical receipt.

This column is necessary because a deferred trade can be admitted while its
mint is tracked and later return to `DEFERRED`. Deriving the original admission
from current inbox state would make replay counters nondeterministic.

## Existing WebSocket admission

The WebSocket and strict scanner may observe the same signature. A row that is
still pristine can receive the catch-up classification normally. A row already
claimed, processed or failed is not rejected merely because it is no longer
pristine.

For the same signature and slot, the repository atomically:

1. requires durable WebSocket provenance;
2. converges catch-up provenance, program IDs and finality using the existing
   inbox lifecycle;
3. records the catch-up classification evidence;
4. preserves the fact that catch-up did not create a second admission by
   storing `catch_up_enqueued=false`;
5. returns a recorded or replayed receipt.

Migration 049 broadens the classification constraint so terminal catch-up
evidence can annotate a non-pristine WebSocket row without rewriting its
processing lifecycle to `IGNORED` or `QUARANTINED`. The strict terminal shape
remains required when catch-up itself terminalizes a pristine row. An existing
row without WebSocket provenance remains a conflict.

If the inbox row has already been purged but a trusted finality replay receipt
proves the same finalized identity, the repository returns an explicit
already-admitted receipt. No classification counter or catch-up enqueue counter
is added for that row because no classification evidence can be attached to
the deleted inbox row.

## Page boundary

`StrictCatchUpPageAdmitter` is an optional scanner dependency. It is invoked
only for the canonical `launchpad` / Pump.fun program. PumpSwap pages always
use the existing legacy enqueue path in this change. The dead scan-wide
discovery map is not used as input because it can mix Pump.fun and PumpSwap
provenance and can grow across the whole recovery window.

The Pump.fun implementation creates a deeply immutable merged discovery array
from exactly one validated launchpad page, invokes the classifier, validates a
one-to-one receipt set, and returns page totals. Receipt order is not inferred
from source order; identity is matched by signature and slot because the
classifier deliberately persists in deterministic slot/commitment/signature
order.

For one page, the ordering invariant is:

```text
read and validate complete page
  -> classify/hydrate every slot
  -> persist or replay every receipt
  -> validate the complete receipt set
  -> update strict-run counters and cursor
  -> read the next page
  -> complete run and checkpoint only after the final page
```

Any source, RPC, decoding, repository, receipt-validation or cancellation
failure before run progression leaves the run cursor and checkpoint unchanged.
A committed receipt prefix is safe: the same page is fetched again and the
repository returns identical semantic replay receipts.

## Counter semantics

For the optional classified path:

- `signatures_classified` increments once for each page discovery whose
  classification evidence is durably recorded or replayed;
- `signatures_enqueued` increments once only when the immutable receipt says
  catch-up admitted that discovery into the processing cycle;
- a purged, already-admitted WebSocket receipt increments neither counter;
- `0 <= signatures_enqueued <= signatures_classified` always holds.

Counters are logical page totals, not write-attempt totals. Replaying a page
after a crash reproduces the same deltas; they are applied only when the run
cursor advances. The strict-run validator permits a one-row first page with
zero classified rows only for the explicit already-admitted receipt case.

The legacy path is unchanged: every persisted legacy enqueue counts as both
classified and enqueued.

## Cancellation

The classifier and page admitter require an `AbortSignal`. They check it before
and after every slot hydration barrier and every repository write. The scanner
checks it before and after page admission and before run/checkpoint mutation.
Repository transactions check it before committing when the optional signal is
provided.

An RPC request already started by the block cache is not physically cancelled
in B3a. Its result cannot start a new write after cancellation. A cancellation
racing a database commit may leave a durable receipt or run update; restart
observes and replays that durable state idempotently. Caller-aware cache
cancellation belongs to B3b production composition.

## Repository and migration rules

Migration `049_transaction_inbox_catch_up_admission_receipt.sql` is versioned,
replayable, compatible with an empty database and fail-closed on a partial or
incompatible installation. Existing classified rows are backfilled from their
original durable decision; only an admitted row copies its then-current
`ingestion_priority` into the immutable admission-priority column:

- `ACTIONABLE` -> true, except for a row already admitted by WebSocket;
- `IGNORED` / `QUARANTINED` -> false;
- `DEFERRED` -> true only when the original classified row is still in an
  admitted processing state, otherwise false.

The migration installs exact constraints tying column nullability to the
classification fields and preserves the four-hour terminal retention rules.
It does not delete or reinterpret raw chain data.

Semantic classification replay must return the stored admission bit and stored
admission priority even if current tracked-mint state or processing status
changed. Contradictory classification identity, slot, fingerprint or stored
receipt remains a typed repository conflict.

## B3a verification

Tests cover:

- legacy scanner behavior byte-for-byte at the observable boundary when no
  admitter is supplied;
- launchpad-only page admission and PumpSwap isolation;
- actionable, tracked/untracked deferred and terminal receipt accounting;
- complete-page barrier before run progression;
- partial persistence followed by deterministic replay;
- malformed, duplicate or contradictory receipts failing closed;
- WebSocket pristine, processing, processed and finalized-replay cases;
- confirmed-to-finalized convergence without duplicate admission;
- cancellation before hydration, during hydration, during persistence and
  before run/checkpoint progress;
- pause/restart and final-page checkpoint ordering;
- migration application, replay and constraint enforcement on PostgreSQL 16.

Build, strict type-check, lint, documentation checks and the complete existing
test suites remain required before review.

## Deferred B3b activation

B3b will separately add the restart-only flag disabled by default, production
factory wiring, provider-pinned block hydration, the single shared cache and
limiter, scanner/worker coordination, truthful health metrics and rollback
runbook. Activation will require `observe`, `launchpad-only`, `live-edge`, block
hydration enabled and provider-affine HTTP/WS configuration. The 15-minute
Mainnet dry-run cannot start before B3b is merged.

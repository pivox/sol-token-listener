# Pump.fun Bounded Tracking and Worker Admission Observability

Date: 2026-09-27

Issue: #177 (part C of #171)

Status: approved for implementation

Contract revision: 1.0.1

## Purpose

Parts A and B delivered a durable, monotone `worker_admitted_at` boundary and
an executable Pump.fun classification path behind
`LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED`. They deliberately kept the
historical `token_launches.terminal_at IS NULL` tracking authority and did not
expire already admitted pristine trades. Enabling that incomplete boundary on
Mainnet remains prohibited.

Part C replaces that unbounded authority with a 45-second, multi-table business
authority, demotes expired pristine trades in bounded batches, and publishes a
separate `workerAdmission.v1` diagnostic through heartbeat, API, frontend and
canary evidence. It changes no RPC concurrency, cache capacity, worker count,
wallet, signer, executor or transaction-submission path.

## Selected approach

Keep the bounded path entirely behind the existing restart-only flag:

- flag absent or false preserves the exact Part B OFF path, including legacy
  membership checks, claim SQL, first-processing cohort and write behavior;
- flag true uses one PostgreSQL clock materialized per transaction to decide
  whether a mint is fresh or extended by durable business evidence;
- every enabled claim transaction first demotes at most 256 expired pristine
  tracked trades, ordered oldest first and locked with
  `FOR UPDATE SKIP LOCKED`;
- admission evidence remains immutable: demotion never clears or rewrites
  `worker_admitted_at`;
- heartbeat diagnostics use a separately sampled, immutable aggregate and do
  not redefine the historical `catchUpAdmission` object.

A separate scanner, timer, queue or in-memory tracking cache is rejected. The
existing workers already poll `claim()` while idle, so performing a bounded
demotion immediately before each enabled claim provides restart-safe progress
without another lifecycle component.

## One database authority clock

Every enabled membership or demotion transaction materializes exactly one
millisecond-truncated PostgreSQL clock:

```sql
WITH database_clock AS MATERIALIZED (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS at
)
```

All freshness, expiry, terminal and purge decisions in that transaction use
`database_clock.at`. JavaScript `Date.now()`, a caller timestamp, transaction
`now()`, or multiple `clock_timestamp()` calls are not authority.

An enabled claim snapshots its bounded candidate set, acquires every candidate
mint lock in lexical order, and only then reads this clock. The same post-lock
millisecond is passed to demotion revalidation and tracked selection, so time
spent waiting for a mint lock cannot preserve already expired authority.
Before the limit, the clock-free preview orders temporal proofs by their
maximum structural expiry (`detected_at + window` or `eligible_until`) with
proofless mints first. Thus fresh launch or candidate proofs cannot permanently
hide expired work while only the post-lock clock makes the authority decision.

The exact boundary is inclusive on expiry:

```text
launch.detected_at + tracking_window <= database_clock.at  => expired
launch.detected_at + tracking_window >  database_clock.at  => fresh
```

Tests freeze `database_clock.at` and prove both 44.999 seconds (fresh) and
45.000 seconds (expired) for the default window.

## Durable tracking authority

An enabled Pump.fun trade mint is tracked when at least one of the following
independent proofs exists at the materialized database time.

### Fresh canonical launch

`token_launches` identifies the mint and its immutable `detected_at`. A matching
`TokenLaunchDetected` row in `domain_events` must be non-orphaned. The launch is
fresh only while the exact boundary above is not reached. A `RETRACTED` launch
or orphaned launch event never grants authority.

The V1 time-origin hypothesis is explicit and versioned: the existing launch
projection writes `detected_at = blockchainTime` when Solana supplies it and
falls back to `observedAt` only when blockchain time is absent. Part C does not
rewrite that durable timestamp. A launch discovered late by catch-up may
therefore already be outside the fresh window, which is safer than inventing a
new 45-second opportunity at observation time.

The canonical event match uses mint, `created_signature`, slot, transaction
index, instruction index and null-safe inner instruction index. It does not
infer finality from `token_launches.current_state` alone.

### Current eligible candidate

A `trading_candidates` row grants authority only when all are true:

- it is the current row (`superseded_at IS NULL`);
- `state='ELIGIBLE'`;
- `eligible_until > database_clock.at`;
- its source domain event is not orphaned.

At `eligible_until = database_clock.at` the candidate is expired and grants no
authority.

### Active paper work or holding

A `paper_strategy_sessions` row grants authority only for the existing
non-terminal operational states:

```text
BUY_PENDING
PAPER_HOLDING
WAITING_EXTERNAL_BUYS
EXIT_PENDING_QUOTE
SELL_PENDING
```

Independently, a `paper_positions.status='PAPER_HOLDING'` row grants authority.
`MANUAL_REVIEW` alone is terminal in the current schema and is deliberately
insufficient. A manual-review session still remains tracked when its referenced
paper position is independently `PAPER_HOLDING` or another proof is active.

### Non-terminal execution intent

An `execution_intents` row grants authority while its status is not one of:

```text
SUCCEEDED
FAILED
EXPIRED
CANCELLED
```

This intentionally includes `UNKNOWN_REQUIRES_RECONCILIATION`; uncertainty must
not interrupt the trades required to resolve exposure.

### Active live position

An `execution_live_positions` row grants authority in `OPEN`, `EXIT_PENDING` or
`UNKNOWN`. A `CLOSED` position does not.

The listener role never receives access to `execution_live_positions`.
Migration 056 publishes a definer-owned, `security_barrier` view exposing only
one `mint` column for active rows. `PUBLIC` receives no privilege and the
provisioning script grants `SELECT` on that view alone to
`sol_token_listener_writer`. Wallet, generation, armament, amounts, deadlines,
state details and every other live column remain inaccessible. Authority SQL
reads the view, never the base table.

### Union semantics

The SQL authority is an `EXISTS`/union-of-proofs decision keyed by mint. One
proof is sufficient and duplicate rows cannot multiply a mint. A mint may be
both fresh and extended:

- `freshMintCount` is the number of distinct fresh canonical launch mints;
- `extendedMintCount` is the union-distinct number of mints protected by at
  least one candidate, paper, intent or live-position proof, whether or not the
  launch is also fresh.

## Enabled ingress and synchronization

`enqueue`, `recordCatchUpClassification` and `syncTrackedMint` replace the
legacy `token_launches.terminal_at IS NULL` lookup only in the enabled branch.
They retain the established mint advisory-lock order and evaluate the shared
SQL authority with one transaction clock. CREATE admission stays immediate,
including CREATE plus initial BUY in one transaction.

For a classified `PUMPFUN_TRADE`:

- tracked mint: `PENDING/TRACKED_TRADE`, admitted exactly once;
- untracked mint: `DEFERRED/NORMAL`, not admitted unless it preserves earlier
  immutable admission evidence;
- ambiguous notification: remains durable `PENDING/NORMAL/NULL` until strict
  catch-up classifies it;
- multi-program evidence retains the Part B fail-closed classification rules.

Replay, restart and finality reconciliation never alter an established
admission timestamp.

## Proof/demotion serialization

`SKIP LOCKED` on inbox rows alone cannot close the race with a candidate,
position or intent becoming active concurrently. Every transaction that
creates, removes or changes a V1 tracking proof acquires the existing
namespaced mint advisory lock before locking or mutating proof rows:

```text
hashtextextended('transaction-inbox-mint:' || mint, 0)
```

A shared storage helper owns that exact namespace. Launch, candidate, paper
session/position, execution-intent and live-position repositories acquire mint
locks in canonical lexical order before their existing row locks. The demotion
transaction first snapshots at most 256 candidate mints, acquires their
advisory locks in lexical order, then reselects and locks inbox candidates and
revalidates every proof at its one database clock. A proof committed before the
listener mint lock is visible to revalidation; a producer that follows the
listener lock is linearized after demotion. No path holds a business-row lock
while waiting for the shared mint lock.

## Bounded pristine demotion

Before scheduler selection in every enabled `claim()` transaction, select at
most `MAX_WORKER_ADMISSION_DEMOTIONS_PER_CLAIM = 256` rows with:

```text
processing_status = PENDING
ingestion_priority = TRACKED_TRADE
ingestion_hint = PUMPFUN_TRADE
worker_admitted_at IS NOT NULL
```

Selection is ordered by `observed_at, observed_slot, signature` and uses
`FOR UPDATE SKIP LOCKED`. A selected row is demoted only if its mint has no
fresh or extended authority at the same materialized database time and the row
is still strictly pristine:

- `attempts=0` and `attempts_in_cycle=0`;
- no lease;
- no normalized transaction or immutable fingerprint;
- no processing/retry/exhaustion error evidence;
- no `processed_at`;
- no missing-finality polls, finality provider or finality revision;
- no manual-recovery evidence;
- no `first_processed_at` and
  `first_processing_evidence_unavailable=FALSE`;
- no decoder-quarantine or decoder-recovery evidence.

The update preserves signature, sources, programs, hint mint, observation,
first detection and `worker_admitted_at`, then writes:

```text
processing_status = DEFERRED
ingestion_priority = NORMAL
terminal_at = database_clock.at
purge_after = database_clock.at + 4 hours
updated_at >= database_clock.at
```

The existing migration-047 deferred constraint remains authoritative. Locked,
attempted, hydrated, retried, failed, processed, quarantined, finality-touched
or manually recovered work is never rewritten to look pristine. Concurrent
workers may skip one another, and subsequent polls finish the bounded backlog.
Rerun and restart are idempotent because demoted rows no longer satisfy the
selection predicate.

The scheduler counters and 32:1 / 3:1 fairness update only after an actual
claim. Demotion alone does not consume a claim or mutate fairness.

## Migration 056

`056_transaction_inbox_bounded_tracking.sql` is required. Migration 053 is
never edited, and its admitted-claim index already covers the bounded inbox
candidate scan. Migration 056 adds these drift-strict, replay-safe partial
indexes:

- `trading_candidates_worker_tracking_expiry_idx` on
  `(eligible_until, mint)` for current `ELIGIBLE`, non-orphaned candidates;
- `execution_intents_worker_tracking_mint_idx` on `(mint)` where
  `terminal_at IS NULL`;
- `execution_live_positions_worker_tracking_mint_idx` on `(mint)` for
  `OPEN`, `EXIT_PENDING`, `UNKNOWN`.

It also creates the exact one-column active-live-mint `security_barrier` view.
Existing indexes cover inbox admission, active paper sessions, holding
positions, canonical launch lookup and deferred trades. Duplicating them is
unnecessary. The migration validates exact index and view ownership, access
method, keys, predicates, view definition, security option and readiness on
first install and replay; partial or incompatible named objects fail closed. It
deletes or rewrites no business data.

## `workerAdmission.v1`

Add one immutable exact-key domain snapshot:

```text
version: 1
enabled: boolean
trackingWindowSeconds: integer 1..3600
claimableBacklogCount: non-negative safe integer
classificationPendingCount: non-negative safe integer
oldestClassificationPendingAgeMs: non-negative safe integer | null
freshMintCount: non-negative safe integer
extendedMintCount: non-negative safe integer
demotedCount: non-negative safe integer
```

Semantics at one database sample clock:

- enabled claimable backlog is actionable work with non-null admission;
- disabled claimable backlog is the exact legacy actionable backlog;
- classification pending is enabled `PENDING` work with null admission;
- oldest age is null exactly when pending count is zero, otherwise the integer
  millisecond age of the oldest pending classification;
- `demotedCount` counts currently retained rows matching
  `DEFERRED/NORMAL/PUMPFUN_TRADE`, non-null admission and the exact terminal
  four-hour retention relation;
- fresh and extended counts follow the union semantics above;
- disabled mode reports zero for pending, age, fresh, extended and demoted so
  diagnostics cannot imply that the bounded authority is active.

All counts and durations are integers. No signature, mint, URL, wallet or raw
payload is exposed.

## Heartbeat, first processing and rolling compatibility

The concrete inbox repository exposes an aggregate reader. The production
factory supplies it to `PersistentListenerHeartbeat` through an optional async
metrics callback, avoiding a new worker and avoiding changes to unrelated
repository fakes. Every new binary writes `workerAdmission`; historical
heartbeats may omit it.

`RuntimeHeartbeat.workerAdmission`, `ApiHeartbeat.workerAdmission` and the
frontend Zod field are additive and optional. Projection rules are:

- missing historical field: `null` at the backend API projection;
- omitted field from an older API during rolling deployment: `undefined` in
  the frontend;
- malformed present field: fail closed as an invalid health projection;
- valid field: detached, frozen, exact V1 data.

When the bounded policy is enabled, the first-processing cohort excludes every
`worker_admitted_at IS NULL` row until it receives canonical classification and
also excludes an admitted row once bounded demotion terminalizes it as
`DEFERRED/NORMAL/PUMPFUN_TRADE`. When disabled, the current cohort SQL and
results are unchanged. A row carrying
`first_processing_evidence_unavailable=TRUE` is never eligible for demotion and
keeps the existing explicit unavailable semantics.

`catchUpAdmission` remains unchanged and separately answers catch-up/provider
questions. `workerAdmission` answers business authority and worker-claimability
questions. Neither object derives the other.

## Frontend health contract

`GET /api/v1/health` remains API V1 and gains the optional
`heartbeat.workerAdmission` object. The health page renders a distinct
“Admission worker Pump.fun” card with:

- enabled state and configured window;
- claimable backlog;
- pending classifications and oldest age;
- fresh and extended mint counts;
- retained demotion count.

Older backend/API combinations render “backend antérieur”; historical or
absent heartbeat evidence renders “heartbeat antérieur ou invalide”. The card
does not infer readiness, profit, sellability or execution authorization.

## Canary contract

The redacted Mainnet observe-only canary accepts additive optional
`workerAdmission` evidence in the existing V1 manifest for historical fixture
compatibility. A new independent `workerAdmission` gate is `INCONCLUSIVE` when
the evidence is absent, malformed, disabled, stale, non-monotone in observation
time, or inconsistent with the heartbeat backlog.

PASS requires every observation through the persisted STOPPED heartbeat to
carry exact V1 evidence with:

- `enabled=true` and window `45`;
- `classificationPendingCount` non-growing at T+5, T+15 and final drain;
- no pending classification whose oldest age is 45,000 ms or greater;
- claimable backlog non-growing at T+5, T+15 and final drain;
- fresh/extended/demoted non-negative integer aggregates;
- stopped evidence consistent with the fresh post-stop SQL counts.

A proven pending age at or above 45,000 ms, growing claimable backlog after
T+5, or contradictory aggregate is `FAIL`. The existing first-processing,
HTTP 429, finality, idempotence, retention, quarantine, RSS, shutdown and
cleanup gates remain independent. The evaluator’s revision and fixtures are
versioned; older V1 manifests remain evaluable but cannot pass this new gate
without the evidence.

## Deployment boundary

Examples and Compose keep the flag false. After merge and green post-merge CI,
an operator may enable it only for the separate 15-minute Mainnet observe-only
canary. The runbook must require T0, T+5, T+15, final-prestop and durable STOPPED
evidence, zero HTTP 429, p95 below 45 seconds, non-growing claimable backlog,
no pending classification aged 45 seconds, clean finality/idempotence/retention,
and clean RSS/shutdown.

PASS authorizes only the next observe-only readiness step. It does not load a
wallet, arm an intent, sign, submit, buy or sell.

## Validation

Tests must prove:

- omitted/false flag exact OFF equivalence across enqueue, catch-up,
  synchronization, claim and first-processing;
- 44.999/45.000-second boundary with only PostgreSQL time;
- each of the five authority families independently extends tracking;
- source orphaning, candidate expiry and closed/terminal states remove their
  authority;
- `MANUAL_REVIEW` alone is insufficient while an independent holding is
  sufficient;
- union-distinct metrics do not double-count a mint;
- batch cap, deterministic order and real two-connection `SKIP LOCKED` behavior;
- shared mint-lock ordering and proof revalidation under concurrent proof
  insert/update/removal;
- every pristine fence blocks demotion independently;
- immediate CREATE and CREATE-plus-initial-BUY are unchanged;
- replay, restart, finality, retention and decoder quarantine remain correct;
- migration 056 installs on an empty database, upgrades from 055, replays with
  stable object identities, rejects drift, and exposes only active mint through
  the restricted live-position view;
- heartbeat storage, API projection, JSON contract, Zod schema and frontend
  rendering are rolling-compatible;
- first-processing excludes unclassified null admissions and admitted-then-
  demoted rows in enabled mode, while OFF remains exact legacy;
- the canary gate is fail-closed and all existing independent gates remain;
- no wallet, RPC budget, signer or submission behavior changes; executor
  persistence changes are limited to acquiring the shared mint lock before an
  execution-intent or live-position proof mutation.

## Acceptance criteria

- enabled tracking ends exactly at the configured boundary unless one durable
  business proof extends it;
- expired pristine admitted trades converge to retained `DEFERRED/NORMAL` rows
  without blocking canonical creations;
- claimable backlog and classification debt are distinct and observable;
- no classification is silently lost and no admission timestamp is rewritten;
- OFF mode is behaviorally identical to Part B;
- all migrations, build, check, lint, docs, PostgreSQL, frontend, E2E and
  deployment gates pass;
- at most two review cycles are used;
- no Mainnet activation, wallet access, signature or order occurs in this PR.

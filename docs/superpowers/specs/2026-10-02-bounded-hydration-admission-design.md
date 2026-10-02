# Bounded shared hydration admission — v1.0.1

## Goal and evidence

Issue #209, capacity parent #171; baseline main `c9aadef` after #207/#208.
The three existing hydration/cache/classifier suites pass 96 tests without skips.
The last Mainnet canary remains FAIL; this change alone cannot establish readiness.

Two offline reproductions show cache `queuedFetches=2`, maximum active RPC 1 and
zero oversize: mixed commitments plus a worker, and a sequential classifier plus
a worker during pacing. Provider affinity is not capacity admission. The cache
waits for pacing before dequeue, so serializing classifier commitments alone is
insufficient. A worker claim already leases a row and increments its attempt count;
waiting for capacity only inside the locator is too late.

## Alternatives and decision

1. Recommended: shared bounded group admission with a worker reservation before
   claim, lazy classifier production, immediate wakeups and explicit wait metrics.
2. Blocking all workers throughout a scan preserves affinity but delays creations
   and active positions behind the full catch-up operation; rejected.
3. Moving dequeue before pacing, clamping a counter or hiding an unbounded mutex
   queue changes appearances without bounding demand; rejected.

Standing user direction authorizes the recommended technical choice without a new
approval round. This specification is versioned before implementation. One code
review cycle applies to the resulting PR.

## Admission resource and bounded production

Use a shared controller owned by `ProviderAffineCatchUpHydration`, distinct from
its provider-affinity SCAN/WORKER permit. Admit at most ONE distinct hydration
group or unbound worker reservation at a time. The group identity includes the
current provider context/generation, slot and effective commitment; PROCESSED and
CONFIRMED map to CONFIRMED, FINALIZED remains separate. Pacing, queued cache work
and an active fetch all occupy this same slot, not separate allowances.

A reservation is exchanged for its group, not counted twice. Joining the admitted
group does not add a group slot. Keep all same-key consumers concurrent through
the cache single-flight, including oversize blocks that cannot be retained. Do not
serialize individual signatures, and do not hold admission during SQL persistence
or the business pipeline. Never release a group merely because one consumer has
cancelled while its underlying operation is still active.

Classifier production processes one effective-commitment group at a time within
the existing slot pipeline, retaining canonical output order. Rows of that group
fan out together; later groups are not launched as fetch promises. Existing
next-slot/persistence overlap remains where it does not launch two classifier
groups simultaneously. At most one classifier group waits for admission. Existing
page bounds still bound same-group fan-out; durable classification backlog remains
visible and is not dropped, classified as terminal or moved into a new database.

Worker handles are registered once per configured worker, so pending reservation
requests are bounded by that existing worker count. No unbounded generic waiter
queue is introduced. No change to worker count, RPC pacing or cache byte limits.

## Worker contract and lifecycle

Add an optional application-level admission contract to the worker, retaining the
legacy locator path when absent. The controller supplies a distinct worker handle
with an atomic pre-claim acquisition, opaque mono-use reservation and cancellation.
Implement acquisition with a cancellable capacity notification, not one-second
polling or busy retries. Admission does not wait while holding any database lock.

- Before `repository.claim`, obtain a reservation or await capacity without a
  lease, claim counter increment, `markFailed` call or degraded-worker report.
- A closed worker cancels this wait promptly. Affinity unavailable remains an idle
  condition, not a fabricated transaction error. Capacity becoming available wakes
  eligible waiters immediately. No missed wakeup between checking and subscribing.
- A null/throwing claim, invalid claim/clock, corrupt snapshot or early lease loss
  releases the reservation on every exit. Cleanup is idempotent.
- As soon as a returned claim contains a reusable snapshot, release before snapshot
  restoration, lease/pipeline work or further persistence. Likewise release before
  handling an orphan without a snapshot.
- Hydration consumes the reservation exactly once and binds it to the selected
  group/context. It must not acquire a second slot behind its own reservation.
- Release hydrated consumer ownership before `saveSnapshot` and business work.
  Actual group capacity is free only when all underlying cache operations using it
  have settled. A slow business pipeline must not block another worker's hydration.
- `close()` cancels pre-claim waiters before awaiting the worker loop. The factory
  currently closes workers before hydration, so controller close cannot be the
  only cancellation mechanism. Preserve safe draining after a real claim.

The claim API cannot reveal group/snapshot before leasing. Choose a conservative
generic reservation, then release it quickly for a snapshot. This may briefly
delay snapshot-only work under saturation; do not promise a snapshot bypass. A
repository peek or callback under the scheduler lock is deliberately not added.
This tradeoff must be measured with mixed snapshot/locator tests and the canary.

## Fairness and provider safety

Workers get the first contested dispatch, then alternate one worker reservation
and one classifier group while both roles remain pending. Use FIFO among registered
worker requests; transaction priority remains entirely inside the existing SQL
scheduler. A no-row claim releases promptly and counts as its role's turn, avoiding
classifier starvation from idle workers. When only one role waits, it proceeds
without an artificial fairness delay. Never preempt an in-flight RPC.

Provider-affinity permits remain authoritative. Bind tickets to provider revision
and scan generation; revoke stale unconsumed tickets and reject stale results.
Acquire route eligibility before group capacity: never hold the sole group slot
while waiting for an incompatible scan to release its route. A shared worker
accepted by an active scan pins that scan through its reservation and hydration,
releasing the pin before business work. Natural scan completion must not invalidate
a reservation during its database claim and manufacture a transaction retry.
Different-provider scans must not share worker fetches. Scan abort, shutdown and
selection change must settle all admitted and waiting consumers without a leak.
A genuine route change after claim may remain a retryable locator failure; lack
of capacity before claim must never be represented as one.

## Observability and compatibility

Keep existing `blockHydration` V1 fields and meanings unchanged. Introduce a
separate optional versioned heartbeat/API object `blockHydrationAdmission`, with
strict validation when present. Older stored heartbeats may omit it.

The object reports: enabled state; registered workers; current and maximum pending
workers; current and maximum pending classifier groups; current unbound reservations
and active groups; maximum combined admitted groups/reservations; grants and
cancellations by role; current oldest wait and last/maximum completed wait per role.
Counts and elapsed milliseconds are nonnegative safe integers. Empty current waits
are null, not stale maxima. A reservation exchanged for a group never inflates the
combined maximum. Clock dependency is monotonic and injectable for tests.

This is explicit upstream backpressure, not a promise that all unprocessed chain
work fits in a one-element queue. Existing durable backlog, detection-to-processing
latency and classification age remain authoritative capacity gates. The one-element
cache queue keeps its original meaning; waiters outside it are reported separately.
Do not redefine or relax the existing queue, oversize, backlog or p95 gates.

Capture the new admission object in the existing heartbeat evidence. For a runtime
emitting it, validate group/reservation and pending bounds in canary evaluation;
missing historical objects remain compatible but cannot attest the new admission
contract. Do not turn old FAIL/INCONCLUSIVE evidence into PASS. Document this
distinction in the frontend contract and canary runbook.

The factory uses the controller only on the existing provider-affine hydration
path. Disabled/legacy operation remains unchanged. No migration, financial logic,
wallet access, armament or transaction submission belongs in this change.

## Acceptance tests

1. Both queue reproductions become timeline assertions: cache queue never above 1,
   active RPC never above 1, combined admitted group/reservation never above 1;
   all deferred work is eventually served with waits visible.
2. Two workers racing for capacity cannot both claim. Waiting consumes no attempt,
   marks no transaction failed, and creates no hot polling loop.
3. Cover every reservation cleanup path listed above, double release, stale/reused
   ticket, no-row claim, invalid clock and lost lease. A blocked pipeline after
   locate does not retain capacity; snapshot reuse releases before business work.
4. Worker arrival during pacing, fetch and slot persistence; same-key joins and
   mixed commitments; repeated oversize same-group consumers perform one fetch.
5. Sustained contention obeys role alternation without starvation; SQL priority
   counters/order are untouched. Admission release wakes workers immediately.
6. Cache hit, forced refresh, provider revision/epoch change, scan abort, individual
   cancellation and close settle without old retention, lost wakeup or waiter leak.
7. Strict metric validation/round-trip, older heartbeat compatibility, disabled path,
   API contract and canary evidence include visible pre-admission waits. Bounds fail
   closed; existing latency/backlog/oversize thresholds are unchanged.
8. Run focused suites, worker/factory/API/evaluator regressions, build/check/lint,
   full local tests with PostgreSQL and CI. One independent review cycle, then merge.

Oversize representation, decoder wire suffixes and the previously proven canary
clock/count incoherences are separate issues. No claim of Mainnet readiness or
authorization to trade follows from these unit tests or the eventual merge.

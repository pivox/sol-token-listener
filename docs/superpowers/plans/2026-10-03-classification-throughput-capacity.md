# #218 classification throughput — evidence plan v1.2.0

## Operator-approved bounded experiment — plan v1.2.0

The operator's 10/2/8 RPC/s numbers are a local policy for one listener
runtime, not proof of a Helius project-specific limit. Keep H2e/H2c blocked.
Execute these mergeable slices with one external review cycle per PR:

1. RED tests for a strict rolling-second ordinary HTTP attempt budget:
   all roles share one instance, retry/failover consumes another slot,
   abort/timeout/close clear bounded FIFO waiters, no attempt or evidence is
   recorded before physical dispatch. GREEN implementation, flag OFF by
   default, no new concurrency or submit path. Verify build/check/lint/docs,
   unit/integration and CI; merge only with green evidence.
2. RED/GREEN V2 hydration/admission/heartbeat/API/verdict contract. V1 stays
   exact one-lane; V2 explicitly reports the configured and observed lanes,
   bounded queue, response/RSS evidence and budget occupancy. Preserve all
   existing 19 canary requirements; reject malformed/missing V2 evidence.
3. RED/GREEN opt-in two-distinct-group scheduler under the shared budget.
   Preserve worker fairness, provider pinning, commitment keys, ordered
   durable classification, cancellation, restart and rollback. Compare a
   short Mainnet observe-only run against the exact one-lane baseline;
   report workload, 429, backlog slope, latency and RSS. Do not call a gain
   causal merely from different live-arrival mixes.
4. Merge reviewed and green code, then run an exact-merge 15-minute
   observe-only canary. Keep FAIL/INCONCLUSIVE if any existing gate or the
   separate #215 decoder gate fails. No wallet, signer, arming or order.

Base and safety contract: [capacity design v1.2.0](../specs/2026-10-03-classification-throughput-capacity-design.md).
The checklist below is the historical v1.0.1 path to live-readiness evidence;
the v1.2.0 observe-only experiment above is permitted without calling its
local cap a project attestation. The existing 15-minute Mainnet verdict is
FAIL. This plan does not activate trading.

1. Obtain the Helius project UUID and API key through owner-only files, then
   run the existing H2e one-shot collector with a dedicated non-Solana Ed25519
   attestation key for monthly credits. Separately collect a dated, official
   project-specific RPS/concurrency limit from Helius dashboard, API or
   support; H2e `/usage` and plan ID do not contain that limit. If either
   source is unavailable, mark the corresponding capacity `INCONCLUSIVE`;
   do not guess from public pricing or the absence of 429.
2. Define an aggregate-only per-provider traffic envelope: attempts and
   429 by RPC role, p95/maximum response time, in-flight response bytes/RSS,
   and explicit worker plus future exit headroom. Add offline RED tests for
   bounded output and secret-free reporting before instrumentation. Preserve
   exact provider affinity and current retirement/finality semantics.
3. Compare candidate remedies in a versioned amendment. A two-group design
   must change group admission, cache pump, shared RPC gate/budget,
   classifier scheduling, heartbeat and canary evidence together. Prove no
   unbounded queue, worker starvation, cross-provider reuse or memory growth
   before selecting it. A source alternative must prove authoritative
   instruction identity and restart-safe catch-up.
4. Implement only the selected bounded, default-OFF option in a separate
   reviewable PR with RED/GREEN tests. Run one independent code-review cycle,
   full CI and post-merge verification. A short observe-only probe must show
   causal throughput improvement and zero 429 without gate relaxation.
5. Run a new exact-merge 15-minute observe-only canary. Keep FAIL or
   INCONCLUSIVE if backlog, p95, RSS, finality, idempotence, retention,
   terminal, decoder quarantine or cleanup evidence does not pass. Only a
   true PASS permits readiness H2d and all H2c safety gates to progress.

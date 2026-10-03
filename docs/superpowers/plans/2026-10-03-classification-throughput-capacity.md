# #218 classification throughput — evidence plan v1.0.1

Base and safety contract: [capacity design v1.0.1](../specs/2026-10-03-classification-throughput-capacity-design.md).
The existing 15-minute Mainnet verdict is FAIL. This plan does not activate
new concurrency or trading.

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

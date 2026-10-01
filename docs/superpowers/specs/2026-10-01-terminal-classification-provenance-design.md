# Terminal classification provenance — v1.0.0

Issue: #201. Scope: terminal evidence, not runtime admission or trading.

## Evidence and limitation

Canary `1ec88fa` completed its observation window but capture rolled back after
all data queries succeeded. Offline reproduction proves the builder rejects a
legitimate FAILED row retaining `PUMP_ACTION_SUPPORTED`. Classification writes
this reason; claim and markFailed retain it. The discarded canary database cannot
prove that this exact row caused its failure. Do not claim historical recovery.

## Decision

Keep classification provenance on FAILED groups. Remove only the requirement
that their normalized catch-up reason is null. Continue using the existing closed
reason parser/normalizer, error/retry consistency, counts, grouping, size bounds,
and strict artifact parser. QUARANTINED invariants remain unchanged. Version v1
shape is unchanged; old null-valued artifacts remain valid. Older validators may
reject newly accepted combinations, so capture and evaluator must use one revision.

Dropping the reason in SQL would erase provenance; changing runtime failure
transitions would change unrelated semantics. Both alternatives are rejected.

## Acceptance

- FAILED classified retryable and terminal rows round-trip without data loss.
- Capture commits after STOPPED with these rows; malformed input still rolls back.
- Arbitrary raw reason text remains normalized and never leaks into evidence.
- No migration, RPC, wallet, gate relaxation, concurrency or listener change.
- Unit/CLI/canary tests, check, lint, docs and CI pass before merge; two review cycles maximum.

## Follow-up

This repairs a proven evidence contract bug, not throughput. The failed capacity
measurements remain failed. Instrument admitted-candidate phase timings separately
before choosing a throughput change; do not relaunch Mainnet merely for this fix.

# Periodic strict-scan worker progress design

Status: proposed for issue #159  
Version: 1  
Parent: #120  
Operational gate: #149 section 5

## Problem

The Mainnet observe-only canary on `7bfada6` attested the intended 20 × 1,000
catch-up bounds and zero HTTP 429 responses, but the actionable backlog grew
from 488 to 7,051 in five minutes and first-processing p95 reached 126,158 ms.
At T+5 the incumbent provider was still promoted and healthy while its periodic
strict scan reported `scanActive=true` and `workerClaimReady=false`.

`ProviderAffineCatchUpHydration` currently grants one exclusive permit for the
entire strict-scan callback. This is required when the scan provider differs
from the promoted provider, but unnecessarily blocks the inbox worker when a
periodic scan uses the same stable promoted provider and the same global cache.

## Decision

Allow worker block hydration to share an active scan permit only when the
promoted selection exactly matches the scan provider and remains at the same
revision for the whole worker lookup.

The shared path registers the worker lookup in the scan permit's admitted-call
and pending-operation sets. It therefore uses the existing cache, pacing,
single-fetch concurrency, abort and shutdown boundaries. The scan cannot
release or change its provider context while such a lookup is settling.

Initial recovery and failover scans remain exclusive when there is no promoted
provider or when the provider differs. No provider is promoted early.

A direct, authentic page-budget pause during a periodic scan is normal bounded
continuation, not proof that the incumbent WebSocket or its provider failed.
The supervisor therefore retains that verified incumbent and its promoted
provider, moves to `DEGRADED` so trading readiness stays closed, persists that
state, and schedules the existing jittered continuation. The old session is
replaced only after the new candidate completes recovery. Initial candidate
pauses, forged/proxied errors, persistence failures and a second failure after
the one permitted inline head refresh retain their existing fail-closed reset.

## State rules

| Scan | Promoted selection | Worker claim | Route |
| --- | --- | --- | --- |
| none | stable provider | allowed | normal worker permit |
| same provider | same stable revision | allowed | active scan context |
| different provider | any | denied | none |
| any | unavailable | denied | none |
| same provider | revision changes | in-flight result rejected | none retained |
| closing/aborted | any | denied/rejected | none |

`scanActive` continues to describe the scan. `workerClaimReady` becomes true
during safe same-provider sharing and remains false for recovery scans.
This newly valid V1 combination is accepted by backend and frontend heartbeat
validators only when `providerId` is non-null and the feature is enabled.

## Invariants

- RPC caller concurrency remains one and fetch pacing is unchanged.
- A worker never crosses providers or selection revisions.
- Cache epoch invalidation remains authoritative on a selection change.
- Classifier and worker requests may join the same in-flight block fetch.
- The scan stops accepting new shared work before awaiting its pending set.
- Unknown or hostile selection values fail closed and expose no endpoint data.
- Supervisor readiness and trading readiness are unchanged.
- A periodic budget pause preserves worker/finality capacity but keeps the
  supervisor `DEGRADED` until strict recovery succeeds.
- The persisted business phase `DEGRADED` is distinct from an operational
  reporter failure: readiness reads preserve the incumbent for the former and
  clear it only for the latter.
- A failed degraded-state write closes and fences the incumbent, stops its
  heartbeat, and retains any cleanup failure for the final shutdown result.
- No wallet, signer, executor or submission path is touched.

## Verification

Unit tests prove safe same-provider progress, one-fetch joining, single RPC
concurrency, different-provider exclusion, revision fencing, shutdown and
metrics. Supervisor tests prove that a periodic pause retains the incumbent and
promotion while an initial candidate pause remains fail-closed. Contract tests
cover the new V1 metric combination. Existing production factory and cache
suites remain green.
After merge, the full 15-minute Mainnet observe-only canary is repeated; this
change does not itself reclassify backlog, latency or finality gates as passed.

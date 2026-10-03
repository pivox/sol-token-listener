# Production dependency advisory triage — design v1.0.0

Issue: #223. Base: `main@2346f0d81be6f23487ca78fb0f9ae39c475f1e35`.

## Purpose and boundary

Refresh the overdue security-policy assessment before the first real-wallet
canary. This is a documentation and risk-evidence change only: no dependency,
lockfile, SDK, IDL, runtime, wallet or executor change. It does not authorize
wallet access or a transaction, and it does not turn the observe-only probe
into a live-readiness gate.

## Evidence model

Run `npm audit --omit=dev --json` on the exact lockfile and distinguish
affected package records from independent leaf advisories. Record package
versions and transitive paths, the precise vulnerable operation, whether the
application invokes that operation on untrusted input, and the limits of that
reachability analysis. An absent demonstrated route is not a zero-risk claim.

At this base, the audit has 15 affected production records (8 high, 7
moderate) caused by five leaf advisories: `bigint-buffer`, `uuid`, two `toml`
advisories, and `stream-json`. The last three were not listed in the prior
security review. npm's proposed historical SDK/SPL downgrades are incompatible
and are not remediation evidence.

## Decision gate

`SECURITY.md` must state that observation/paper and the separately isolated
live executor have different authority. The first real-wallet canary requires
an explicit operator risk decision on remaining production advisories as one
input to the H2c/preflight process; this document alone is not acceptance.
No `npm audit fix --force`, unreviewed override, fork or SDK downgrade.

## Verification

The exact lockfile and package paths are reproducible; docs-check and diff-check
pass. One external review cycle and green CI precede merge. Reassess on new
upstream releases or before enabling a real wallet, whichever is earlier.

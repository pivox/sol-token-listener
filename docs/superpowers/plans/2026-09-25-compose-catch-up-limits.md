# Compose strict catch-up limits implementation plan

Version: 1.0.0
Date: 2026-09-25
Issue: #157

## Goal

Make the already-supported strict catch-up page limits configurable through the
production Compose deployment and attest their effective parsed values.

## Tasks

1. Add failing deployment contracts for defaults, overrides, service isolation,
   and the safe deployment environment example.
2. Add a failing bootstrap contract for the two effective integer fields in
   `listener.foundation_ready`.
3. Forward the two quoted variables only to the Compose `app` service and publish
   their defaults in `deploy/env.example`.
4. Add the two validated `AppConfig` values to the foundation log.
5. Document the defaults, bounds, H2i override, restart requirement, and log
   verification in the deployment runbook.
6. Run focused tests, build, check, lint, docs, diff check, at most two review
   cycles, then PR/CI/merge/postmerge.

## Safety boundary

No change may enable live execution, inspect a wallet, increase request
concurrency, expose RPC endpoints, or place these variables on another service.

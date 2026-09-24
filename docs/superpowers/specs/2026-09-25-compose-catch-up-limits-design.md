# Compose strict catch-up limits

Version: 1
Date: 2026-09-25
Issue: #157

## Problem

The application validates and consumes `LISTENER_CATCH_UP_MAX_PAGES` and
`LISTENER_CATCH_UP_PAGE_SIZE`, but the production Compose contract does not
forward them to `app`. Operator overrides are therefore discarded and the
runtime silently uses `20` pages of `100` signatures.

## Decision

Compose forwards both values only to `app`, as quoted strings, with the existing
safe defaults `20` and `100`. `deploy/env.example` publishes the same defaults.
No database, migration, retention, or frontend service receives them.

The existing `listener.foundation_ready` structured log reports the two parsed
integer values. This attests the effective application configuration without
logging environment contents, RPC URLs, or secrets. The values come from the
same immutable `AppConfig` passed to the production listener factory.

The H2i operator may explicitly set page size `1000` for a controlled Mainnet
observe-only canary. This change does not alter RPC concurrency, retry cadence,
defaults, wallet handling, signing, or submission.

## Verification

Static deployment tests require each variable exactly once in the `app`
environment and in `deploy/env.example`. A resolved Compose test proves defaults
and non-default overrides, and proves absence from all other services. Bootstrap
tests pin the exact effective foundation log. The deployment runbook documents
the effective-log check after restart.


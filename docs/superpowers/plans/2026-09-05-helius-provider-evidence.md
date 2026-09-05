# Helius provider evidence — implementation plan #51-H2e

> Spec: `docs/superpowers/specs/2026-09-05-helius-provider-evidence-design.md`

**Goal:** Produce the authoritative signed Helius quota envelope consumed by
H2d, without adding any wallet or live transaction capability.

## Tasks

- [x] Add strict Helius response and redacted manifest domain constructors.
- [x] Add an isolated configuration parser that only accepts external secret
  file paths and rejects wallet/live configuration names.
- [x] Add the one-request bounded Helius Admin API transport.
- [x] Add the canonical Ed25519 evidence service and local H2d verification.
- [x] Add secure file readers and atomic `0600` output.
- [x] Publish `executor:provider-evidence:dev|start` scripts.
- [x] Document the exact H2e → H2d operator handoff.
- [ ] Run focused tests, full quality gates and exactly three review cycles at
  most before merge.

## Files

- `src/provider-evidence/*`
- `src/domain/helius-provider-evidence.ts`
- `tests/helius-provider-evidence*.test.ts`
- `tests/executor-architecture.test.ts`
- `package.json`
- `.env.example`
- `docs/operations/executor-live-canary.md`
- versioned specification and this plan

## Non-goals

- no Solana keypair loading;
- no transaction signature or submission;
- no PostgreSQL mutation;
- no H2c qualification or canary sidecar generation;
- no `live:resume`, `live:arm`, H2a or H2b startup;
- no real Mainnet trade.

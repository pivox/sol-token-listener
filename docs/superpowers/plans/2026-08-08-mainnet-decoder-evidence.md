# Mainnet decoder evidence implementation plan

> **For agentic workers:** Execute task-by-task with TDD and preserve the observe-only boundary.

**Goal:** Version and validate official IDL/mainnet evidence for current Pump.fun and PumpSwap decoding without changing production behavior.

**Architecture:** One strict generic fixture contract feeds family-specific offline decoder tests. A checksum manifest attests the two official IDLs. The opt-in capture CLI minimizes one finalized normalized transaction and never enters application composition.

**Tech Stack:** TypeScript strict ESM, Node test runner, SHA-256, official Pump IDLs, normalized Solana transactions.

---

### Task 1: Official source attestation

**Files:**
- Create: `vendor/pumpfun/idl/manifest.json`
- Create: `tests/pump-official-manifest.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`

- [x] Write a failing strict manifest/checksum test.
- [x] Add the immutable official source metadata and exact artifact hashes.
- [x] Prove generated Pump/PumpSwap revision and SHA constants match it.
- [x] Document the 2026-08-08 HEAD verification and primary-source boundary.

### Task 2: Versioned minimized fixture contract

**Files:**
- Modify: `tests/helpers/pumpfun-fixture.ts`
- Modify: `tests/fixtures/pumpfun/*.json`
- Modify: `tests/pumpfun-mainnet-fixtures.test.ts`

- [x] Write failing schema, exact-key, provenance and exclusion tests.
- [x] Introduce `solana-mainnet-fixture.v1` and explicit family/redaction metadata.
- [x] Generalize the existing helper into one strict parser without weakening normalized transaction checks.
- [x] Keep every existing Pump.fun decoder assertion green.

### Task 3: Safe family-aware capture

**Files:**
- Modify: `scripts/capture-fixture.ts`
- Create: `tests/capture-mainnet-fixture.test.ts`

- [x] Test arguments, standard RPC configuration, exclusive output and source safety without network.
- [x] Support only `pumpfun` and `pumpswap`, finalized reads and matching directories.
- [x] Serialize only the V1 allowlisted fields and print fixed redacted output.

### Task 4: PumpSwap finalized evidence

**Files:**
- Create: `tests/fixtures/pumpswap/migrate-v2-create-pool-mainnet.json`
- Create: `tests/fixtures/pumpswap/sell-mainnet.json`
- Create: `tests/pumpswap-mainnet-fixtures.test.ts`

- [x] Capture the two already identified finalized public transactions with their exact block indexes.
- [x] Validate and inspect the minimized files before staging.
- [x] Assert canonical migrate/create-pool matching and current sell decoding offline.
- [x] Prove fixture directories contain no endpoint, header, log array or secret field.

### Task 5: Acceptance and review

**Files:**
- Modify only evidence documentation/counts required by verified results.

- [x] Run install/build/check/lint/test/docs check and `git diff --check`.
- [x] Review the complete diff for raw RPC leakage, unrelated production changes and oversized evidence.
- [ ] Push PR linked to #31 and request Codex review.
- [ ] Perform at most three review-correction cycles and merge only with no unresolved blocking thread.

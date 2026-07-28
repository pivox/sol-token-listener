# PR A Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a strict, deterministic, observation-safe foundation while preserving the Raydium CPMM adapter as secondary infrastructure.

**Architecture:** Source-independent domain contracts sit above Solana and market-specific adapters. The V1 bootstrap only parses safe configuration and exposes observation health; legacy Raydium simulation modules compile but are not reachable from the bootstrap.

**Tech Stack:** Node.js 22+, TypeScript ESM, node:test, ESLint, PostgreSQL, Solana web3.js, SPL Token, Raydium SDK v2.

---

### Task 1: Deterministic tooling and safe configuration

**Files:**
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `src/config/env.ts`
- Create: `tests/bootstrap-safety.test.ts`
- Modify: `package.json`
- Modify: `tests/config-safety.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Change the configuration tests to require `observe|paper`**

The tests must assert:

```ts
assert.equal(parseConfig(base).executionMode, 'observe');
assert.equal(parseConfig({ ...base, EXECUTION_MODE: 'paper' }).executionMode, 'paper');
assert.throws(() => parseConfig({ ...base, EXECUTION_MODE: 'live' }), /observe.*paper/u);
assert.throws(() => parseConfig({ ...base, SOLANA_PRIVATE_KEY_BASE58: 'secret' }), /private key/u);
```

- [ ] **Step 2: Run the configuration test and verify RED**

Run: `npm test -- tests/config-safety.test.ts`

Expected: module resolution failure for `src/config/env.ts`.

- [ ] **Step 3: Implement strict environment parsing**

`AppConfig` must expose all fields referenced by existing source, but
`executionMode` is only:

```ts
export type ExecutionMode = 'observe' | 'paper';
```

The parser rejects `live`, keypair paths, base58 private keys, and dashboard
mutation flags. Numeric SOL values are parsed to lamports using decimal-string
integer conversion rather than floating-point multiplication.

- [ ] **Step 4: Add strict compiler and lint configuration**

`tsconfig.json` uses NodeNext, `strict`, `noUncheckedIndexedAccess`,
`useUnknownInCatchVariables`, and emits to `dist`.

`package.json` scripts use:

```json
{
  "build": "tsc -p tsconfig.json",
  "check": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint . --max-warnings=0",
  "test": "tsx --test tests/*.test.ts"
}
```

- [ ] **Step 5: Add a bootstrap boundary test**

The test reads `src/app.ts` and asserts that it does not import wallet,
transaction-confirmer, trade-executor, or transaction-builder modules.

- [ ] **Step 6: Verify GREEN**

Run: `npm test -- tests/config-safety.test.ts tests/bootstrap-safety.test.ts`

Expected: all configuration and boundary tests pass.

### Task 2: Source-independent domain and ports

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/cursor.ts`
- Create: `src/domain/session-status.ts`
- Create: `src/domain/events.ts`
- Create: `src/ports/launchpad-adapter.ts`
- Create: `src/ports/market-adapter.ts`
- Create: `tests/domain-contracts.test.ts`

- [ ] **Step 1: Write contract tests**

The tests construct a multi-quote launch, compare Solana cursors, and verify that
a deterministic chain event ID changes when the inner-instruction index changes.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/domain-contracts.test.ts`

Expected: missing domain modules.

- [ ] **Step 3: Implement domain values**

Use `bigint` for raw amounts, reserves, fees, slots, and basis-point
calculations. `QuoteAsset` includes mint, decimals, and Token Program. Domain
events include all Solana cursor fields and a versioned payload.

- [ ] **Step 4: Implement generic ports**

`LaunchpadAdapter` exposes launch detection, pre-migration trade decoding, and
curve-state reading. `MarketAdapter` exposes pool detection, reserves, quotes,
and post-migration trades. Neither contract mentions Pump.fun, PumpSwap,
Raydium, WSOL, or SOL.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/domain-contracts.test.ts`

Expected: all domain contract tests pass.

### Task 3: Restore Raydium fixture decoding

**Files:**
- Create: `src/dex/raydium-cpmm/constants.ts`
- Create: `src/dex/raydium-cpmm/types.ts`
- Create: `tests/helpers/fixture.ts`
- Modify: `src/dex/raydium-cpmm/swap-classifier.ts`
- Test: `tests/swap-classification.test.ts`

- [ ] **Step 1: Run the existing fixture tests and verify RED**

Run: `npm test -- tests/swap-classification.test.ts`

Expected: missing Raydium constants or fixture loader.

- [ ] **Step 2: Restore official program constants and typed decoded structures**

Discriminators are derived from Anchor names in one tested helper, not repeated
as unexplained byte arrays.

- [ ] **Step 3: Implement the fixture loader**

The loader validates the sanitized JSON shape and converts decimal strings to
`bigint`, hex instruction data to `Uint8Array`, and all outer/inner instructions
to the normalized transaction model.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/swap-classification.test.ts`

Expected: six tests pass.

### Task 4: Restore execution, risk, and session dependencies

**Files:**
- Create: `src/dex/trade-venue.ts`
- Create: `src/dex/dex-adapter.ts`
- Create: `src/execution/transaction-queue.ts`
- Create: `src/execution/transaction-simulator.ts`
- Create: `src/execution/transaction-confirmer.ts`
- Create: `src/execution/wallet.ts`
- Create: `src/security/token-risk.types.ts`
- Create: `src/security/risk-evaluator.ts`
- Create: `src/security/passive-round-trip-probe.ts`
- Create: `src/solana/token/mint-reader.ts`
- Modify: `src/execution/trade-executor.ts`
- Modify: `tests/trade-executor.test.ts`

- [ ] **Step 1: Update paper execution tests**

Existing dry-run tests retain their behavior but use `mode: 'paper'`. Add a test
that constructing an executor with an unsupported mode is impossible through
the public configuration type.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/trade-executor.test.ts tests/risk-policy.test.ts tests/session-engine.test.ts`

Expected: missing dependencies.

- [ ] **Step 3: Implement minimal typed dependencies**

Restore interfaces and pure evaluation logic. Paper execution persists
`SIMULATED` or `FAILED` and never signs or sends. Legacy confirmer/wallet modules
exist only as isolated compatibility modules and are not imported by bootstrap.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/trade-executor.test.ts tests/risk-policy.test.ts tests/session-engine.test.ts`

Expected: all existing behavioral tests pass.

### Task 5: Restore Solana normalization, storage, and diagnostics

**Files:**
- Create: `src/solana/rpc/types.ts`
- Create: `src/solana/rpc/rpc-client.ts`
- Create: `src/solana/rpc/transaction-fetcher.ts`
- Create: `src/storage/database.ts`
- Create: `src/storage/repositories.ts`
- Create: `src/storage/ignored-asset.repository.ts`
- Create: `src/utils/json.ts`
- Create: `src/utils/logger.ts`
- Create: `src/heartbeat/heartbeat.ts`
- Create: `src/dashboard/action-dashboard.ts`
- Create: `src/dashboard/dashboard-action.service.ts`
- Create: `scripts/migrate.ts`
- Create: `scripts/lint.ts`

- [ ] **Step 1: Add bigint JSON and repository tests**

The test verifies exact round-trip serialization of nested `bigint` values and
deterministic repository identifiers.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/storage-foundation.test.ts`

Expected: missing storage foundation.

- [ ] **Step 3: Implement transactional migration execution and repositories**

Migrations run lexically, record a version only after commit, and can be invoked
twice. Event claiming uses `ON CONFLICT DO NOTHING` and a processing lease.

- [ ] **Step 4: Implement read-only diagnostic support**

Dashboard actions always return forbidden in V1. The heartbeat and logger emit
JSON-safe values. No module logs secrets.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/storage-foundation.test.ts`

Expected: storage foundation tests pass without a live database.

### Task 6: Safe bootstrap, foundation migration, and documentation

**Files:**
- Replace: `src/app.ts`
- Create: `migrations/002_pumpfun_foundation.sql`
- Create: `docs/architecture/pumpfun-v1.md`
- Create: `docs/api/v1.md`
- Modify: `README.md`

- [ ] **Step 1: Write migration-contract tests**

The test asserts the migration creates `raw_chain_events`, `domain_events`,
`state_transitions`, retention columns, lower-case confirmation statuses, and
contains no private-key or live-execution fields.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/migration-contract.test.ts`

Expected: foundation migration missing.

- [ ] **Step 3: Implement the append-only foundation schema**

Use deterministic primary keys, `NUMERIC(78,0)`, explicit indexes, and
`purge_after`. Legacy Raydium tables remain untouched.

- [ ] **Step 4: Replace bootstrap with observation-only composition**

The bootstrap parses configuration, optionally migrates, emits structured
health, and handles shutdown. It never imports execution or signer modules.

- [ ] **Step 5: Document the product boundary**

README and architecture docs state Pump.fun V1 goals, Raydium secondary status,
four-hour terminal retention, public read-only API intent, and absence of real
execution guarantees.

- [ ] **Step 6: Run full verification**

Run:

```text
npm run build
npm run check
npm run lint
npm test
```

Expected: every command exits zero with no warnings.

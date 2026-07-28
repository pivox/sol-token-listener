# PR D — Pump.fun Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist immutable Pump.fun metadata, bonding-curve states and trades with four-hour retention, without composing a listener.

**Architecture:** Add a versioned PostgreSQL migration and focused repositories. Define public metadata and bonding-curve ports independently of HTTP/RPC, then provide only a bounded HTTP metadata implementation. Runtime composition and chain reads remain absent.

**Tech Stack:** TypeScript strict ESM, PostgreSQL/`pg`, Node `fetch`, bigint, `node:test`.

---

### Task 1: Define observation contracts

**Files:** Create `src/domain/pumpfun-observation.ts`, `src/ports/metadata-provider.ts`, `src/ports/bonding-curve-snapshot-store.ts`; test `tests/pumpfun-observation-contracts.test.ts`.

- [ ] Write RED tests for metadata normalization and invalid shapes.
- [ ] Run `npx tsx --test tests/pumpfun-observation-contracts.test.ts`; expect missing module.
- [ ] Implement immutable `PublicTokenMetadata`, typed `MetadataResolution`, `MetadataProvider`, `BondingCurveSnapshot` and `PersistedLaunchTrade`. Financial fields and reserves are `bigint`; normalized results are frozen.
- [ ] Rerun the focused test; expect PASS.
- [ ] Commit: `feat: define Pump.fun observation persistence contracts`.

### Task 2: Add replayable PostgreSQL projections and retention

**Files:** Create `migrations/003_pumpfun_observations.sql`; modify `src/storage/database.ts`, `tests/migration-contract.test.ts`; create `tests/pumpfun-persistence-migration.test.ts`.

- [ ] Write RED assertions for `token_metadata_snapshots`, `bonding_curve_snapshots`, `launch_trades`, `NUMERIC(78,0)`, complete cursor uniqueness and `purge_after`.
- [ ] Run `npx tsx --test tests/pumpfun-persistence-migration.test.ts`; expect missing migration.
- [ ] Implement tables linked to `token_launches` with `ON DELETE CASCADE`, JSONB versioned payload, monetary `NUMERIC(78,0)`, idempotent natural keys and purge indexes.
- [ ] Extend `purgeExpiredFoundationData` to delete metadata, trades and curve snapshots before launches in its existing transaction.
- [ ] Run migration tests; expect PASS.
- [ ] Commit: `feat: add Pump.fun observation projections`.

### Task 3: Persist snapshots idempotently

**Files:** Create `src/storage/pumpfun-observation.repository.ts`; test `tests/pumpfun-observation.repository.test.ts`.

- [ ] Write RED tests using a recording `pg` pool for success/failure metadata, curve cursor, deterministic trade ID, `ON CONFLICT`, and bigint SQL values serialized as decimal strings.
- [ ] Run repository test; expect missing repository.
- [ ] Implement parameterized `upsertMetadataSnapshot`, `upsertBondingCurveSnapshot` and `upsertTrade`. Store only public versioned JSON; never headers, credentials or raw RPC responses.
- [ ] Run focused test, `npm run check`, and `npm run lint`; expect PASS.
- [ ] Commit: `feat: persist Pump.fun observation snapshots`.

### Task 4: Implement bounded public metadata retrieval

**Files:** Create `src/metadata/http-metadata.provider.ts`; test `tests/http-metadata.provider.test.ts`.

- [ ] Write RED tests for valid JSON, non-HTTP URI, non-OK response, invalid JSON, oversized body, redirect limit and timeout.
- [ ] Run provider test; expect missing provider.
- [ ] Implement `http:`/`https:` validation, injected fetch, manual bounded redirects, abort timeout, byte cap, JSON-object validation and extraction of image/video/site/X/Telegram. Return typed failures instead of throwing remote payloads.
- [ ] Rerun provider test; expect PASS.
- [ ] Commit: `feat: fetch bounded public token metadata`.

### Task 5: Document and verify the boundary

**Files:** Modify `docs/architecture/pumpfun-v1.md`, `README.md`.

- [ ] Document public-only metadata, immutable/idempotent snapshots, four-hour terminal retention, deferred social verification, and absence of listener/RPC composition.
- [ ] Run `npm install`, `npm run build`, `npm run check`, `npm run lint`, `npm test`, and `git diff --check`; all must exit 0.
- [ ] Scan `src/metadata`, `src/storage`, and `migrations` for transaction submission, keys and secrets; expect no execution or secret path.
- [ ] Commit: `docs: describe Pump.fun persistence boundary`.

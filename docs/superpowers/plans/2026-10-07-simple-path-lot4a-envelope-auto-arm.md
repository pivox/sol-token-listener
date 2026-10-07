# Simple path, lot 4a: entry envelope + auto-arm daemon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
1. The operator creates a signed `ENVELOPE` safety qualification and a TTY-confirmed entry envelope, then resumes control (`RUNNING`).
2. A new long-running process, `executor-operations auto-arm`, runs as `sol_token_executor_operations`. It arms each eligible `fast-entry-v1` BUY intent inside the ACTIVE envelope, one at a time (K=1).
3. The existing live executor (H2b) `buy` lane executes the armed intent, unchanged.
4. The existing recovery (H2a) `deadline` lane sells at the deadline. Its decision-event foreign key bug is fixed.
5. The envelope counters are maintained:
   - `buys_armed`: in the arming transaction, by trigger.
   - `realized_loss_raw`: in SELL reconciliation.
   - State: `EXHAUSTED` / `EXPIRED` / `REVOKED`.

Nothing is signed or sent by the code added here. Signing stays in H2b.

**Architecture:**
- **No new lane in H2b.** Arming is done by `src/executor-operations/auto-arm-main.ts`. It is a separate entrypoint, so the TTY CLI graph `src/executor-operations/main.ts` stays RPC-free, as `tests/executor-architecture.test.ts:26-41` requires. It reuses:
  - `SolanaReadinessRpcGateway.observeWallet` (`src/executor-readiness/rpc-gateway.ts:41-134`) for the wallet snapshot;
  - the existing v2 armament path (`armCanary`, `src/storage/execution-operations.repository.ts:425-535`), factored into a shared transaction body. That body takes an extra `envelopeId`.
- **The qualification gets payload version 2 = scope `ENVELOPE`.**
  - It is valid for up to 24 h. `CANARY` stays payload version 1, with exactly 5 min and byte-identical fingerprints.
  - For `ENVELOPE`, gates 7 (provider) and 9 (wallet) carry deterministic binding evidence: generation + provider id. They are not snapshot ids.
  - This is relaxed consistently in all layers:
    - the domain;
    - canary evidence;
    - `assertCanaryQualification`;
    - the 035 CHECK and the 039 insert trigger (replaced in 065);
    - the H2b signing/replay checks.
- **The envelope is the human consent.**
  - `envelope create` is TTY-confirmed. It records a v1 authorization `action='ENVELOPE'`, consumed in the same transaction.
  - It inserts the envelope (payload v2) and the `ENVELOPE` qualification bound to it (`qualification.envelope_id`).
  - Per-armament v2 `ARM CANARY` authorizations are issued by the daemon, with `operator_id` = the envelope's operator.
  - The 065 armament trigger only accepts an `ENVELOPE` qualification for an armament whose `envelope_id` points to an ACTIVE v2 envelope. The envelope must be in its window and within its caps. The trigger then increments `buys_armed` itself.
- **K=1 is structural.** An armament stays `LOCKED` until the SELL reconciliation consumes it (`execution-live.repository.ts:4891-4898`). The unique index `execution_activation_armaments_generation_active_unique` (035) allows only one ARMED/LOCKED armament per generation.

**Tech Stack:** TypeScript (tsx, node:test), PostgreSQL 16 (pg).

Spec: `docs/superpowers/specs/2026-10-06-simple-path-design.md` («Enveloppe», «Lane arm», «Qualification de sécurité portée par l'enveloppe», «Lane exit», «Lots»).

**Deviations from the spec and from the original lot 4 (decided while planning):**
1. **Split into 4a / 4b.**
   - 4a covers: envelope, `ENVELOPE` qualification, auto-arm, deadline FK fix, envelope counters, migration 065.
   - 4b covers: exit lane (creator sell / take-profit / N external buyers), `LiveExitDecided`, the `report` CLI, and `market_pools` in creates-only.
2. **Arming is an operations daemon, not an H2b lane** (binding user decision).
   - It needs no `EXECUTOR_ENTRY_ENVELOPE_ENABLED` flag: running the daemon is the switch.
   - The live role gains only two SELECT grants (Task 9).
3. **No `LiveExitDecided` in 4a.** The deadline SELL intent uses the BUY intent's own `decision_event_id` as its decision event (Task 4).
   - The FK (`migrations/043:96-107`) is then satisfied by a row that already exists, and is already pinned by the BUY intent's `ON DELETE RESTRICT`.
   - This needs no new event type, no `api_event_stream` CHECK change, no frontend change and no new recovery grant.
   - The exit reason stays readable from `strategy_id='maximum-holding-exit'` and `logical_command_id='maximum-holding:<position>'`. The intent id does not depend on `decisionEventId` (`src/domain/execution-intent.ts:229-241`).
4. **`ENVELOPE` qualification production** (the spec says "même CLI preflight").
   - `executor-operations envelope prepare` (ops DB role) assembles an unsigned qualification draft from three things:
     - the gate catalog: static gates and strategy;
     - the generation;
     - the latest matching SUCCESS mainnet simulation artifact (gate 10).
   - H2f (`preflight-bundle`, holds the Ed25519 key, offline) signs it.
   - `envelope create` reads the signed file with the same verifier as `preflight` (`verifySignedSafetyQualificationEvidence`).
   - `preflight` refuses v2: the qualification↔envelope binding is written atomically by `envelope create`.
5. **The risk policy comes from the gate catalog's `policy`** (same file as H2g). It is stored in the envelope (`risk_policy`, `policy_fingerprint`), fingerprinted, and shown at TTY.
   - `envelope create` rejects policies that could block a buy before the envelope's own loss cap: it evaluates `evaluateBuyRisk` with `realizedNetPnl = -max_realized_loss_raw`.
6. **Admission refused → the intent stays PENDING and expires by TTL** (spec: FAILED). The ops role has no intent status grant, and adding one is not minimal. The daemon remembers the intent id in memory and does not retry it.
7. **Exposure cap = cumulative.** Arming requires `(buys_armed + 1) × per_buy ≤ max_total_exposure_raw`; with K=1, concurrent exposure is at most `per_buy`. It is enforced by a 065 table CHECK and by the trigger.
8. **Realized loss = sum of per-position losses.** Each closed position adds `max(0, −net_lamports)`, computed exactly like `execution_live_position_ledger.net_lamports`. Gains do not offset losses. This is conservative.
9. **Revoke does not force a sale in 4a.**
   - It sets the envelope to `REVOKED` and revokes any ARMED (not yet LOCKED) armament, releasing its reservation.
   - A BUY that is already LOCKED proceeds. Open positions sell at the deadline.
   - Revoke does not expire the qualification, so the SELL still passes `readSellPreparationBinding` (`execution-live.repository.ts:2776`).
10. **Arming cut-off.** No armament unless `valid_until ≥ now + maximum_holding_ms + 15 min` (DB trigger + domain constant). This keeps the `ENVELOPE` qualification valid until the deadline SELL is submitted: SELL preparation requires it unexpired (`:2776`) and so does BUY submission (`:3857`).
11. **Dry-run / simulation workers are not changed** (no `fast-entry-v1` exclusion). Their claims (`execution-intent.repository.ts:203-212`, `:1226-1250`) would take fast-entry intents.
    - That is an availability risk only (lost opportunities), not a safety risk. Arming requires `lease_owner IS NULL` and status PENDING (`execution-operations.repository.ts:956-963`, `039:801`).
    - The simulation-only worker is also the easiest source of the gate-10 artifact (`src/executor/simulation-worker.ts` has no lineage check).
    - Runbook: do not run them together with auto-arm.
12. **The lineage open point from the checkpoint does not block 4a.** `EXECUTION_INTENT_CURRENT_LINEAGE_SQL` is only used on v3/preflight paths (`execution-operations.repository.ts:471-473`, `:873-883`). The v2 path and H2b never call it.
13. **Fast-entry intent TTL goes from 30 s to 120 s** (Task 4).
    - Arming requires `intent.expires_at ≥ now + 2×lease` (`execution-operations.repository.ts:1011`, `039:807`).
    - The lease must satisfy `rpcTimeout×4 + dbTimeout×6 + 1000 ≤ lease` (`src/executor-live/config.ts:71-73`). With `.env.example` values this is ≥ 35–40 s, so a 30 s intent can never be armed.
    - 120 s equals the deadline-SELL TTL and is far below `EXECUTION_INTENT_MAXIMUM_TTL_MS`.
    - Price staleness is bounded by the intent's `minimumAmountOutRaw`: the decision quote minus 10 %. It is the protected amount at signing (`src/executor-live/signed-simulation-context.ts:111`).
    - The daemon refuses to start if `2×lease + 20 000 > 120 000`.

**Environment:**
- Worktree `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile` (currently on the merged `feat/fast-entry`). Create the branch with `git -C <worktree> fetch origin && git -C <worktree> switch -c feat/envelope-auto-arm origin/main`.
- Postgres: `TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test`. Never use 5432.
- Never run a listener, an RPC, the daemon against a real endpoint, or any real transaction. All RPC is faked in tests.
- One test: `TEST_DATABASE_URL=... npx tsx --test tests/<file>.test.ts`.
- Full suite: `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test npm run test:backend`. `qualification-projection.repository.test.ts` timeouts are a known flaky case.

**File map:**

| File | Change |
|---|---|
| `src/domain/execution-safety-qualification.ts` | v2 `ENVELOPE`, binding gates |
| `src/domain/execution-canary.ts` | scope-aware gate binding |
| `src/domain/execution-operations.ts` | authorization action `ENVELOPE` |
| `src/domain/execution-provider-quota.ts`, `src/domain/execution-provider-attestation.ts` | provenance `EXECUTOR_COUNTERS` (never signed) |
| `src/domain/execution-entry-envelope.ts` (new) | envelope identity/validation, arming decision, provider carry-forward, arm authorization |
| `src/domain/execution-preflight-draft.ts` | `createEnvelopeQualificationDraft` |
| `src/domain/fast-entry.ts` | TTL |
| `migrations/065_entry_envelope_auto_arm.sql` (new) + registration files | |
| `src/storage/execution-operations.repository.ts`, `src/ports/execution-operations-repository.ts` | envelope lifecycle, `armEnvelope`, context, provider refresh |
| `src/executor-operations/{main,config,service,terminal}.ts`; new `auto-arm.ts`, `auto-arm-main.ts` | |
| `src/preflight-bundle/{service,main}.ts` | sign envelope drafts |
| `src/storage/execution-live.repository.ts` | runnable work, signing relaxation, deadline FK, realized loss |
| `src/executor-live/startup-validator.ts`, `src/executor-live-recovery/{database-authority,startup-validator}.ts` | |
| `scripts/provision-executor-roles.sql` | |
| `package.json` | scripts |
| `.env.example`, `docs/operations/executor-live-canary.md`, checkpoint | |
| Tests | listed per task |

---

### Task 1: Domain, `ENVELOPE` qualification scope (v2) and scope-aware layers

**Files:**
- `src/domain/execution-safety-qualification.ts`
- `src/domain/execution-canary.ts`
- `src/domain/execution-operations.ts`
- `src/domain/execution-provider-quota.ts`
- `src/domain/execution-provider-attestation.ts`
- tests: `tests/execution-safety-qualification.test.ts`, `tests/execution-canary.test.ts`, `tests/execution-operations.test.ts`, and the provider quota/attestation tests (`grep -ln createProviderUsageSnapshot tests`)

- [ ] **Step 1: Write failing tests.**
  - Qualification:
    - Every existing v1 fixture keeps its exact `qualificationId` and `qualificationFingerprint`. Pin one literal fingerprint from an existing fixture.
    - v1 input carrying a `scope` key is rejected.
    - v2 with `scope:'ENVELOPE'`, `phase:'CANARY'`, TTL 1 ms, 1 h and 24 h passes.
    - v2 with TTL 24 h + 1 ms, or with TTL 0, is rejected.
    - v2 with `phase:'MICRO_LIVE'` is rejected.
    - v2 whose gate 7 or 9 is not the binding evidence from `createEnvelopeBindingGates` is rejected.
    - The v2 fingerprint differs from the v1 fingerprint for identical other fields.
    - `qualificationScope(v1)==='CANARY'` and `qualificationScope(v2)==='ENVELOPE'`.
  - Canary evidence:
    - v1 is unchanged: gate ids must equal the snapshot ids.
    - With a v2 qualification, snapshots with a different id but the same `generationId` / `providerId` are accepted.
    - A wallet snapshot with another `providerId`, or a provider snapshot with another `providerId`, is rejected.
    - `createExecutionArmamentRequestV2` builds with a v2 qualification.
  - Authorization:
    - `createOperatorAuthorization({ action:'ENVELOPE', phase:null, payloadVersion:1, ... })` works.
    - `ENVELOPE` with a phase is rejected.
    - ARM and RESUME fingerprints are unchanged (pin an existing one).
    - v2 `ENVELOPE` is rejected.
  - Provider:
    - `createProviderUsageSnapshot({ ...provenance:'EXECUTOR_COUNTERS' })` works.
    - `verifySignedProviderUsageEvidence` rejects a signed `EXECUTOR_COUNTERS` payload.
- [ ] **Step 2: Implement.**

```ts
// execution-safety-qualification.ts
export const ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS = 86_400_000;
const INPUT_KEYS_V2 = Object.freeze([...INPUT_KEYS, 'scope'] as const);
export interface ExecutionSafetyQualificationV2
  extends Omit<ExecutionSafetyQualificationV1, 'payloadVersion'> {
  readonly payloadVersion: 2; readonly scope: 'ENVELOPE';
}
export type ExecutionSafetyQualification = ExecutionSafetyQualificationV1 | ExecutionSafetyQualificationV2;
export function qualificationScope(q: ExecutionSafetyQualification): 'CANARY' | 'ENVELOPE' {
  return q.payloadVersion === 2 ? 'ENVELOPE' : 'CANARY';
}
/** Gates 7 and 9 of an ENVELOPE qualification bind to identities, not to snapshot instants. */
export function createEnvelopeBindingGates(input: { generationId: string; walletPublicKey: string;
  providerId: string; observedAtMs: number; expiresAtMs: number }): Readonly<{
  provider: ExecutionSafetyGateEvidenceV1; wallet: ExecutionSafetyGateEvidenceV1 }> {
  // provider: gateId PROVIDER_EXIT_CAPACITY_VERIFIED, evidenceType PROVIDER_SNAPSHOT,
  //   evidenceId `envelope-provider:${providerId}`,
  //   evidenceFingerprint hash(['execution-envelope-provider-binding-v1', generationId, providerId])
  // wallet: gateId WALLET_CHAIN_LIMITS_VERIFIED, evidenceType WALLET_SNAPSHOT, evidenceId generationId,
  //   evidenceFingerprint hash(['execution-envelope-wallet-binding-v1', generationId, walletPublicKey])
}
export function createSafetyQualification(input: unknown): ExecutionSafetyQualification {
  // Read payloadVersion via an own-data-property descriptor first.
  // 1 -> the existing body, untouched (exactRecord(INPUT_KEYS), TTL === 300_000, tag 'execution-safety-qualification-v1').
  // 2 -> exactRecord(INPUT_KEYS_V2); scope === 'ENVELOPE'; phase === 'CANARY';
  //      0 < expires - qualified <= ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS; evidenceFrom(...);
  //      gates[7] and gates[9] evidenceId/evidenceFingerprint === createEnvelopeBindingGates(...);
  //      fingerprint = hash(['execution-safety-qualification-v2', 2, 'ENVELOPE', phase, buildHash, ...same list as v1...]);
  //      return Object.freeze({ ..., payloadVersion: 2, scope: 'ENVELOPE', ... }).
}
```

  - **Canary evidence** (`execution-canary.ts:35-37`): keep the v1 equality branch as-is. Add the v2 branch with these checks:

```ts
walletSnapshot.generationId === q.generationId
  && walletSnapshot.providerId === q.providerId
  && providerSnapshot.providerId === q.providerId
```
    Type `qualification` as `ExecutionSafetyQualification`. The evidence fingerprint formula is unchanged.
  - **Authorization** (`execution-operations.ts:192-233`): `action` is `'ARM' | 'RESUME' | 'ENVELOPE'`; `phase` must be null unless ARM. `createOperatorAuthorizationV2` stays ARM/RESUME only.
  - **Provider:** add `'EXECUTOR_COUNTERS'` to `PROVENANCES` (`execution-provider-quota.ts:44`). In `execution-provider-attestation.ts`, reject it explicitly before line 63.
  - Fix the compile errors that `npm run build:backend` lists by widening to `ExecutionSafetyQualification` where both scopes flow: canary evidence, armament request/V2 types, ops service/repository signatures, preflight bundle.
- [ ] **Step 3:** Run the four test files and the build.
- [ ] **Step 4: Commit.** `feat(domain): ENVELOPE-scoped safety qualification, ENVELOPE authorization, executor-counter provider provenance`

### Task 2: Domain, envelope module and envelope qualification draft

**Files:**
- create `src/domain/execution-entry-envelope.ts`, `tests/execution-entry-envelope.test.ts`
- modify `src/domain/execution-preflight-draft.ts`, `tests/execution-preflight-draft*.test.ts` (find with `grep -ln createExecutionPreflightDraft tests`)

```ts
export const ENVELOPE_EXIT_MARGIN_MS = 900_000;          // mirrored in the 065 trigger
export const ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS = 900_000; // 035 CHECK armed_at + 15 min
export interface EntryEnvelopeV2 { envelopeId; payloadVersion: 2; fingerprint; generationId; operatorId;
  perBuyQuoteAmountRaw: bigint; maxBuys: number; maxTotalExposureRaw: bigint; maxRealizedLossRaw: bigint;
  maximumHoldingMs: number; validFromMs: number; validUntilMs: number; policy: ExecutionRiskPolicyV1;
  qualificationId: string }
export function createEntryEnvelope(input: unknown): EntryEnvelopeV2;
// fingerprint = sha256(JSON(['execution-entry-envelope-v2', generationId, operatorId, qualificationId,
//   policy.policyFingerprint, perBuy, maxBuys, 1, maxExposure, maxLoss, holdingMs, validFromMs, validUntilMs]))
// envelopeId = 'execution_entry_envelope_' + fingerprint
export type EnvelopeIdleReason = 'NO_ENVELOPE' | 'CONTROL_NOT_RUNNING' | 'UNKNOWN_BLOCK' | 'ACTIVE_ARMAMENT'
  | 'OPEN_POSITION' | 'WINDOW_CUTOFF' | 'CAPACITY' | 'LOSS_CAP' | 'NO_INTENT' | 'POLICY_FRESHNESS';
export function evaluateEnvelopeArming(context: EnvelopeArmingFacts): { kind: 'ARMABLE' } | { kind: 'IDLE'; reason: EnvelopeIdleReason };
export function createEnvelopeProviderSnapshot(input: { latest: ProviderUsageSnapshotV1; localUsedUnits: bigint;
  measuredAtMs: number; maximumAgeMs: number }): ProviderUsageSnapshotV1;
// plan/period/limit copied; usedUnits = min(limit, latest.usedUnits + local) (throw if over limit);
// expiresAt = min(measured + maxAge, billingPeriodEndsAt); provenance 'EXECUTOR_COUNTERS'.
// Throws if measuredAt <= latest.measuredAt or measuredAt >= period end.
export function createEnvelopeArmAuthorization(input: { generationId; operatorId; envelopeId; intentId;
  contextFingerprint; nowMs }): ExecutionOperatorAuthorizationV2;
// nonceHash = sha256(JSON(['execution-envelope-arm-nonce-v1', envelopeId, intentId, nowMs]));
// ARM CANARY, expires now + 60_000.
```

`createEntryEnvelope` rejects any of the following:
- the qualification is not v2;
- `perBuy ≤ 0`, or `maxExposure < perBuy`;
- `maxBuys` outside 1..1000, or `maxLoss ≤ 0`;
- `holdingMs` outside 30 000..900 000;
- `validUntil ≠ qualification.expiresAtMs`, or `validUntil − validFrom` outside (0, 24 h];
- `validUntil − validFrom < holdingMs + ENVELOPE_EXIT_MARGIN_MS`;
- the policy fails any of:
  - `quoteMintAllowlist` is `[WSOL]`;
  - `maximumOpenPositions === 1`;
  - `maximumTotalExposureBps ≤ 500` (required by `createExecutionArmamentRequestV2`, `execution-operations.ts:354-355`);
  - `evaluateBuyRisk({ policy, quoteMint: WSOL, requestedQuoteAmountRaw: perBuy, realizedNetPnlLamports: -maxLoss, reservedExposureLamports: 0n, openPositions: [], consecutiveTechnicalFailures: 0, lastTechnicalFailureReasonCode: null }).kind === 'ADMISSIBLE'`.

In `execution-preflight-draft.ts`, export:

```ts
export function createEnvelopeQualificationDraft(input: { catalog: unknown; generation: { generationId; walletPublicKey; genesisHash };
  providerId: string; simulation: { artifactId; resultFingerprint; recordedAtMs; buildFingerprint; configurationFingerprint };
  qualifiedAtMs: number; expiresAtMs: number }): { schemaVersion: 'execution-envelope-qualification-draft.v1'; qualification: Record<string, unknown> }
```

It reuses `staticGatesFrom` (`:500`) for gates 0-6 and 8. It uses `createEnvelopeBindingGates` for gates 7 and 9, and `createMainnetSimulationEvidenceFingerprint` for gate 10 (`observedAt = recordedAtMs`). It returns the v2 payload without id and fingerprint.

- [ ] **Step 1: Write failing tests.**
  - The id is stable and the fingerprint changes with each field.
  - Each rejection above has a case. The 0.01 SOL example is admissible with `initialCapitalLamports = maximumCapitalLamports = 230_000_000`, `feeReserveLamports = 20_000_000`, `positionSizeBps = 1000`, `maximumTotalExposureBps = 500`, `perBuy = 10_000_000`, `maxLoss = 30_000_000`.
  - `evaluateEnvelopeArming` returns each idle reason in this order: NO_ENVELOPE > CONTROL_NOT_RUNNING > UNKNOWN_BLOCK > ACTIVE_ARMAMENT > OPEN_POSITION > WINDOW_CUTOFF > CAPACITY (`buys_armed = max`, or the next buy exceeds exposure) > LOSS_CAP > POLICY_FRESHNESS (`walletSnapshotMaxAgeMs` or `providerUsageMaxAgeMs` < `2×lease + 30 000`) > NO_INTENT. Otherwise it returns ARMABLE.
  - Provider carry-forward:
    - used = latest + local;
    - measuredAt not after latest → throws;
    - over limit → throws;
    - `expiresAt` is capped at the period end.
  - The arm authorization is deterministic.
  - The envelope draft is accepted by `createSafetyQualification` (v2), and a stale catalog gate (`expiresAt < qualification expiresAt`) is rejected.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(domain): entry envelope identity, arming decision and envelope qualification draft`

### Task 3: Migration 065

**Files:**
- create `migrations/065_entry_envelope_auto_arm.sql`, `tests/entry-envelope-migration.test.ts`
- register in:
  - `src/execution-migrations/live-catalog.ts` (sha256 line after `:72`);
  - `scripts/deployment-smoke.mjs` (after `:119`);
  - `src/executor-live/startup-validator.ts:34,592` and `src/executor-live-recovery/startup-validator.ts:39,265` (`migrationHead`);
  - every test pinning 064 (`grep -rl 064_fast_entry_decisions tests src scripts`). This includes `tests/executor-live-main.integration.test.ts:545` (regex list), `tests/executor-live-recovery-startup.test.ts:21,41`, `tests/execution-canary-migration.test.ts:16`, `tests/execution-operations-migration.test.ts:9`, `tests/api-event-stream-migration.test.ts:291`. Mirror commit `20947a1a` (`git show 20947a1a --stat`).

All statements must be replayable: the smoke test applies migrations twice.

```sql
-- 1. Qualification scope (035:1-42 constraints replaced; CANARY rows unchanged).
ALTER TABLE execution_safety_qualifications
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'CANARY',
  ADD COLUMN IF NOT EXISTS envelope_id TEXT;
ALTER TABLE execution_safety_qualifications DROP CONSTRAINT IF EXISTS execution_safety_qualifications_envelope_fkey;
ALTER TABLE execution_safety_qualifications ADD CONSTRAINT execution_safety_qualifications_envelope_fkey
  FOREIGN KEY (envelope_id) REFERENCES execution_entry_envelopes(envelope_id) ON DELETE RESTRICT;
ALTER TABLE execution_safety_qualifications DROP CONSTRAINT IF EXISTS execution_safety_qualifications_identity_check;
ALTER TABLE execution_safety_qualifications ADD CONSTRAINT execution_safety_qualifications_identity_check CHECK (
  evaluator_version = 1
  AND ((payload_version = 1 AND scope = 'CANARY' AND envelope_id IS NULL)
    OR (payload_version = 2 AND scope = 'ENVELOPE' AND phase = 'CANARY'
      AND envelope_id ~ '^execution_entry_envelope_[0-9a-f]{64}$'))
  AND qualification_id ~ '^execution_safety_qualification_[0-9a-f]{64}$'
  /* ...remaining 035:22-32 predicates verbatim... */);
ALTER TABLE execution_safety_qualifications DROP CONSTRAINT IF EXISTS execution_safety_qualifications_temporal_check;
ALTER TABLE execution_safety_qualifications ADD CONSTRAINT execution_safety_qualifications_temporal_check CHECK (
  /* 035:35-39 verbatim */
  AND ((scope = 'CANARY' AND expires_at = qualified_at + INTERVAL '5 minutes')
    OR (scope = 'ENVELOPE' AND expires_at > qualified_at AND expires_at <= qualified_at + INTERVAL '24 hours'))
  AND purge_after = expires_at + INTERVAL '4 hours');

-- 2. Authorization action ENVELOPE (039:169-183 replaced; 039:202-218 trigger untouched: it only forbids new v1 ARM).
--    Same as 039 plus: OR (payload_version=1 AND action='ENVELOPE' AND phase IS NULL)

-- 3. Provider provenance (034:344 replaced): provenance IN ('AUTHORITATIVE_PROBE','OPERATOR_REPORT','EXECUTOR_COUNTERS').

-- 4. Envelope v2 columns. Plain TEXT authorization_id, no FK: authorizations are purged at
--    src/storage/database.ts:411, the same reason as lot 3 deviation 2.
ALTER TABLE execution_entry_envelopes
  ADD COLUMN IF NOT EXISTS authorization_id TEXT, ADD COLUMN IF NOT EXISTS risk_policy JSONB,
  ADD COLUMN IF NOT EXISTS policy_fingerprint TEXT, ADD COLUMN IF NOT EXISTS maximum_holding_ms INTEGER;
ALTER TABLE execution_entry_envelopes DROP CONSTRAINT IF EXISTS execution_entry_envelopes_v2_check;
ALTER TABLE execution_entry_envelopes ADD CONSTRAINT execution_entry_envelopes_v2_check CHECK (
  payload_version = 1  -- lot 3 test rows; never armable (trigger requires v2)
  OR (payload_version = 2 AND envelope_id = 'execution_entry_envelope_' || fingerprint
    AND authorization_id ~ '^execution_operator_authorization_[0-9a-f]{64}$'
    AND policy_fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(risk_policy) = 'object'
    AND maximum_holding_ms BETWEEN 30000 AND 900000
    AND max_total_exposure_raw >= per_buy_quote_amount_raw
    AND buys_armed * per_buy_quote_amount_raw <= max_total_exposure_raw));
-- BEFORE INSERT guard (v2 only): lock 51005; state ACTIVE, buys_armed=0, realized_loss_raw=0,
--   revoked_at NULL, valid_from <= now < valid_until; generation not retired; EXISTS consumed v1
--   ENVELOPE authorization with generation_id, context_fingerprint=NEW.fingerprint,
--   operator_id=NEW.operator_id, expires_at >= now. Else RAISE 55000.
-- BEFORE UPDATE guard (all rows): every identity column immutable (envelope_id, generation_id,
--   operator_id, payload_version, fingerprint, per_buy, max_*, valid_from, valid_until, created_at,
--   authorization_id, risk_policy, policy_fingerprint, maximum_holding_ms); buys_armed and
--   realized_loss_raw non-decreasing; state changes only from ACTIVE; updated_at non-decreasing. Else 55000.

-- 5. Armament link.
ALTER TABLE execution_activation_armaments ADD COLUMN IF NOT EXISTS envelope_id TEXT;
-- + FK to execution_entry_envelopes ON DELETE RESTRICT (armaments are the child; retention unaffected).

-- 6. Replace guard_execution_activation_armament_insert (039:764-839).
CREATE OR REPLACE FUNCTION guard_execution_activation_armament_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE armament_valid BOOLEAN; envelope_rows INTEGER;
BEGIN
  IF NEW.payload_version<>2 OR NEW.state<>'ARMED' THEN
    RAISE EXCEPTION 'only V2 CANARY armament insert is permitted' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  SELECT EXISTS(SELECT 1 /* FROM ... JOINs 039:772-788 verbatim */
    WHERE /* 039:789-835 verbatim EXCEPT 811-812 and 818-819 */
      AND ((qualification.scope='CANARY' AND NEW.envelope_id IS NULL
          AND wallet_gate.evidence_id=wallet_snapshot.snapshot_id
          AND wallet_gate.evidence_fingerprint=wallet_snapshot.snapshot_fingerprint
          AND provider_gate.evidence_id=provider_snapshot.snapshot_id
          AND provider_gate.evidence_fingerprint=provider_snapshot.snapshot_fingerprint)
        OR (qualification.scope='ENVELOPE' AND NEW.envelope_id IS NOT NULL
          AND qualification.envelope_id=NEW.envelope_id
          AND NEW.target_strategy_id='fast-entry-v1'
          AND EXISTS (SELECT 1 FROM execution_entry_envelopes envelope
            WHERE envelope.envelope_id=NEW.envelope_id AND envelope.payload_version=2
              AND envelope.generation_id=NEW.generation_id AND envelope.state='ACTIVE'
              AND envelope.operator_id=NEW.operator_id
              AND envelope.valid_from<=statement_timestamp()
              AND envelope.valid_until>=statement_timestamp()
                +NEW.maximum_holding_ms*INTERVAL '1 millisecond'+INTERVAL '15 minutes'
              AND intent.requested_at>=envelope.valid_from
              AND envelope.per_buy_quote_amount_raw=NEW.target_quote_amount_raw
              AND envelope.per_buy_quote_amount_raw=NEW.maximum_capital_lamports
              AND envelope.maximum_holding_ms=NEW.maximum_holding_ms
              AND envelope.policy_fingerprint=NEW.target_policy_fingerprint
              AND envelope.buys_armed<envelope.max_buys
              AND (envelope.buys_armed+1)*envelope.per_buy_quote_amount_raw<=envelope.max_total_exposure_raw
              AND envelope.realized_loss_raw<envelope.max_realized_loss_raw)))
  ) INTO armament_valid;
  IF NOT armament_valid THEN RAISE EXCEPTION 'guarded V2 armament insert required' USING ERRCODE='55000'; END IF;
  IF NEW.envelope_id IS NOT NULL THEN
    UPDATE execution_entry_envelopes SET buys_armed=buys_armed+1,
      state=CASE WHEN buys_armed+1>=max_buys
        OR (buys_armed+2)*per_buy_quote_amount_raw>max_total_exposure_raw THEN 'EXHAUSTED' ELSE state END,
      updated_at=GREATEST(updated_at,date_trunc('milliseconds',statement_timestamp()))
    WHERE envelope_id=NEW.envelope_id AND state='ACTIVE';
    GET DIAGNOSTICS envelope_rows = ROW_COUNT;
    IF envelope_rows<>1 THEN RAISE EXCEPTION 'envelope counter update required' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $function$;
-- Trigger binding 039:840-844 re-created identically (DROP TRIGGER IF EXISTS / CREATE TRIGGER).
```

- [ ] **Step 1: Write `tests/entry-envelope-migration.test.ts`.** Model it on `tests/fast-entry-migration.test.ts`: contract fragments plus PG cases.
  - **Qualification:**
    - a v1 CANARY row with 5 min inserts;
    - v1 with 6 min is rejected (23514);
    - a v2 ENVELOPE row with `envelope_id` and 23 h inserts;
    - v2 with 25 h is rejected;
    - v2 without `envelope_id` is rejected;
    - v1 with `scope='ENVELOPE'` is rejected;
    - an update of a qualification is still rejected (55000).
  - **Authorization:**
    - v1 `ENVELOPE` / NULL inserts;
    - `ENVELOPE` with phase `CANARY` is rejected;
    - new v1 ARM is still rejected (55000).
  - **Provider:** an `EXECUTOR_COUNTERS` snapshot inserts.
  - **Envelope:**
    - a v2 insert without a consumed `ENVELOPE` authorization is rejected (55000);
    - with one, it inserts;
    - `buys_armed*per_buy > max_total_exposure_raw` is rejected (23514);
    - a v1 lot-3 style row still inserts (the existing helper at `tests/fast-entry.repository.test.ts:289`);
    - decreasing `buys_armed`, changing `per_buy`, or `REVOKED→ACTIVE` are each rejected (55000);
    - `ACTIVE→EXPIRED` passes.
- [ ] **Step 2:** Write the migration. Register it (sha via `shasum -a 256`) and update the pins.
- [ ] **Step 3:** Run the new test and the existing CANARY suites unchanged: `tests/execution-canary-migration.test.ts`, `tests/execution-operations-migration.test.ts`, `tests/execution-operations.repository.test.ts`, `tests/execution-risk-migration.test.ts`. Run the build.
- [ ] **Step 4: Commit.** `feat(migrations): entry envelope v2, ENVELOPE qualification scope and envelope-bound armaments (065)`

### Task 4: Fast-entry TTL and deadline decision-event fix

**Files:**
- `src/domain/fast-entry.ts:8`
- `tests/fast-entry.repository.test.ts` (the `expires_at - requested_at = 30 s` assertion)
- `src/storage/execution-live.repository.ts:5016-5059`
- deadline tests: `grep -rln "maximum-holding" tests` (e.g. `tests/execution-live-sell-reconciliation.test.ts:711`, `tests/execution-live-repository-contract.test.ts`, `tests/executor-live-recovery-lanes.test.ts`)

- [ ] **Step 1: Write failing tests.**
  - The fast-entry intent TTL is 120 s.
  - A new PG test creates a deadline exit for an OPEN position **without** inserting any `maximum-holding:*` domain event. It must succeed, where today it fails with 23503 (proves the spec's suspected bug). The SELL intent's `decision_event_id` equals the BUY intent's `decision_event_id`. The replay returns `REPLAYED` with the same id.
  - Remove the manual `insertExecutionDecisionEvent(..., 'maximum-holding:'+positionId, ...)` pre-inserts from the existing deadline tests.
- [ ] **Step 2: Implement.**
  - `FAST_ENTRY_INTENT_TTL_MS = 120_000`.
  - In `createDeadlineExitIntentLocked`, add `buy.decision_event_id AS buy_decision_event_id` to the SELECT and to the `exactRow` keys, then use `decisionEventId: text(row.buy_decision_event_id)` (replaces `:5055`). Leave `logicalCommandId` and `decisionFingerprint` unchanged.
  - No grant change: recovery already selects `execution_intents.decision_event_id` (`src/executor-live-recovery/database-authority.ts:47-66`).
- [ ] **Step 3:** Run the tests and the build.
- [ ] **Step 4: Commit.** `fix(live-recovery): deadline exit references the BUY decision event; fast-entry intents live 120 s`

### Task 5: Operations repository, envelope lifecycle (+ operations grants)

**Files:**
- `src/storage/execution-operations.repository.ts`, `src/ports/execution-operations-repository.ts`
- `scripts/provision-executor-roles.sql` (operations section, `:2081-2263`)
- `tests/execution-entry-envelope.repository.test.ts` (new, PG; reuse the seeding of `tests/execution-operations.repository.test.ts`: generation, risk state, simulation artifact)
- `tests/executor-roles-provisioning.test.ts`

New repository methods:
- `prepareEnvelopeFacts(generationId, { buildHash, configurationFingerprint, walletPublicKey, providerId, genesisHash })`. It returns the generation, the DB now, and the latest `execution_simulation_artifacts` row with `result_kind='SUCCESS'` matching those fields (`ORDER BY recorded_at DESC LIMIT 1`). It returns null when there is none.
- `createEnvelope({ envelope, qualification, authorization })`, in one transaction:
  1. `lockGeneration`; generation checks as in `persistQualification` (`:113-126`); `qualificationFrom` must give v2; `verifyMainnetSimulationEvidence` (`:1162`).
  2. `UPDATE ... SET state='EXPIRED',updated_at=now WHERE generation_id=$1 AND state='ACTIVE' AND valid_until<=now`.
  3. `consumeAuthorization(client, authorization, 'ENVELOPE', null, now)` (`:1400`); widen the action type.
  4. INSERT the envelope (v2, ACTIVE, `risk_policy` = canonical JSON of the policy, `created_at=updated_at=valid_from`).
  5. INSERT the qualification with `payload_version=2`, `scope='ENVELOPE'`, `envelope_id`, then its 11 gates. Write a new INSERT; keep the `persistQualification` SQL untouched.
  6. Map 23505 to `CONFLICT` (another ACTIVE envelope).
- `revokeEnvelope({ generationId, envelopeId, operatorId, occurredAtMs })` (no TTY, kill switch):
  - `lockGeneration`;
  - `UPDATE state='REVOKED',revoked_at=now,updated_at=now WHERE envelope_id AND generation_id AND state='ACTIVE'`; already REVOKED counts as a replay;
  - `terminalizeActiveArmament(client, generationId, 'REVOKED', false)` (`:1249`), which revokes an ARMED armament and releases its reservation.
- `readEnvelopes(generationId)`: last 5 envelopes, without the policy JSON.
- `expireEnvelopes(generationId)`: the UPDATE in step 2 of `createEnvelope`; returns the count and the DB now.
- `persistQualification` (`:94`) rejects payload v2 (`CONFLICT`).
- `qualificationForArm` (`:1422`) and `qualificationFrom` (`:1511`) select or pass `scope` and rebuild v2 inputs (`scope:'ENVELOPE'`). `qualificationForArm` also returns the row's `envelope_id` (a new small typed wrapper, `envelopeIdOfQualification`).
- `assertCanaryQualification(request, qualification, nowMs, envelopeId: string | null)` (`:1020-1044`):
  - v1 requires `envelopeId === null` and keeps the gate equality checks unchanged;
  - v2 requires `envelopeId !== null`, plus the generation/provider binding of both snapshots, plus the existing expiry checks.
  - The CANARY caller passes `null`.

Operations grants:
```sql
GRANT SELECT (envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
  max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,valid_until,state,
  buys_armed,realized_loss_raw,revoked_at,created_at,updated_at,authorization_id,risk_policy,
  policy_fingerprint,maximum_holding_ms),
  INSERT (envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
  max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,valid_until,state,
  buys_armed,realized_loss_raw,created_at,updated_at,authorization_id,risk_policy,policy_fingerprint,
  maximum_holding_ms),
  UPDATE (state,buys_armed,revoked_at,updated_at)
ON TABLE execution_entry_envelopes TO sol_token_executor_operations;
```
Also add `scope,envelope_id` to the SELECT and INSERT column lists for `execution_safety_qualifications` (`:2179-2188`), and `envelope_id` to the SELECT and INSERT lists for `execution_activation_armaments` (`:2222-2252`). Do not grant `UPDATE(envelope_id)` to any role. Do not add envelopes to the shared `REVOKE ALL` list at `:2069-2078`: that would strip the listener grant from `:372-375`.

- [ ] **Step 1: Write failing tests.**
  - `createEnvelope`:
    - happy path: envelope ACTIVE v2; qualification `scope='ENVELOPE'` bound; authorization consumed;
    - a v1 qualification → CONFLICT;
    - a second ACTIVE envelope → CONFLICT;
    - an ACTIVE envelope past `valid_until` is set to EXPIRED and the new one inserts;
    - an unconsumed or mismatched authorization → CONFLICT;
    - no SUCCESS artifact → CONFLICT.
  - `persistQualification(v2)` → CONFLICT; `persistQualification(v1)` is unchanged.
  - `revokeEnvelope`: an ARMED armament is REVOKED and its reservation RELEASED; a replay is accepted.
  - `expireEnvelopes`.
  - The provisioning test asserts the new operations column grants and that no role holds `UPDATE(envelope_id)`.
- [ ] **Step 2:** Implement. Run the tests, `tests/execution-operations.repository.test.ts` unchanged, `tests/executor-roles-provisioning.test.ts`, and the build.
- [ ] **Step 3: Commit.** `feat(operations): entry envelope create/revoke/expire and ENVELOPE qualification persistence`

### Task 6: Operations repository, `armEnvelope`, auto-arm context, provider refresh

**Files:** `src/storage/execution-operations.repository.ts`, the port, `tests/execution-entry-envelope.repository.test.ts`.

- [ ] **Step 1: Refactor the body of `armCanary` (`:442-532`) into a private `armV2InTransaction(client, request, authorization, { preflightSource, envelopeId })`.**
  - The CANARY call passes `{ preflightSource, envelopeId: null }` and keeps the exact statement order.
  - The envelope branches are guarded by `if (envelopeId !== null)`. Inside the transaction, after `databaseNowMs`:
    - `lockedEnvelope(client, envelopeId, generationId)`: `SELECT ... FOR UPDATE`, payload v2, ACTIVE, `createExecutionRiskPolicy(risk_policy).policyFingerprint === policy_fingerprint`;
    - `assertEnvelopeRequest`: per_buy = `target.quoteAmountRaw` = `maximumCapitalLamports`; holding; policy fingerprint; operator; cut-off; capacity; loss;
    - after `lockedCanaryTarget`: `target.intent.strategyId === FAST_ENTRY_STRATEGY_ID` and `requestedAtMs >= validFromMs`;
    - after `qualificationForArm`: the qualification's `envelope_id === envelopeId`;
    - before `appendProviderUsageInTransaction`: `assertEnvelopeProviderCarryForward`. It locks the current snapshot row (`superseded_at IS NULL FOR UPDATE`) and recomputes `latest.used_units + SUM(counters recorded_at >= latest.measured_at)`. It requires an exact match with `request.providerSnapshot.usedUnits` and `provenance='EXECUTOR_COUNTERS'`. Otherwise it throws `CONFLICT`, and the daemon retries next tick.
  - `insertCanaryArmament(client, armament, envelopeId)` (`:1097`) appends `envelope_id` as `$42` (NULL for CANARY). The 065 trigger increments `buys_armed`.
  - The public method: `armEnvelope({ request: ExecutionArmamentRequestV2, authorization: ExecutionOperatorAuthorizationV2, envelopeId })`. It requires `request.qualification.payloadVersion === 2` and the same authorization binding as `:438-441`.
- [ ] **Step 2: `readAutoArmContext({ generationId, leaseMs, excludedIntentIds })`** returns a frozen object, from one REPEATABLE READ READ ONLY transaction:
  - the DB now;
  - the ACTIVE v2 envelope (or null), with its `ENVELOPE` qualification;
  - the control state;
  - risk `state_revision`, `open_positions`, `unknown_block`;
  - whether an ARMED (`expires_at > now`) or LOCKED armament exists;
  - the current provider snapshot and its local counter units;
  - the oldest candidate intent: `strategy_id='fast-entry-v1' AND side='BUY' AND status='PENDING' AND live_reserved=FALSE AND lease_owner IS NULL AND attempt_count=0 AND quote_amount_raw=per_buy AND requested_at>=valid_from AND expires_at>=now+(2*lease+10000) ms AND id <> ALL($excluded)`, ordered `requested_at, id`, limit 1;
  - `providerRefreshDue`: no ARMED armament, a LOCKED armament whose target intent `status='SUCCEEDED'` (BUY reconciled, position open), and the current provider `expires_at < now + 5 min`. This uses only existing operations SELECT grants.
- [ ] **Step 3: `refreshEnvelopeProviderSnapshot({ generationId, maximumAgeMs })`.**
  - Lock 51006 on the provider; re-check `providerRefreshDue` inside the transaction.
  - `appendProviderUsageInTransaction(createEnvelopeProviderSnapshot(...))`.
  - It is needed because `beginSellSubmission` requires a current, unexpired provider snapshot (`execution-live.repository.ts:3001-3028`). Superseding is never done while a BUY is in flight, because the BUY checks require `provider_superseded_at IS NULL` (`:2471`, `:2512`, `:2705`, `:3164`, `:3890`).
- [ ] **Step 4: Tests (PG).**
  - Happy path:
    - armament v2 `phase='CANARY'` with `envelope_id`;
    - `live_reserved=TRUE`, admission ADMITTED, reservation RESERVED;
    - `buys_armed=1`;
    - authorization consumed with the envelope operator;
    - activation event `OPERATOR_ARMED`.
  - Control `ENTRY_STOP` → `CONTROL_STOPPED`.
  - REVOKED or EXPIRED envelope → CONFLICT.
  - `valid_until < now + holding + 15 min` → CONFLICT.
  - Second arm while ARMED → CONFLICT (K=1).
  - `max_buys=2`: the 2nd arm sets EXHAUSTED and a 3rd → CONFLICT.
  - `max_total_exposure = 2×per_buy`, `max_buys=5`: EXHAUSTED after 2.
  - `realized_loss_raw ≥ max` → CONFLICT.
  - Strategy not `fast-entry-v1`, or a quote ≠ per_buy → CONFLICT.
  - A provider carry-forward mismatch → CONFLICT, with nothing written.
  - A CANARY qualification with `envelopeId` → CONFLICT.
  - A direct SQL insert of an armament with `envelope_id` and a CANARY qualification → 55000.
  - `readAutoArmContext` picks the oldest eligible intent and skips excluded, leased, too-short-TTL and pre-envelope intents.
  - `providerRefreshDue` is false while ARMED, false while LOCKED with the BUY not SUCCEEDED, and true once SUCCEEDED and near expiry.
  - **All of `tests/execution-operations.repository.test.ts` passes unchanged.**
- [ ] **Step 5: Commit.** `feat(operations): envelope-bound v2 arming with executor-counter provider snapshots`

### Task 7: Operations CLI `envelope prepare|create|revoke|show` and H2f envelope signing

**Files:**
- `src/executor-operations/{main,config,service,terminal}.ts`
- `src/preflight-bundle/{service,main}.ts`
- `package.json` (`live:envelope` → `node dist/src/executor-operations/main.js envelope`)
- `tests/helpers/execution-boundary.ts:126-128`: allow `domain/execution-entry-envelope` and `domain/fast-entry`
- tests: `tests/execution-operations-cli.test.ts`, `tests/execution-operations-config.test.ts`, `tests/execution-operations.service.test.ts`, `tests/execution-preflight-bundle-service.test.ts`, `tests/execution-preflight-bundle-cli.test.ts`

Changes:
- **Parser** (`main.ts:180-196`): accept `envelope` followed by a sub-command (`prepare|create|revoke|show`), then `--k=v` options.
- **Config:** `parseExecutionEnvelopeConfig` = base + `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH` (absolute); `phase` must be `CANARY`.
- **`envelope prepare --valid-ms=N`** (N in 3 600 000..86 400 000):
  - reads the catalog (canonical JSON) and `prepareEnvelopeFacts`;
  - checks `catalog.strategyFingerprint === config.strategyFingerprint`;
  - calls `createEnvelopeQualificationDraft` with `qualifiedAt = DB now` and `expiresAt = qualifiedAt + N`;
  - prints the canonical draft. No authorization, no write.
- **`envelope create --per-buy-lamports --max-buys --max-exposure-lamports --max-loss-lamports --holding-ms`:**
  - reads the signed qualification at `EXECUTOR_PREFLIGHT_EVIDENCE_PATH` (`verifySignedSafetyQualificationEvidence`, payload v2, `assertQualificationBinding` at `:256-271`);
  - takes the policy from the catalog;
  - `createEntryEnvelope({ validFromMs: nowMs, validUntilMs: q.expiresAtMs, ... })`;
  - `service.createEnvelope` → `authorizeEnvelopeCreation` (terminal.ts) → `repository.recordAuthorization` (`:159`) → `repository.createEnvelope`;
  - prints `{payloadVersion:1, command:'envelope-create', envelopeId, validUntilMs, perBuyQuoteAmountRaw, maxBuys, qualificationId, liveCapabilityPresent:false}`.
- **`authorizeEnvelopeCreation`:**
  - requires a TTY;
  - details line: `ENVELOPE_DETAILS V1 envelopeId=… perBuyLamports=… maxBuys=… maxExposureLamports=… maxLossLamports=… holdingMs=… validFromMs=… validUntilMs=… policyFingerprint=… qualificationId=…`;
  - phrase: `CONFIRM ENVELOPE <wallet> <perBuy> <maxBuys> <maxExposure> <maxLoss> <holdingMs> <validUntilMs> <envelopeFingerprint> <nonce>`;
  - nonce hash as at `terminal.ts:90-93` with action `ENVELOPE`;
  - returns `createOperatorAuthorization({ payloadVersion:1, action:'ENVELOPE', phase:null, contextFingerprint: envelope.fingerprint, expiresAtMs: now + 60_000, ... })`.
- **`envelope revoke --envelope-id=…`** (no TTY, like `kill-switch` at `:73-89`).
- **`envelope show`**: JSON of `readEnvelopes`.
- **H2f:** `createEnvelopeQualificationPackage(encodedDraft, privateKeyText, nowMs)`:
  - canonical draft, `schemaVersion === 'execution-envelope-qualification-draft.v1'`;
  - `createSafetyQualification` must give v2; `qualifiedAt ≤ now`; `expiresAt ≥ now + 3 600 000`;
  - `signedEnvelope` (`service.ts:136`), then a round-trip verify;
  - manifest `execution-envelope-qualification-package.v1`.
  - `main.ts` dispatches on the draft `schemaVersion` and writes only `qualification.json` and `manifest.json` (an atomic writer variant without `canary.json`). The bundle path is unchanged.

- [ ] **Step 1: Write failing tests.**
  - CLI:
    - `envelope create` without a TTY → error;
    - phrase mismatch → error;
    - the happy path outputs JSON and calls the repository with the expected envelope;
    - v1 qualification file → error;
    - unknown option → error;
    - `revoke` and `show` outputs;
    - `prepare` prints canonical JSON accepted by `createSafetyQualification`;
    - `preflight` with a v2 file → error.
  - Config: the catalog path is required and the phase must be CANARY.
  - H2f: an envelope draft gives a verified qualification envelope and no canary file; an existing bundle draft gives byte-identical output (existing tests unchanged).
  - Architecture: the operations graph test (`tests/executor-architecture.test.ts:26-41`) still passes with the extended allowlist.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(operations): envelope prepare/create/revoke/show commands and H2f envelope qualification signing`

### Task 8: Auto-arm daemon

**Files:**
- create `src/executor-operations/auto-arm.ts` (service, injected dependencies) and `src/executor-operations/auto-arm-main.ts` (composition and loop)
- `src/executor-operations/config.ts`: `parseExecutionAutoArmConfig`. Factor the runtime fields of `parseExecutionCanaryArmConfig` (`:108-149`) into a shared helper.
- `package.json`: `"live:auto-arm": "node dist/src/executor-operations/auto-arm-main.js"`
- tests: `tests/execution-auto-arm.test.ts` (no DB), `tests/execution-operations-config.test.ts`, `tests/executor-architecture.test.ts` (new graph test)

Config:
- base operations config;
- the runtime arm parameters, with the same env names as `arm`; they must equal H2b's, because `RUNNABLE_WORK_SQL` and the BUY claim compare them;
- `SOLANA_HTTP_RPC_URL` (https), `EXECUTOR_RPC_TIMEOUT_MS` (100..30 000);
- `EXECUTOR_AUTO_ARM_POLL_MS` (500..60 000);
- reject when `2×EXECUTOR_LEASE_MS + 20 000 > FAST_ENTRY_INTENT_TTL_MS`;
- `phase === 'CANARY'`; `LIVE_TRADING_ENABLED` absent or false (base); secret keys rejected (base).

```ts
export async function runAutoArmTick(deps: AutoArmDependencies, signal: AbortSignal): Promise<AutoArmTickResult> {
  await deps.repository.expireEnvelopes(deps.config.generationId);
  const context = await deps.repository.readAutoArmContext({ generationId: deps.config.generationId,
    leaseMs: deps.config.runtimeLeaseMs, excludedIntentIds: [...deps.excluded.keys()] });
  if (context.providerRefreshDue) await deps.repository.refreshEnvelopeProviderSnapshot(/* policy max age */);
  const decision = evaluateEnvelopeArming(context /* + config */);
  if (decision.kind === 'IDLE') return { kind: 'IDLE', reason: decision.reason };
  let observation: ReadinessWalletObservationV1;
  try {
    observation = await deps.rpc.observeWallet(deps.config.walletPublicKey,
      deps.config.runtimeSnapshotMaxSlotLag, signal, () => context.databaseNowMs);
  } catch { return { kind: 'DEFERRED', reason: 'WALLET_RPC_FAILED' }; }
  const { envelope, intent, qualification } = context; const policy = envelope.policy;
  if (observation.walletLamports < envelope.perBuyQuoteAmountRaw + policy.feeReserveLamports)
    return { kind: 'IDLE', reason: 'INSUFFICIENT_WALLET' };
  const nowMs = context.databaseNowMs;
  const walletSnapshot = createExecutionWalletSnapshot({ generationId, providerId: config.providerId,
    stateRevision: context.riskStateRevision, slot: observation.slot, blockTimeMs: observation.blockTimeMs,
    observedAtMs: nowMs, commitment: 'finalized', walletLamports: observation.walletLamports,
    tokenBalanceCount: observation.tokenBalanceCount, openPositions: [],
    realizedNetPnlRaw: -envelope.realizedLossRaw });
  const providerSnapshot = createEnvelopeProviderSnapshot({ latest: context.provider,
    localUsedUnits: context.providerLocalUnits, measuredAtMs: nowMs, maximumAgeMs: policy.providerUsageMaxAgeMs });
  const evidenceExpiresAtMs = Math.min(qualification.expiresAtMs, providerSnapshot.expiresAtMs,
    nowMs + policy.providerUsageMaxAgeMs, nowMs + policy.walletSnapshotMaxAgeMs);
  const request = createExecutionArmamentRequestV2({ payloadVersion: 2, qualification, targetIntentId: intent.intentId,
    policy, walletSnapshot, providerSnapshot, allEndpointsUnavailable: false, capturedAtMs: nowMs,
    expiresAtMs: evidenceExpiresAtMs, target: intent /* ExecutionCanaryTargetV2 */, maximumBuys: 1,
    maximumCapitalLamports: envelope.perBuyQuoteAmountRaw, maximumExposureBps: 500n, maximumOpenPositions: 1,
    maximumHoldingMs: envelope.maximumHoldingMs, ...runtimeFrom(config), armedAtMs: nowMs,
    armamentExpiresAtMs: Math.min(evidenceExpiresAtMs, intent.expiresAtMs, nowMs + ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS),
    operatorId: envelope.operatorId, operatorReason: `envelope:${envelope.envelopeId}` });
  const authorization = createEnvelopeArmAuthorization({ generationId, operatorId: envelope.operatorId,
    envelopeId: envelope.envelopeId, intentId: intent.intentId,
    contextFingerprint: request.armamentRequestFingerprint, nowMs });
  try {
    const armament = await deps.repository.armEnvelope({ request, authorization, envelopeId: envelope.envelopeId });
    return { kind: 'ARMED', intentId: intent.intentId, armamentId: armament.armamentId };
  } catch (error) {
    deps.excluded.set(intent.intentId, intent.expiresAtMs);  // pruned when expired
    return { kind: 'REJECTED', intentId: intent.intentId, reason: repositoryCode(error) };
  }
}
```

`auto-arm-main.ts`:
- parse the config; `openExecutionOperationsDatabase` (`src/executor-operations/database.ts:99`);
- `new SolanaReadinessRpcGateway({ providerId, httpRpcUrl, expectedGenesisHash, timeoutMs })`, then `verifyGenesis` once;
- loop `tick → sleep(pollMs)` until SIGINT or SIGTERM;
- each tick has an `AbortSignal` with a timeout of `rpcTimeout×2`;
- a database error evicts the pool and continues;
- each tick logs one JSON line `{service:'sol-token-executor-auto-arm', event:'executor.auto_arm_tick', result, reason, intentId?, armamentId?}`. Never log the URL, a key or the wallet balance.

- [ ] **Step 1: Write failing tests** (fake repository and RPC).
  - Each IDLE reason makes no RPC call.
  - RPC failure → DEFERRED; nothing armed.
  - Insufficient wallet → IDLE.
  - Happy path:
    - `maximumCapitalLamports = perBuy`; holding from the envelope;
    - `operatorReason`;
    - authorization operator = envelope operator; context = request fingerprint; expiry = now + 60 s;
    - `armamentExpiresAtMs ≤ intent.expiresAtMs`;
    - provider `provenance = 'EXECUTOR_COUNTERS'`.
  - Repository CONFLICT → REJECTED and the intent is excluded until expiry.
  - `expireEnvelopes` is called every tick; refresh only when `providerRefreshDue`.
  - Config: TTL / lease guard; https only; CANARY only; rejects `LIVE_TRADING_ENABLED=true`; rejects secret keys.
  - Architecture: the auto-arm graph:
    - must not reach `/executor-live/`;
    - may reach `executor-readiness/rpc-gateway` only (from `executor-readiness`);
    - contains none of `Keypair|sendRawTransaction|sendTransaction|simulateTransaction|signMessage|signTransaction`.
  - The operations CLI graph must still not reach `auto-arm`.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(operations): auto-arm daemon for fast-entry intents within the active envelope`

### Task 9: Live executor (H2b): runnable work and ENVELOPE gate binding

**Files:**
- `src/storage/execution-live.repository.ts`: `RUNNABLE_WORK_SQL` `:149-226`; signing selects `:300-365`, `:380-465`; checks `:2472-2477`, `:2513-2518`
- `src/executor-live/startup-validator.ts:80-230` (`LIVE_EXECUTOR_DATABASE_AUTHORITY_V1`)
- `scripts/provision-executor-roles.sql:1814` (live section)
- tests: `tests/executor-live-startup.test.ts`, `tests/executor-roles-provisioning.test.ts`, `tests/executor-live-database.test.ts` and/or `tests/execution-live-repository-contract.test.ts`

Changes:
- Append to `RUNNABLE_WORK_SQL`, so H2b can start idle while an envelope is open:

```sql
OR EXISTS (SELECT 1 FROM execution_entry_envelopes envelope WHERE envelope.generation_id=$1
  AND envelope.payload_version=2 AND envelope.state='ACTIVE' AND envelope.valid_until>statement_timestamp())
```
  The runtime keeps polling when idle (`src/executor-live/runtime.ts:90-160`: verify that lanes returning `IDLE` just wait `pollMs`).
- Add `qualification.scope AS qualification_scope` to both signing selects. Replace the fingerprint comparisons in both checks:

```ts
|| (row.qualification_scope !== 'CANARY' && row.qualification_scope !== 'ENVELOPE')
|| (row.qualification_scope === 'CANARY' && row.wallet_gate_fingerprint !== row.target_wallet_snapshot_fingerprint)   // :2473
|| (row.qualification_scope === 'CANARY' && row.provider_gate_fingerprint !== row.target_provider_snapshot_fingerprint) // :2476
// and the same at :2514 / :2517 with wallet_snapshot_fingerprint / provider_snapshot_fingerprint
```
  Status `PASSED`, gate expiry, `superseded_at IS NULL` and every other check stay for both scopes.
- Grants and authority: add `'scope'` to the live SELECT on `execution_safety_qualifications`. Add `table('execution_entry_envelopes', names('generation_id','payload_version','state','valid_until'))`. Mirror both in provisioning and in the authority constant. No other live change.

- [ ] **Step 1: Write failing tests.**
  - `assertRunnableWork` passes with only an ACTIVE v2 envelope.
  - It throws `LIVE_EXECUTOR_NO_WORK` with a REVOKED, EXPIRED-by-time or v1 envelope.
  - Signing binding with an ENVELOPE armament passes when gate fingerprints ≠ snapshot fingerprints.
  - The same mismatch on a CANARY armament still gives `PREFLIGHT_EXPIRED`.
  - The authority-constant test and the provisioning test match exactly.
- [ ] **Step 2:** Implement. Run the tests, the existing live suites (`grep -l "executor-live\|execution-live" tests/*.ts`) and the build.
- [ ] **Step 3: Commit.** `feat(executor-live): start on an active envelope and accept ENVELOPE-scoped gate bindings`

### Task 10: Recovery (H2a), envelope realized loss

**Files:**
- `src/storage/execution-live.repository.ts`: after the ledger insert at `:4965-4967`
- `src/executor-live-recovery/database-authority.ts:257-262` (armaments) + a new envelopes entry
- `scripts/provision-executor-roles.sql`: recovery section (`:1206`, `:1258`)
- tests: `tests/execution-live-sell-reconciliation.test.ts`, the recovery authority/startup tests, `tests/executor-roles-provisioning.test.ts`

```ts
export const ENVELOPE_REALIZED_LOSS_SQL = `UPDATE execution_entry_envelopes envelope SET
  realized_loss_raw=envelope.realized_loss_raw+loss.amount,
  state=CASE WHEN envelope.state='ACTIVE'
      AND envelope.realized_loss_raw+loss.amount>=envelope.max_realized_loss_raw
    THEN 'EXHAUSTED' ELSE envelope.state END,
  updated_at=GREATEST(envelope.updated_at,TIMESTAMPTZ 'epoch'+($1::BIGINT*INTERVAL '1 millisecond'))
FROM (SELECT armament.envelope_id,
    GREATEST(0::NUMERIC,-(buy.wallet_lamport_delta+$2::NUMERIC)) AS amount
  FROM execution_live_positions position
  JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
  JOIN execution_reconciliation_evidence buy
    ON buy.evidence_fingerprint=position.entry_reconciliation_fingerprint AND buy.side='BUY'
  WHERE position.position_id=$3::TEXT AND armament.envelope_id IS NOT NULL) loss
WHERE envelope.envelope_id=loss.envelope_id`;
// call right after LIVE_POSITION_LEDGER_INSERT_SQL with
// [finalizedAtMs, evidence.walletLamportDelta.toString(), row.position_id]; rowCount must be 0 or 1.
```

Replays return before this point (`:4585-4599`), so the update runs once per close.

Recovery grants:
- armaments SELECT gains `envelope_id`;
- `execution_entry_envelopes`: SELECT(`envelope_id`, `state`, `realized_loss_raw`, `max_realized_loss_raw`), UPDATE(`realized_loss_raw`, `state`, `updated_at`).

- [ ] **Step 1: Write failing tests.**
  - A MATCHED SELL on an envelope armament with net −3 000 000 adds 3 000 000.
  - A net gain adds 0.
  - Reaching the max sets EXHAUSTED.
  - A REVOKED envelope accumulates and stays REVOKED.
  - A CANARY armament without an envelope updates nothing.
  - Authority and provisioning match exactly.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): accumulate envelope realized loss on SELL reconciliation`

### Task 11: Safety checklist (what stays impossible)

**Files:** `tests/entry-envelope-safety.test.ts` (PG). The arming attempts go through `armEnvelope`, or a direct INSERT where noted.

Each case is a test that must fail closed:
1. No armament without an ACTIVE v2 envelope:
   - with no envelope, a v1 lot-3 envelope, or a REVOKED / EXPIRED / EXHAUSTED one;
   - with `valid_until` past while the state is still ACTIVE (trigger time check).
2. No armament with an `ENVELOPE` qualification bound to another envelope, an expired `ENVELOPE` qualification, or a CANARY qualification plus `envelope_id`.
3. No armament unless control is `RUNNING` (`ENTRY_STOP`, `HARD_STOP`), or while `unknown_block`.
4. K=1: no second armament while one is ARMED or LOCKED (unique index, `035:300`).
5. Caps (DB CHECK + trigger):
   - `buys_armed ≤ max_buys`;
   - `buys_armed × per_buy ≤ max_total_exposure_raw`;
   - `realized_loss ≥ max` blocks arming;
   - counters never decrease (update guard).
6. Exact values:
   - per-buy = intent quote = `maximum_capital_lamports`;
   - `maximum_holding_ms` and `policy_fingerprint` = the envelope's;
   - operator = the envelope operator;
   - strategy = `fast-entry-v1`;
   - intent requested after `valid_from`.
7. Cut-off: no armament if `valid_until < now + holding + 15 min`.
8. Envelope v2 insert requires a consumed `ENVELOPE` authorization with `context = fingerprint`.
9. CANARY regression: the existing canary arm tests pass unchanged; an ENVELOPE armament cannot be signed if its qualification is later expired (live check).

- [ ] **Step 1:** Write the tests. They should pass with Tasks 1-10; if one fails, fix the defect, not the test.
- [ ] **Step 2: Commit.** `test(safety): envelope auto-arm fail-closed checklist`

### Task 12: Docs, checkpoint, full suite, PR

- [ ] **`.env.example`:**
  - the `ENTRY_MODE` note becomes "intents live 120 s; armed only by `live:auto-arm` within an ACTIVE envelope";
  - add `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH`, `EXECUTOR_AUTO_ARM_POLL_MS=1000`;
  - note that the auto-arm env needs `SOLANA_HTTP_RPC_URL`, `EXECUTOR_RPC_TIMEOUT_MS` and the same runtime `EXECUTOR_*` values as H2b;
  - note the lease constraint (`2×lease + 20 s ≤ 120 s`; e.g. lease 40 000 with RPC timeout 5 000 and DB 3 000).
- [ ] **`docs/operations/executor-live-canary.md`:** new section «Enveloppe d'entrée et auto-arm (lot 4a)», with the steps:
  1. Stop the dry-run and simulation workers. To produce a gate-10 artifact, run the simulation-only worker once with `ENTRY_MODE=fast`, then stop it.
  2. Run H2e + H2d for a fresh authoritative provider snapshot and wallet snapshot.
  3. Run `live:envelope prepare --valid-ms=…`, then H2f offline, then `live:envelope create …` (TTY), then `live:resume` (TTY).
  4. Start H2a, then H2b, then `live:auto-arm`, then the listener with `ENTRY_MODE=fast` and creates-only.
  5. Kill switches:
     - `live:envelope revoke` stops arming and revokes an ARMED armament;
     - `live:kill-switch --mode=entry-stop` stops BUY signing;
     - `hard-stop` also stops SELL;
     - open positions sell at the deadline.
  6. Monitor with `live:envelope show` and `live:status`.
  7. The auto-arm daemon must stay up while a position is open (provider snapshot refresh for SELL).
  8. Recommended policy for 0.01 SOL × 5 buys, loss cap 0.03 SOL: `initialCapitalLamports=maximumCapitalLamports=230000000`, `positionSizeBps=1000`, `maximumTotalExposureBps=500`, `maximumOpenPositions=1`, `feeReserveLamports=20000000`, `walletSnapshotMaxAgeMs` and `providerUsageMaxAgeMs` ≥ `2×lease + 30000`.
- [ ] **Full suite green.**
- [ ] **Update `docs/superpowers/plans/2026-10-06-simple-path-CHECKPOINT.md`:**
  - lot 4a done (PR), with its deviations;
  - lot 4b open: exit lane, `LiveExitDecided`, `report`, `market_pools` creates-only;
  - lot 5 prerequisites: the gate-10 artifact and the shared provider plan (below).
- [ ] **Commit, push, open the PR** (attribution per the session reminder). Wait for CI, merge, update local `main`.

---

## Points where safety is not certain (with recommendation)

1. **Gate 10 in production.**
   - **Risk:** `envelope prepare` takes the latest matching SUCCESS simulation artifact without a maximum age. The only proven producer is the paper lineage chain (H2k-b), and the paper buy path is broken (spec).
   - **Recommendation:**
     - in `prepareEnvelopeFacts`, require `recorded_at ≥ now − 24 h`;
     - in lot 5, produce the artifact with the simulation-only worker on a fast-entry intent (no lineage check in `src/executor/simulation-worker.ts`), with auto-arm stopped;
     - verify this in a dry environment before lot 5.
2. **`EXECUTOR_COUNTERS` provider snapshots** carry forward only this executor's counters.
   - **Risk:** if the listener shares the same provider plan, `used_units` is under-reported.
   - **Recommendation:** give the executor its own provider id or key for lot 5; start each envelope right after an authoritative H2e/H2d snapshot; keep `providerSafetyMarginUnits` generous.
3. **The human gate is not cryptographic.** The daemon and the TTY CLI run as the same DB role. The DB cannot tell a daemon-issued v2 ARM authorization from a TTY one: the same is true of today's CANARY flow.
   - **Bound:** the 065 trigger ties every envelope armament to a TTY-consumed `ENVELOPE` authorization and to exact envelope limits.
   - **Recommendation:** run `live:auto-arm` under a dedicated login, separate from the operator's CLI login.
4. **24 h `ENVELOPE` qualification.** Static gates (CI, migrations, fault matrix…) stay valid for up to 24 h instead of 5 min. This is the accepted relaxation; the arming cut-off protects exits.
   - **Residual risk:** a SELL that keeps failing past `valid_until` can no longer be prepared (`:2776`).
   - **Recommendation:** document manual intervention; keep `maximum_holding_ms` small (≤ 300 000) in lot 5.
5. **Revoke ≠ immediate exit in 4a.** A LOCKED BUY in flight completes, and the position sells at the deadline. This is acceptable for K=1 and a holding of ≤ 15 min; the immediate exit comes in 4b.
6. **Verify the quote token program of fast-entry intents.** `assertCanaryRequestTarget` requires `quoteTokenProgram==='SPL_TOKEN'` (`execution-operations.repository.ts:1008`). Assert it in the Task 6 fixture using the real lot-3 draft path; if pump.fun SOL launches give another value, arming always fails closed.
7. **An ARMED armament that is never bought** (BUY lane down) still consumed one `buys_armed`. This is conservative, but can exhaust the envelope with no trade; the daemon logs make it visible.

### Critical Files for Implementation
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/migrations/039_execution_canary_operator_binding.sql (insert trigger 764-844 replaced in new 065)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/storage/execution-operations.repository.ts (armCanary 425-535, assertCanaryQualification 1020-1044, qualificationForArm 1422-1472)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/domain/execution-safety-qualification.ts and /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/domain/execution-canary.ts
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/storage/execution-live.repository.ts (RUNNABLE_WORK_SQL 149-226, signing checks 2472-2477/2513-2518, commitSellReconciliation 4520/4965, deadline 5008-5102)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/scripts/provision-executor-roles.sql (with /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/executor-live/startup-validator.ts and /Users/haythem.mabrouk/workspace/perso/sol-token-listener/src/executor-live-recovery/database-authority.ts)
---

## Amendments after the safety review (2026-10-07) — binding, they override the tasks above

**Task 1**
- A1. `src/preflight-source/repository.ts:568-570` (`providerProvenance`) must accept `EXECUTOR_COUNTERS` when reading a current snapshot, otherwise the CANARY preflight-source path breaks while an executor-counter snapshot is current. Add a test.

**Task 3 (migration 065)**
- A2. Identity CHECK: copy 035:23-32 (NOT 035:22, which is `payload_version = 1 AND evaluator_version = 1`).
- A3. Temporal CHECK: copy 035:35-38 only (035:39 is the 5-minute equality, replaced by the scope disjunction).
- A4. Provider provenance: drop/re-add `execution_provider_usage_snapshots_identity_check` with its full body (034:337-345), changing only the provenance list.
- A5. Armament trigger: copy 039:789 up to the last predicate (835 is `) INTO armament_valid;`). Trigger binding is 039:841-844.
- A6. Armament trigger, ENVELOPE branch: add `AND qualification.expires_at = envelope.valid_until` (the DB must tie the qualification to the cut-off; the SELL at execution-live.repository.ts:2776 and BUY submission at :3883 need the qualification unexpired).
- A7. Envelope BEFORE INSERT guard: also require `operator_auth.authorization_id = NEW.authorization_id AND operator_auth.action = 'ENVELOPE' AND operator_auth.payload_version = 1`.
- A8. Re-create `guard_execution_activation_armament_update` (039:686-760) identically, plus `NEW.envelope_id IS DISTINCT FROM OLD.envelope_id` in its immutable identity list.
- A9. Over 30 tests reference 064: check all of them (`grep -rl 064_fast_entry_decisions tests src scripts`); edit only those that pin the migration head/list.

**Task 5**
- A10. `revokeEnvelope` revokes only an ARMED armament whose `envelope_id = $envelopeId` (never a CANARY armament). Add a test: an ARMED CANARY armament survives an envelope revoke.

**Task 6**
- A11. The carry-forward SUM filters `billing_period_id` exactly like admission (execution-risk.repository.ts:906-915).
- A12. `providerRefreshDue` uses `expires_at < now + providerUsageMaxAgeMs / 2` (not 5 min), so refresh does not fire every tick. `readAutoArmContext` takes `providerRefreshThresholdMs` as input.
- A13. Candidate intent filter margin: `expires_at >= now + 2×lease + 2×rpcTimeout + 5 000` ms (`readAutoArmContext` takes `minimumRemainingMs`).
- A14. At least one arm-path PG test runs under `SET ROLE sol_token_executor_operations` with roles provisioned (reuse how existing role tests do it).

**Task 7**
- A15. `validFromMs` = DB now (from the repository), not the local clock.
- A16. Confirmation phrase uses the first 8 hex chars of the envelope fingerprint (like the wallet prefix at terminal.ts:85), not the full 64.
- A17. `envelope create` precondition: the policy's reconciled capital must be ≥ 20 × per_buy (BUY submission requires `reserved_exposure × 10 000 ≤ reconciled_capital × 500`, execution-live.repository.ts:3825-3884). Reject otherwise.

**Task 8**
- A18. Exclude an intent only on a non-transient rejection (admission refused / intent-specific CONFLICT such as wrong strategy or quote). Provider carry-forward mismatch and 23505 are transient: no exclusion, retry next tick. Make the repository surface a distinct code (e.g. `PROVIDER_CARRY_FORWARD_STALE`) for the carry-forward case.

**Task 10**
- A19. Recovery SELECT grant on `execution_entry_envelopes` includes `updated_at` (read by `GREATEST(envelope.updated_at, …)`); mirror in the authority constant. At least one Task 10 PG test runs the SELL reconciliation under `SET ROLE sol_token_executor_live_recovery`.

**Task 12**
- A20. Fix `.env.example`: `EXECUTOR_LEASE_MS=35000` is already below the minimum for RPC 5 000 / DB 3 000 (≥ 39 000); use 40 000.
- A21. Safety point 3 is restated: the ops role can itself mint and consume a v1 ENVELOPE authorization and insert an envelope + qualification, so a compromised auto-arm daemon (same role) can arm without the human limits; a separate login does not change this. Accepted per the user decision (daemon = ops role); bounded only by wallet balance and the risk policy checks at BUY. Document it in the runbook and the PR.
- A22. Safety point 2 addendum: carry-forward is conservative (it can double-count counters recorded between context read and arm), so a later authoritative H2e probe reporting less may be refused `STALE_MEASUREMENT` until the period rolls over.

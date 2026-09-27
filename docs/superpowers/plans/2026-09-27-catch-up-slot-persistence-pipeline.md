# Catch-up Slot Persistence Pipeline Implementation Plan

> Implement every behavioral change test-first and preserve the exact OFF path.

**Goal:** overlap one catch-up slot hydration with the preceding slot's serial
classification persistence without increasing RPC or database concurrency.

**Design authority:**
`docs/superpowers/specs/2026-09-27-catch-up-slot-persistence-pipeline-design.md`
revision 1.0.0.

**Plan revision:** 1.0.0

## Task 1: Prove the bounded overlap contract

**Files:**

- Modify: `tests/pumpfun-catch-up-block-classifier.test.ts`

- [ ] Add a RED three-slot test with the first repository write blocked.
- [ ] Prove the enabled path has hydrated only N and N+1 while N persists.
- [ ] Prove maximum repository write concurrency is one and final order is
  unchanged.
- [ ] Add the disabled-path mirror proving only N starts.
- [ ] Add rejection and abort tests proving the look-ahead settles without late
  writes or unhandled rejections.

## Task 2: Implement one-slot look-ahead

**Files:**

- Modify: `src/application/pumpfun-catch-up-block-classifier.ts`

- [ ] Add the strict boolean option with false default.
- [ ] Keep existing serial code as the explicit disabled path.
- [ ] Implement captured one-slot hydration look-ahead and serial persistence.
- [ ] Restore receipt order exactly and preserve all validations.
- [ ] Run the focused classifier tests, check and lint.

## Task 3: Activate only with bounded worker admission

**Files:**

- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] Add a RED factory test for ON and OFF composition.
- [ ] Pass the option from the existing bounded-admission policy only.
- [ ] Prove no new environment variable, worker, cache or RPC caller is added.
- [ ] Run focused factory/config tests, build, check and lint.

## Task 4: Verify and deliver

- [ ] Run all focused catch-up, hydration, factory and integration tests.
- [ ] Run `npm run build`, `npm run check`, `npm run lint` and docs checks.
- [ ] Inspect the diff for unchanged worker/cache/RPC limits and no live path.
- [ ] Perform at most two review cycles, fix blocking findings, open and merge
  the PR only with green CI.
- [ ] Pin a clean worktree to the merged Main SHA and rerun the exact 15-minute
  Mainnet observe-only canary before H2e/H2d/H2c.

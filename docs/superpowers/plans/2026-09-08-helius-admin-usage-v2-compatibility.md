# Helius Admin usage v2 compatibility implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore H2e provider evidence collection against the current Helius Admin API while retaining strict support for the historical response.

**Architecture:** Keep the transport and canonical evidence contracts unchanged. Split response validation into two exact discriminated shapes, extract the effective billing cycle from the matching variant, validate every product counter as a non-negative safe integer, and feed the existing bigint snapshot mapping.

**Tech Stack:** TypeScript strict ESM, Node.js test runner, bigint, existing H2e domain factories.

---

### Task 1: Reproduce the current Helius response contract

**Files:**
- Modify: `tests/helius-provider-evidence.test.ts`

- [ ] Add a synthetic current-contract fixture with `creditCycle`, nullable legacy billing cycle, exact `credits`, `requests`, and `dataTransfer` maps.
- [ ] Assert that it maps to the same canonical integer snapshot as the historical fixture.
- [ ] Add fail-closed cases for hybrid, incomplete, unknown-key, unsafe-number, and malformed informational billing-cycle inputs.

```ts
const current = validCurrentResponse();
const result = createHeliusProviderUsage({
  providerId: 'helius-primary', projectId: PROJECT_ID,
  response: current, measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
});
assert.equal(result.snapshot.limitUnits, 550_000n);
assert.equal(result.snapshot.usedUnits, 12_500n);
assert.throws(() => createHeliusProviderUsage({
  providerId: 'helius-primary', projectId: PROJECT_ID,
  response: { ...current, usage: validLegacyResponse().usage },
  measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
}), HeliusProviderUsageValidationError);
```

- [ ] Run `npx tsx --test tests/helius-provider-evidence.test.ts` and confirm the current-contract acceptance test fails with `HeliusProviderUsageValidationError` while historical tests remain green.

### Task 2: Add strict dual-contract normalization

**Files:**
- Modify: `src/domain/helius-provider-evidence.ts`

- [ ] Detect the variant only from its exact top-level key set.
- [ ] Validate the complete matching nested shape and every counter with the existing `counter` guard.
- [ ] Extract the historical cycle from `subscriptionDetails.billingCycle` or the current cycle from `creditCycle`; validate the current informational field as either `null` or a complete cycle.
- [ ] Preserve the existing snapshot identifiers, bigint formula, TTL rules, fingerprints, and public error.

```ts
const response = exactHeliusResponse(row.response);
const subscription = exactRecord(response.value.subscriptionDetails, SUBSCRIPTION_KEYS);
const cycle = response.variant === 'legacy'
  ? exactRecord(subscription.billingCycle, BILLING_CYCLE_KEYS)
  : exactCurrentCycle(response.value, subscription.billingCycle);
validateBreakdown(response);
```

- [ ] Run `npx tsx --test tests/helius-provider-evidence.test.ts` and confirm all tests pass.

### Task 3: Verify and deliver

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-helius-provider-evidence-design.md`

- [ ] Run `npm run build`, `npm run check`, `npm run lint`, the H2e test group, documentation checks, and the full test suite.
- [ ] Execute H2e once against the external protected artifacts and confirm only the redacted manifest is emitted.
- [ ] Request two review cycles at most, address blocking findings, wait for green CI, and merge the PR.
- [ ] Regenerate a fresh H2e evidence file immediately before the downstream H2d/H2k/H2h/H2g/H2f/H2c chain.

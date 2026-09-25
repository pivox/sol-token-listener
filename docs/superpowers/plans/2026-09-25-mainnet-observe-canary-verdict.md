# Mainnet Observe Canary Verdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Version a redacted, fail-closed evaluator that classifies Mainnet observe-only canary evidence without the four obsolete harness assertions found by the `32c9bf4` run.

**Architecture:** A pure TypeScript module under `scripts/lib` validates one closed V1 aggregate manifest and computes independent gate verdicts plus strict overall precedence. A thin CLI reads one bounded JSON file and emits one result. A sanitized fixture reproduces the failed run, while the runbook documents capture and shutdown semantics.

**Tech Stack:** TypeScript strict ESM, Node.js `node:test`, immutable JSON contracts, existing first-processing validator, npm scripts, Markdown deployment contracts.

**Plan revision:** 1.1.0. Cycle-1 corrections extend Task 2 and Task 4 with
exact terminal totals/taxonomies, same-process first-processing chronology,
HTTP counter invariants and positive-429 priority, hydration monotonicity,
authenticated periodic-pause evidence, nullable recovery coherence, and
paired finality recovery during the observation window.

---

### Task 1: Freeze the redacted evidence contract with failing tests

**Files:**
- Create: `tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json`
- Create: `tests/mainnet-observe-canary-verdict.test.ts`
- Create: `scripts/lib/mainnet-observe-canary-verdict.ts`

- [ ] **Step 1: Add the sanitized failed-run fixture**

Create an exact V1 manifest containing four snapshots named `T0`, `T_PLUS_5`,
`T_PLUS_15`, and `FINAL_PRESTOP`, the stopped heartbeat, structured finality
diagnostics, post-stop actionable count, version/replay proof, and cleanup
result. Preserve these observed aggregates:

```json
{
  "schemaVersion": "mainnet-observe-canary-input.v1",
  "commit": "32c9bf4c35268219184bd054f1e1f643065ecfd6",
  "snapshots": {
    "T0": { "backlogCount": 209 },
    "T_PLUS_5": { "backlogCount": 7818 },
    "T_PLUS_15": { "backlogCount": 25549 },
    "FINAL_PRESTOP": { "backlogCount": 26658 }
  },
  "postStopActionableCount": 26742,
  "cleanupComplete": true
}
```

Fill only the fixed aggregate fields defined by the design. Copy the exact
first-processing object from the redacted verdict and the exact public version
counts `legacy=841`, `v0=272`, `v1=192`. Do not include raw logs, URLs,
signatures, mints, wallet identifiers, or transaction bodies.

- [ ] **Step 2: Write RED tests for the real fixture and corrected gates**

In `tests/mainnet-observe-canary-verdict.test.ts`, import
`evaluateMainnetObserveCanary` and assert:

```ts
const result = evaluateMainnetObserveCanary(fixture);
assert.equal(result.overallVerdict, 'FAIL');
assert.equal(result.gates.catchUpAdmission.verdict, 'PASS');
assert.equal(result.gates.providerAffinity.verdict, 'PASS');
assert.equal(result.gates.finality.verdict, 'PASS');
assert.equal(result.gates.shutdown.verdict, 'PASS');
for (const gate of ['runtime', 'backlog', 'terminalFailures',
  'firstProcessing', 'blockHydration'] as const) {
  assert.equal(result.gates[gate].verdict, 'FAIL');
}
```

Add focused tests proving that `scanActive=true` with
`workerClaimReady=true` passes for a non-null stable provider, positive
monotone epoch invalidations alone pass, a recovered pre-T0 finality incident
passes, and a coherent non-zero durable backlog passes shutdown.

- [ ] **Step 3: Write RED exactness and fail-closed tests**

Add table-driven cases for:

```ts
[
  ['null provider with active scan', mutate(...), 'catchUpAdmission'],
  ['partition mismatch', mutate(...), 'catchUpAdmission'],
  ['provider switch without mixing proof', mutate(...), 'providerAffinity'],
  ['mixed-provider evidence', mutate(...), 'providerAffinity'],
  ['unresolved finality incident', mutate(...), 'finality'],
  ['shutdown lease remains', mutate(...), 'shutdown'],
  ['shutdown SQL count differs', mutate(...), 'shutdown'],
  ['terminal reasons missing', mutate(...), 'terminalFailures'],
]
```

Expect `INCONCLUSIVE` for incomplete evidence and `FAIL` for proven unsafe
state. Add proxy, accessor, unexpected-key, negative-zero, unsafe-integer, and
secret-field rejection cases. The evaluator must return a bounded
`INCONCLUSIVE` result without invoking accessors.

- [ ] **Step 4: Add only the exported types and a throwing placeholder**

Create the module with closed public result types and:

```ts
export type MainnetObserveCanaryVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export function evaluateMainnetObserveCanary(
  _input: unknown,
): MainnetObserveCanaryResultV1 {
  throw new TypeError('Mainnet observe canary evidence is invalid.');
}
```

- [ ] **Step 5: Run RED and record the expected failure**

Run:

```bash
npx tsx --test --test-concurrency=1 tests/mainnet-observe-canary-verdict.test.ts
```

Expected: tests fail because the evaluator placeholder throws before producing
the required gate verdicts.

- [ ] **Step 6: Commit the RED contract**

```bash
git add tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json \
  tests/mainnet-observe-canary-verdict.test.ts \
  scripts/lib/mainnet-observe-canary-verdict.ts
git commit -m "test(canary): freeze observe verdict contract"
```

### Task 2: Implement the pure fail-closed evaluator

**Files:**
- Modify: `scripts/lib/mainnet-observe-canary-verdict.ts`
- Modify: `tests/mainnet-observe-canary-verdict.test.ts`

- [ ] **Step 1: Implement hostile-input-safe snapshots**

Use `types.isProxy`, own property descriptors, exact key arrays, and safe
non-negative integer checks. Snapshot every accepted nested object and array
into frozen plain data before evaluation. Reuse
`createFirstProcessingCanaryEvidence` for the existing V1 latency contract.
Never access arbitrary inherited properties or getters.

- [ ] **Step 2: Implement verdict precedence and unchanged gates**

Add a helper with exact precedence:

```ts
function aggregateVerdict(values: readonly MainnetObserveCanaryVerdict[]):
MainnetObserveCanaryVerdict {
  if (values.includes('FAIL')) return 'FAIL';
  if (values.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}
```

Evaluate HTTP 429, backlog, terminal failures, idempotence, retention, decoder
quarantine, first processing, hydration, RSS, PumpSwap, versions/replay, and
cleanup from their raw bounded aggregates. Do not accept caller-supplied gate
verdicts.

- [ ] **Step 3: Implement corrected admission and affinity gates**

Admission accepts the same-provider `true/true` phase. Require both partition
sums to equal `backlogCount`. Affinity requires stable public provider IDs,
monotone epoch counters, and zero mixing evidence. Return `INCONCLUSIVE` for a
provider switch without mixing proof and `FAIL` for positive mixing evidence.

- [ ] **Step 4: Implement paired finality diagnostics**

Parse only exact structured entries with event
`listener.finality_reconciler_degraded` or
`listener.finality_reconciler_recovered`, safe timestamps, phase, and fixed
reason code. Pair them in order. A recovered incident ending before T0 passes;
an open incident is `FAIL`; malformed pairing is `INCONCLUSIVE`. Independently
require every sampled reconciler `RUNNING`, positive final overlap, zero
contradictions, and zero replay-receipt violations.

- [ ] **Step 5: Implement durable-backlog shutdown**

Require every stopped component, zero leases, `scanActive=false`,
`workerClaimReady=false`, null provider, and zero queued/in-flight/retained
cache values. Accept a non-zero backlog only when source partitions, priority
partitions, heartbeat backlog, and `postStopActionableCount` all match exactly.

- [ ] **Step 6: Run GREEN and refactor without changing behavior**

Run:

```bash
npx tsx --test --test-concurrency=1 tests/mainnet-observe-canary-verdict.test.ts
npm run check:backend
npm run lint:backend
```

Expected: all new tests pass and TypeScript/ESLint exit zero.

- [ ] **Step 7: Commit the evaluator**

```bash
git add scripts/lib/mainnet-observe-canary-verdict.ts \
  tests/mainnet-observe-canary-verdict.test.ts
git commit -m "feat(canary): evaluate observe evidence fail closed"
```

### Task 3: Add the bounded redacted CLI

**Files:**
- Create: `scripts/evaluate-mainnet-observe-canary.ts`
- Create: `tests/mainnet-observe-canary-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write RED CLI tests**

Test the exported command runner with injected file reading and output rather
than spawning for the core cases. Cover one valid fixture, oversized input,
invalid JSON, unexpected argument count, read failure, and malicious JSON
fields. Assert that failures return only:

```text
MAINNET_OBSERVE_CANARY_EVALUATION_FAILED
```

and never contain the supplied path or input fragment. Add one spawn test for
exit `2` on the known failing fixture and exact one-line JSON stdout.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test --test-concurrency=1 tests/mainnet-observe-canary-cli.test.ts
```

Expected: module-not-found or missing exported runner failure.

- [ ] **Step 3: Implement the minimal CLI**

Read at most 1 MiB from exactly one regular file, parse JSON, evaluate it, and
write canonical JSON plus one newline. Do not follow a final-component symlink.
Return exit `0` only for `PASS`; return `2` for evaluated `FAIL` or
`INCONCLUSIVE`; return `1` and the fixed stderr code for invocation/read/parse
errors. Add:

```json
"canary:evaluate": "tsx scripts/evaluate-mainnet-observe-canary.ts"
```

- [ ] **Step 4: Run GREEN and CLI smoke**

```bash
npx tsx --test --test-concurrency=1 tests/mainnet-observe-canary-cli.test.ts
npm run canary:evaluate -- tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json
```

Expected: tests pass; CLI prints overall `FAIL` and exits `2`.

- [ ] **Step 5: Commit the CLI**

```bash
git add scripts/evaluate-mainnet-observe-canary.ts \
  tests/mainnet-observe-canary-cli.test.ts package.json
git commit -m "feat(canary): add redacted verdict CLI"
```

### Task 4: Align the operator runbook and deployment contracts

**Files:**
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write RED documentation-contract assertions**

Require the runbook to state all of the following:

```text
scanActive=true and workerClaimReady=true is valid for same-provider sharing
epochInvalidations is diagnostic and monotone, not a provider-mixing verdict
finality degraded/recovered diagnostics are paired structurally
durable backlog may remain after shutdown
leases, scan admission, queued/in-flight RPC and cache must be zero
post-stop SQL actionable count must equal both backlog partitions
```

Require the system overview to link the V1 design and operator CLI.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test --test-concurrency=1 tests/deployment-artifacts.test.ts
```

Expected: new documentation assertions fail against the old wording.

- [ ] **Step 3: Update the runbook and overview**

Replace the obsolete statement that periodic continuation closes the session.
Document same-provider sharing, structured finality pairing, diagnostic epoch
invalidations, and the exact durable shutdown reconciliation. Add the command:

```bash
npm run canary:evaluate -- /absolute/path/to/redacted-canary-input.v1.json
```

State that `FAIL` and `INCONCLUSIVE` both block readiness and wallet access.

- [ ] **Step 4: Run GREEN and docs check**

```bash
npx tsx --test --test-concurrency=1 tests/deployment-artifacts.test.ts
npm run docs:check
```

Expected: both commands exit zero.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/operations/block-hydration-canary.md \
  docs/architecture/system-overview.md tests/deployment-artifacts.test.ts
git commit -m "docs(canary): align provider-affine verdict gates"
```

### Task 5: Verify and prepare the pull request

**Files:**
- Modify only if verification reveals an issue in the files above.

- [ ] **Step 1: Run focused regression suites**

```bash
npx tsx --test --test-concurrency=1 \
  tests/mainnet-observe-canary-verdict.test.ts \
  tests/mainnet-observe-canary-cli.test.ts \
  tests/deployment-artifacts.test.ts \
  tests/first-processing-canary.test.ts \
  tests/finality-reconciler-diagnostic-logger.test.ts \
  tests/provider-affine-catch-up-hydration.test.ts
```

- [ ] **Step 2: Run repository gates**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
```

Expected: every command exits zero; PostgreSQL-only tests may skip only when
their documented test database variable is absent.

- [ ] **Step 3: Review exact scope and secrets**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n "https?://|api[_-]?key|private[_-]?key|signature|mint|wallet" \
  tests/fixtures/mainnet-observe-canary
```

Expected: no diff errors, only #169 files, and no secret/high-cardinality
fixture field. The commit hash is permitted; URLs, signatures, mints, wallets,
and keys are not.

- [ ] **Step 4: Perform two review cycles maximum**

Cycle 1 checks spec compliance and correctness. Apply confirmed blocking or
important findings and rerun targeted tests. Cycle 2 checks the final diff and
must not expand scope. Record both outcomes in the uncommitted tracking file.

- [ ] **Step 5: Push, open PR, request GitHub Codex review, and merge only green**

Push `fix/169-canary-gates`, open a PR linked to #169, request a posted Codex
review, wait for all checks and threads, address confirmed feedback within the
two-cycle limit, and merge only with a clean head SHA. Verify the post-merge
`main` CI before starting the separate capacity-admission issue.

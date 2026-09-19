# Solana V1 Read Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every existing transaction-returning Solana read accept transaction version 1 while preserving all observe-only safety, provider affinity and error-redaction contracts.

**Architecture:** Upgrade the official legacy SDK to its first stable v1-readable release, centralize the supported read version in one literal constant, and inject that constant into the five current read boundaries. Tests exercise request construction and a sanitized v1 `getBlock` response before the Mainnet reproduction is replayed read-only.

**Tech Stack:** TypeScript strict ESM, Node test runner, `@solana/web3.js` 1.99.0, npm lockfile.

---

### Task 1: Prove the missing v1 request contract

**Files:**
- Create: `tests/transaction-version.test.ts`
- Create: `tests/transaction-fetcher.test.ts`
- Create: `tests/solana-v1-read.integration.test.ts`
- Modify: `tests/provider-pinned-block-rpc.test.ts`
- Modify: `tests/rpc-client.test.ts`
- Modify: `tests/executor-live-recovery-rpc.test.ts`

- [ ] **Step 1: Add RED assertions for the canonical read version**

First create the sanitized `Connection` integration test. It deliberately passes
the literal `1` directly so it can execute against SDK 1.98.4 before the new
production constant exists. Its only transaction uses `version: 1`, three
deterministic public keys, one instruction, a v1 `transactionConfig`, consistent
empty metadata arrays and three pre/post balances.

Then create a contract test which expects one exported literal:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SUPPORTED_TRANSACTION_VERSION } from '../src/solana/rpc/transaction-version.js';

void test('supports every currently active Solana transaction version for reads', () => {
  assert.equal(MAX_SUPPORTED_TRANSACTION_VERSION, 1);
});
```

Add a `TransactionFetcher` test with a frozen fake HTTP client. Assert that its
single `getTransaction` call receives:

```ts
{
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
}
```

Change only the existing expected request objects in provider-pinned block,
RPC-client and executor-recovery tests from version `0` to version `1`.

Assert that the sanitized response returns transaction version `1`.

- [ ] **Step 2: Run the SDK fixture alone and verify RED**

Run:

```bash
npx tsx --test tests/solana-v1-read.integration.test.ts
```

Expected: SDK 1.98.4 rejects transaction version `1` at its response schema.

- [ ] **Step 3: Run the remaining focused tests and verify RED**

Run:

```bash
npx tsx --test \
  tests/transaction-version.test.ts \
  tests/transaction-fetcher.test.ts \
  tests/provider-pinned-block-rpc.test.ts \
  tests/rpc-client.test.ts \
  tests/executor-live-recovery-rpc.test.ts
```

Expected: failure because `transaction-version.ts` does not exist and existing
production requests still send `0`.

### Task 2: Upgrade the official SDK and centralize the version

**Files:**
- Create: `src/solana/rpc/transaction-version.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/solana/rpc/transaction-fetcher.ts`
- Modify: `src/solana/rpc/rpc-client.ts`
- Modify: `src/solana/rpc/provider-pinned-block-rpc.ts`
- Modify: `src/executor-live-recovery/rpc-gateway.ts`

- [ ] **Step 1: Install the exact official SDK version**

Run:

```bash
npm install --save-exact @solana/web3.js@1.99.0
```

Expected: `package.json` and the root lockfile resolve exactly 1.99.0; no other
direct dependency is changed.

- [ ] **Step 2: Add the minimal production constant**

```ts
export const MAX_SUPPORTED_TRANSACTION_VERSION = 1 as const;
```

- [ ] **Step 3: Apply it to every read boundary**

Import the constant and replace each literal `0` in transaction-returning read
requests:

```ts
maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
```

In `provider-pinned-block-rpc.ts`, update the internal structural interface from
literal `0` to `typeof MAX_SUPPORTED_TRANSACTION_VERSION`; do not change its
timeout, abort, provider or redaction code.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npx tsx --test \
  tests/solana-v1-read.integration.test.ts \
  tests/transaction-version.test.ts \
  tests/transaction-fetcher.test.ts \
  tests/provider-pinned-block-rpc.test.ts \
  tests/rpc-client.test.ts \
  tests/executor-live-recovery-rpc.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Run strict type checking**

Run:

```bash
npm run check:backend
```

Expected: exit 0 and no type widening or `any` added.

### Task 3: Verify SDK v1 response compatibility without Mainnet

**Files:**
- Verify: `tests/solana-v1-read.integration.test.ts`

- [ ] **Step 1: Verify the sanitized v1 block response test**

The Task 1 `Connection` fixture contains one block whose only transaction has:

```ts
version: 1,
transaction: {
  signatures: ['1111111111111111111111111111111111111111111111111111111111111111'],
  message: {
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    },
    accountKeys: [
      '11111111111111111111111111111111',
      'SysvarC1ock11111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
    ],
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [{ programIdIndex: 2, accounts: [1, 0], data: '1', stackHeight: 1 }],
    transactionConfig: {
      priorityFee: 2,
      computeUnitLimit: 19,
      loadedAccountsDataSizeLimit: 32000,
      heapSize: null,
    },
  },
},
```

It supplies consistent empty metadata arrays, three pre/post balances and the
normal block fields. Confirm `getBlock` returns transaction version `1` and
three account keys, and performs no network request other than the injected
fetch. The separate contract test binds the production constant to the same
value.

- [ ] **Step 2: Verify that the new test passes on 1.99.0**

Run:

```bash
npx tsx --test tests/solana-v1-read.integration.test.ts
```

Expected: one v1 block is accepted. The RED schema rejection was already
recorded in Task 1 against SDK 1.98.4.

- [ ] **Step 3: Run normalization regressions**

Run:

```bash
npx tsx --test tests/transaction-locator.test.ts tests/transaction-fetcher.test.ts
```

Expected: legacy/v0 tests and the new read-version test pass.

### Task 4: Document the canary failure and replay condition

**Files:**
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `docs/superpowers/specs/2026-09-19-solana-v1-read-compatibility-design.md`

- [ ] **Step 1: Add the protocol precondition**

Document that the canary must prove the runtime accepts every transaction
version active on the cluster, currently v1, and that JSON-RPC `-32015` is a
hard `FAIL`, not an RPC availability success merely because HTTP status is 200.

- [ ] **Step 2: Version the spec**

Bump the spec only if implementation details changed during TDD. Otherwise keep
1.0.0 and add no retrospective claims to the design.

- [ ] **Step 3: Run documentation checks**

```bash
npm run docs:check
```

Expected: exit 0.

### Task 5: Full verification, read-only reproduction and delivery

**Files:**
- Modify: `.codex-work-tracking.md` locally only; it remains ignored and must not be staged.

- [ ] **Step 1: Run the complete local gate**

Export the task-owned PostgreSQL test URL from its protected external
environment, without printing it, then run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
test -n "$TEST_DATABASE_URL"
npm test
```

Expected: all backend PostgreSQL, frontend and documentation tests pass with
zero failures.

- [ ] **Step 2: Reproduce the public block read safely**

Using the configured provider only in process memory, call the production
`ProviderPinnedBlockRpc` for the public reproduction slot at confirmed
commitment. Print only slot, aggregate transaction count and distinct public
versions. Expected: success including version `1`; never print the URL, API key,
signatures or block body.

- [ ] **Step 3: Review and commit**

Run `git diff --check`, inspect every dependency-lock change, stage only issue
#139 files, and commit with a focused message.

- [ ] **Step 4: Open and review the PR**

Push the branch, open a PR closing #139, request Codex review, process at most
two cycles, and merge only with green required checks and no unresolved
blocking thread.

- [ ] **Step 5: Resume the roadmap**

After green post-merge CI, recreate a fresh canary database and rerun the
15-minute Mainnet observe-only procedure. Do not proceed to H2e/H2c or wallet
handling unless that canary passes.

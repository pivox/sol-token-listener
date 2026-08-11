# Bounded Dependency Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce and lock the npm dependency surface with compatible maintenance updates while preserving every observe/paper, Pump.fun, PumpSwap, frontend, and Raydium adapter behavior.

**Architecture:** Treat `package.json` and the version 3 workspace lockfile as a tested contract. Remove only the unused Raydium SDK package, apply a fixed allowlist of maintenance releases, retain official SDK bridges and Solana pins, then document the two unresolved upstream leaf advisories without introducing overrides or forced fixes.

**Tech Stack:** Node.js 22+, npm workspaces/lockfile v3, TypeScript NodeNext/ESM, Node test runner, Vitest, Playwright, PostgreSQL.

---

## File map

- `package.json` — direct backend/tooling dependency allowlist and scripts.
- `frontend/package.json` — frontend tooling pin aligned with the root workspace.
- `package-lock.json` — single reproducible root/frontend dependency graph.
- `tests/dependency-safety.test.ts` — manifest, lockfile, advisory-fix, and SDK bridge contracts.
- `SECURITY.md` — dated audit evidence, accepted residual risks, and deferred remediation.
- `docs/superpowers/specs/2026-08-11-dependency-maintenance-design.md` — approved design; do not change scope during implementation.

### Task 1: Make the dependency contract fail on the current graph

**Files:**
- Modify: `tests/dependency-safety.test.ts`
- Test: `tests/dependency-safety.test.ts`

- [ ] **Step 1: Extend the parsed manifest and lockfile shapes**

Replace the local interfaces with:

```ts
interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: unknown;
}

interface LockedPackage {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockedPackage>>;
}
```

- [ ] **Step 2: Add the failing direct-pin and unused-package test**

Append:

```ts
void test('locks the reviewed runtime graph without overrides or the unused Raydium SDK', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;
  const lockedRoot = lock.packages?.[''];
  const expected = Object.freeze({
    '@pump-fun/pump-sdk': '1.36.0',
    '@pump-fun/pump-swap-sdk': '1.19.0',
    '@solana/spl-token': '0.4.15',
    '@solana/web3.js': '1.98.4',
    'bn.js': '5.2.5',
    parse5: '8.0.1',
    pg: '8.23.0',
    tldts: '7.4.10',
  });

  assert.equal(Object.hasOwn(manifest, 'overrides'), false);
  assert.equal(manifest.dependencies?.['@raydium-io/raydium-sdk-v2'], undefined);
  assert.equal(lock.packages?.['node_modules/@raydium-io/raydium-sdk-v2'], undefined);
  for (const [name, version] of Object.entries(expected)) {
    assert.equal(manifest.dependencies?.[name], version, `${name} manifest pin`);
    assert.equal(lockedRoot?.dependencies?.[name], version, `${name} root lock pin`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `${name} resolved pin`);
  }
});

void test('locks the reviewed maintenance toolchain in both workspaces', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const frontend = JSON.parse(
    await readFile(new URL('frontend/package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;

  const rootPins = Object.freeze({
    '@types/bn.js': '5.2.0',
    '@types/pg': '8.21.0',
    tsx: '4.23.12',
    'typescript-eslint': '8.67.0',
  });
  for (const [name, version] of Object.entries(rootPins)) {
    assert.equal(manifest.devDependencies?.[name], version, `${name} manifest pin`);
    assert.equal(lock.packages?.['']?.devDependencies?.[name], version, `${name} root lock pin`);
  }
  assert.equal(frontend.devDependencies?.['typescript-eslint'], '8.67.0');
  assert.equal(lock.packages?.frontend?.devDependencies?.['typescript-eslint'], '8.67.0');
});
```

- [ ] **Step 3: Run the red test**

Run:

```bash
npx tsx --test tests/dependency-safety.test.ts
```

Expected: failure because Raydium remains declared and the reviewed maintenance versions are not installed.

- [ ] **Step 4: Commit the red contract**

```bash
git add tests/dependency-safety.test.ts
git commit -m "test: define reviewed dependency graph (#43)"
```

### Task 2: Apply only the approved dependency changes

**Files:**
- Modify: `package.json`
- Modify: `frontend/package.json`
- Modify: `package-lock.json`
- Test: `tests/dependency-safety.test.ts`

- [ ] **Step 1: Remove the unused direct SDK package**

Run:

```bash
npm uninstall @raydium-io/raydium-sdk-v2
```

Expected: the package disappears from the root manifest and lockfile; no file under `src/dex/raydium-cpmm/` changes.

- [ ] **Step 2: Install the exact approved runtime and root tooling versions**

Run:

```bash
npm install --save-exact pg@8.23.0
npm install --save-dev --save-exact @types/bn.js@5.2.0 @types/pg@8.21.0 tsx@4.23.12 typescript-eslint@8.67.0
```

Expected: only the specified direct pins and their compatible lockfile resolutions change.

- [ ] **Step 3: Align the frontend tooling pin**

Run:

```bash
npm install --workspace frontend --save-dev --save-exact typescript-eslint@8.67.0
```

Expected: `frontend/package.json` and the `frontend` lockfile workspace entry both contain `8.67.0`.

- [ ] **Step 4: Verify the green dependency contract and clean graph**

Run:

```bash
npx tsx --test tests/dependency-safety.test.ts
npm ls --depth=0
git diff --check
```

Expected: all dependency tests pass, npm reports no missing/invalid direct package, and the diff has no whitespace errors.

- [ ] **Step 5: Confirm the retained Raydium adapter is independent**

Run:

```bash
rg -n "(?:from|import\\() ['\"]@raydium-io/raydium-sdk-v2" src tests scripts
npx tsx --test tests/swap-classification.test.ts tests/session-engine.test.ts tests/bootstrap-safety.test.ts
```

Expected: `rg` returns no imports and the Raydium classification, session, and passive-bootstrap tests pass.

- [ ] **Step 6: Commit the targeted graph update**

```bash
git add package.json frontend/package.json package-lock.json
git commit -m "chore: reduce and refresh dependency graph (#43)"
```

### Task 3: Lock official SDK loading and document residual advisories

**Files:**
- Modify: `tests/dependency-safety.test.ts`
- Modify: `SECURITY.md`
- Test: `tests/dependency-safety.test.ts`

- [ ] **Step 1: Add bridge characterization coverage**

Append this test without changing either production bridge:

```ts
void test('loads the required official Pump SDK exports through Node-compatible bridges', async () => {
  const pump = await import('../src/launchpads/pumpfun/official-sdk.js');
  const swap = await import('../src/markets/pumpswap/official-sdk.js');

  assert.equal(typeof pump.bondingCurvePda, 'function');
  assert.equal(typeof pump.getBuySolAmountFromTokenAmount, 'function');
  assert.equal(typeof pump.getBuyTokenAmountFromSolAmount, 'function');
  assert.equal(typeof pump.getSellSolAmountFromTokenAmount, 'function');
  assert.equal(typeof pump.PUMP_PROGRAM_ID, 'object');
  assert.equal(typeof swap.buyQuoteInput, 'function');
  assert.equal(typeof swap.poolPda, 'function');
  assert.equal(typeof swap.sellBaseInput, 'function');
  assert.equal(typeof swap.PUMP_FEE_PROGRAM_ID, 'object');
});
```

- [ ] **Step 2: Run the bridge characterization test**

Run:

```bash
npx tsx --test tests/dependency-safety.test.ts
```

Expected: all tests pass on the supported Node runtime; no direct ESM import replaces either `createRequire` bridge.

- [ ] **Step 3: Measure both audit views**

Run:

```bash
npm audit --json
npm audit --omit=dev --json
npm ls bigint-buffer uuid jayson @solana/buffer-layout-utils @solana/web3.js --all
```

Expected: non-zero audit exits remain because the two documented upstream leaf advisories are unresolved; no `bn.js` vulnerable release appears.

- [ ] **Step 4: Replace `SECURITY.md` audit evidence with the current decision**

Keep the reporting and observe/paper boundary sections, set `Last reviewed` to `2026-08-11`, and add:

```markdown
## Audit interpretation

The npm audit report propagates each leaf advisory through every affected
parent package. The count of affected package records is therefore not the
count of independent vulnerabilities. On 2026-08-11, both the full workspace
and `--omit=dev` reports traced back to the two leaf advisories below.

The unused `@raydium-io/raydium-sdk-v2` direct dependency was removed without
removing the repository's Raydium CPMM adapter. Compatible maintenance releases
for PostgreSQL and TypeScript tooling were applied independently. Neither
change provides a compatible remediation for the Solana Web3.js v1 advisories.
```

Record the exact fresh full and production-only affected-record counts in the same section. Retain the advisory table, explain that npm proposes incompatible historical downgrades, and explicitly forbid `npm audit fix --force` and overrides.

- [ ] **Step 5: Commit contracts and evidence**

```bash
git add tests/dependency-safety.test.ts SECURITY.md
git commit -m "docs: record dependency audit decisions (#43)"
```

### Task 4: Verify the entire repository and real PostgreSQL path

**Files:**
- Verify only; modify a file only to fix a failure caused by Tasks 1–3.

- [ ] **Step 1: Reinstall from the final lockfile**

Run:

```bash
npm ci
```

Expected: a reproducible workspace install with the documented residual audit warnings and no invalid packages.

- [ ] **Step 2: Run static and generated checks**

Run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
```

Expected: all commands exit zero; both Pump IDL generated checks remain byte-for-byte clean.

- [ ] **Step 3: Run all tests against a temporary real database**

Create an isolated PostgreSQL database using the locally available PostgreSQL tooling, export its URL only as `TEST_DATABASE_URL`, then run:

```bash
npm test
```

Expected: 983 backend tests and 116 frontend tests pass with zero PostgreSQL skips. Drop only the explicitly created temporary database after the run.

- [ ] **Step 4: Run the cross-origin browser test**

Run:

```bash
npm run frontend:e2e
```

Expected: the Chromium public operator journey passes and remains read-only.

- [ ] **Step 5: Review scope and safety**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- src/execution src/dex/raydium-cpmm src/launchpads/pumpfun src/markets/pumpswap
git status --short --branch
```

Expected: no production behavior file changed, all commits are issue #43 scoped, and the worktree is clean.

- [ ] **Step 6: Push and enter the bounded review cycle**

Push `feature/dependency-maintenance-43`, open a PR that closes #43, request Codex review, and allow at most three correction/review cycles. Merge only with green checks and no unresolved blocking thread.

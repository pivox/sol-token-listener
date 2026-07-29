# Safe Dependency Security Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the compatible `bn.js` vulnerability, prevent its
reintroduction, and document the upstream Solana dependency alerts that cannot
currently be remediated safely.

**Architecture:** Keep the dependency graph supported by the official Pump.fun,
Raydium and Solana Web3.js v1 packages. A lockfile contract test enforces the
patched `bn.js` boundary, while `SECURITY.md` records upstream exceptions
without overrides or false clean-audit claims.

**Tech Stack:** Node.js 22, npm lockfile v3, TypeScript, Node test runner.

---

## File map

- `package.json` — pins the compatible patched direct `bn.js` release.
- `package-lock.json` — records the resolved supported dependency graph.
- `tests/dependency-safety.test.ts` — rejects vulnerable locked `bn.js` v5
  releases.
- `SECURITY.md` — publishes reporting guidance and time-bounded upstream audit
  exceptions.

### Task 1: Enforce and install the patched `bn.js`

**Files:**

- Create: `tests/dependency-safety.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing lockfile contract**

Create `tests/dependency-safety.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface LockedPackage {
  readonly version?: string;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockedPackage>>;
}

const root = new URL('../', import.meta.url);

void test('every locked bn.js v5 release contains the infinite-loop fix', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;

  assert.equal(manifest.dependencies?.['bn.js'], '5.2.5');
  assert.equal(lock.lockfileVersion, 3);

  const versions = Object.entries(lock.packages ?? {})
    .filter(([path]) => /(?:^|\/)node_modules\/bn\.js$/u.test(path))
    .map(([, entry]) => entry.version);

  assert.ok(versions.length > 0, 'package-lock.json must contain bn.js');
  for (const version of versions) {
    assert.match(version ?? '', /^5\.\d+\.\d+$/u);
    const [, minorText, patchText] = version?.split('.') ?? [];
    const minor = Number(minorText);
    const patch = Number(patchText);
    assert.ok(
      minor > 2 || (minor === 2 && patch >= 3),
      `bn.js ${version ?? 'missing'} is vulnerable to GHSA-378v-28hj-76wf`,
    );
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --test tests/dependency-safety.test.ts
```

Expected: FAIL because the manifest and lockfile still contain `bn.js@5.2.2`.

- [ ] **Step 3: Install the exact compatible patch**

Run:

```bash
npm install --save-exact bn.js@5.2.5
```

Do not use `--force`, `--legacy-peer-deps`, or npm overrides.

- [ ] **Step 4: Verify the focused contract and resolved graph**

Run:

```bash
npx tsx --test tests/dependency-safety.test.ts
npm ls bn.js --all
```

Expected: the test passes and every displayed `bn.js` v5 resolution is at
least `5.2.3`, normally deduplicated to `5.2.5`.

- [ ] **Step 5: Commit the remediation**

```bash
git add package.json package-lock.json tests/dependency-safety.test.ts
git commit -m "fix: update bn.js beyond vulnerable range"
```

### Task 2: Document upstream audit exceptions

**Files:**

- Create: `SECURITY.md`

- [ ] **Step 1: Write the security policy**

Create `SECURITY.md` with these sections:

```markdown
# Security policy

## Reporting

Report suspected vulnerabilities through a private GitHub security advisory.
Do not publish secrets, private keys, RPC credentials or database URLs in a
public issue.

## Runtime boundary

Pump.fun V1 supports observation and paper trading only. It has no wallet,
signing or Solana transaction-submission path.

## Tracked upstream advisories

| Advisory | Dependency path | Status |
| --- | --- | --- |
| GHSA-3gc7-fjrx-p6mg | `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer@1.1.5` | No patched upstream release exists. Do not replace it with an unreviewed fork. |
| GHSA-w5hq-g745-h8pq | `@solana/web3.js@1.98.4` → `jayson@4.3.0` → `uuid@8.3.2` | `jayson` uses UUID v4, while the advisory affects destination buffers in UUID v3/v5/v6. A forced incompatible override is not accepted. |

These alerts are reassessed whenever Pump.fun, Raydium, SPL Token, Web3.js or
their transitive dependencies are upgraded, or when an upstream patched
release becomes available. `npm audit --force` is not an approved remediation
because it currently proposes incompatible package downgrades.
```

- [ ] **Step 2: Verify the documented paths against the installed graph**

Run:

```bash
npm ls bigint-buffer uuid @solana/buffer-layout-utils jayson --all
npm audit --omit=dev
```

Expected: `npm ls` confirms both documented paths. `npm audit` remains
non-zero because the upstream alerts are intentionally unresolved; `bn.js`
must no longer appear in the report.

- [ ] **Step 3: Run the complete acceptance suite**

Run:

```bash
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
git diff --check
git status --short
```

Expected: build, check and lint exit zero; all tests pass including the live
PostgreSQL migration; only `SECURITY.md` is uncommitted.

- [ ] **Step 4: Commit the policy**

```bash
git add SECURITY.md
git commit -m "docs: record upstream dependency advisories"
```

- [ ] **Step 5: Final review**

Review the full branch for:

- no npm override or force-install flag;
- no Solana, Pump.fun or Raydium downgrade;
- exact patched `bn.js` resolution;
- accurate advisory paths and reachability statements;
- a clean worktree after fresh verification.

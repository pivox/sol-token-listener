import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly overrides?: unknown;
}

interface LockedPackage {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockedPackage>>;
}

const root = new URL('../', import.meta.url);

function isCanonicalSemverAtLeast(
  version: string | undefined,
  [minimumMajor, minimumMinor, minimumPatch]: readonly [number, number, number],
): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version ?? '');
  if (match === null) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== minimumMajor) return major > minimumMajor;
  if (minor !== minimumMinor) return minor > minimumMinor;
  return patch >= minimumPatch;
}

void test('compares canonical dependency versions as semantic version tuples', () => {
  const braceExpansionFloor = [1, 1, 18] as const;

  assert.equal(isCanonicalSemverAtLeast('1.2.0', braceExpansionFloor), true);
  assert.equal(isCanonicalSemverAtLeast('1.1.18', braceExpansionFloor), true);
  assert.equal(isCanonicalSemverAtLeast('2.0.0', braceExpansionFloor), true);
  assert.equal(isCanonicalSemverAtLeast('1.1.17', braceExpansionFloor), false);
  assert.equal(isCanonicalSemverAtLeast('1.0.99', braceExpansionFloor), false);
  assert.equal(isCanonicalSemverAtLeast(undefined, braceExpansionFloor), false);
  assert.equal(isCanonicalSemverAtLeast('1.1', braceExpansionFloor), false);
  assert.equal(isCanonicalSemverAtLeast('1.01.18', braceExpansionFloor), false);
  assert.equal(isCanonicalSemverAtLeast('1.1.18-beta', braceExpansionFloor), false);
});

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

void test('pins the bounded public-content dependencies exactly', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;

  assert.equal(manifest.dependencies?.parse5, '8.0.1');
  assert.equal(manifest.dependencies?.tldts, '7.4.10');
  assert.equal(lock.packages?.['node_modules/parse5']?.version, '8.0.1');
  assert.equal(lock.packages?.['node_modules/tldts']?.version, '7.4.10');
});

void test('pins the official Pump.fun SDK exactly', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;

  assert.equal(manifest.dependencies?.['@pump-fun/pump-sdk'], '1.36.0');
  assert.equal(lock.packages?.['node_modules/@pump-fun/pump-sdk']?.version, '1.36.0');
});

void test('locks the reviewed runtime graph without overrides or the unused Raydium SDK', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;
  const rootLock = lock.packages?.[''];
  const runtimePins = {
    '@pump-fun/pump-sdk': '1.36.0',
    '@pump-fun/pump-swap-sdk': '1.19.0',
    '@solana/spl-token': '0.4.15',
    '@solana/web3.js': '1.98.4',
    'bn.js': '5.2.5',
    parse5: '8.0.1',
    pg: '8.23.0',
    tldts: '7.4.10',
  } as const;

  assert.equal(manifest.overrides, undefined);
  assert.equal(manifest.dependencies?.['@raydium-io/raydium-sdk-v2'], undefined);
  assert.equal(rootLock?.dependencies?.['@raydium-io/raydium-sdk-v2'], undefined);
  assert.equal(lock.packages?.['node_modules/@raydium-io/raydium-sdk-v2'], undefined);

  for (const [name, version] of Object.entries(runtimePins)) {
    assert.equal(manifest.dependencies?.[name], version, `package.json must pin ${name}`);
    assert.equal(rootLock?.dependencies?.[name], version, `package-lock root must pin ${name}`);
    assert.equal(
      lock.packages?.[`node_modules/${name}`]?.version,
      version,
      `resolved ${name} must match the manifest and root lock`,
    );
  }
});

void test('locks the reviewed maintenance toolchain in both workspaces', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const frontendManifest = JSON.parse(
    await readFile(new URL('frontend/package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;
  const rootLock = lock.packages?.[''];
  const frontendLock = lock.packages?.frontend;
  const rootToolchainPins = {
    '@types/bn.js': '5.2.0',
    '@types/pg': '8.21.0',
    tsx: '4.23.12',
    'typescript-eslint': '8.67.0',
  } as const;

  for (const [name, version] of Object.entries(rootToolchainPins)) {
    assert.equal(manifest.devDependencies?.[name], version, `package.json must pin ${name}`);
    assert.equal(rootLock?.devDependencies?.[name], version, `package-lock root must pin ${name}`);
    assert.equal(
      lock.packages?.[`node_modules/${name}`]?.version,
      version,
      `resolved ${name} must match the root workspace manifest and lock`,
    );
  }

  assert.equal(frontendManifest.devDependencies?.['typescript-eslint'], '8.67.0');
  assert.equal(frontendLock?.devDependencies?.['typescript-eslint'], '8.67.0');
  assert.equal(
    lock.packages?.['node_modules/typescript-eslint']?.version,
    '8.67.0',
    'resolved typescript-eslint must match the frontend workspace lock',
  );
});

void test('requires the supported Node floor and patched compatible transitive releases', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as PackageManifest;
  const frontendManifest = JSON.parse(
    await readFile(new URL('frontend/package.json', root), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  ) as PackageLock;
  const ciWorkflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');

  const violations: string[] = [];
  const nodeEngines = Object.freeze({
    'package.json': manifest.engines?.node,
    'frontend/package.json': frontendManifest.engines?.node,
    'package-lock.json root workspace': lock.packages?.['']?.engines?.node,
    'package-lock.json frontend workspace': lock.packages?.frontend?.engines?.node,
  });
  for (const [location, engine] of Object.entries(nodeEngines)) {
    if (engine !== '>=22.13.0') {
      violations.push(`${location} declares Node ${engine ?? 'missing'}, expected >=22.13.0`);
    }
  }

  const ciNodeVersions = [
    ...ciWorkflow.matchAll(/^\s+node-version:\s*([^\s#]+)(?:\s+#.*)?$/gmu),
  ].map((match) => match[1]);
  assert.deepEqual(ciNodeVersions, ['22.13.0', '22.13.0', '22.13.0']);

  for (const job of ['quality', 'frontend-e2e', 'deployment-contract'] as const) {
    const heading = `  ${job}:\n`;
    const jobStart = ciWorkflow.indexOf(heading);
    assert.notEqual(jobStart, -1, `CI must contain the ${job} job`);
    const followingWorkflow = ciWorkflow.slice(jobStart + heading.length);
    const nextJobStart = followingWorkflow.search(/^ {2}[\w-]+:\s*$/mu);
    const jobDefinition = nextJobStart === -1
      ? followingWorkflow
      : followingWorkflow.slice(0, nextJobStart);
    const setupNodeSteps = jobDefinition.match(
      /^\s+-\s+uses:\s+actions\/setup-node@[^\s#]+(?:\s+#.*)?$/gmu,
    ) ?? [];
    const jobNodeVersions = [
      ...jobDefinition.matchAll(/^\s+node-version:\s*([^\s#]+)(?:\s+#.*)?$/gmu),
    ].map((match) => match[1]);

    assert.equal(setupNodeSteps.length, 1, `${job} must contain one setup-node step`);
    assert.deepEqual(jobNodeVersions, ['22.13.0'], `${job} must use Node 22.13.0`);
  }

  let braceExpansionCount = 0;
  let jsYamlCount = 0;
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (/(?:^|\/)node_modules\/brace-expansion$/u.test(path)) {
      braceExpansionCount += 1;
      if (!isCanonicalSemverAtLeast(entry.version, [1, 1, 18])) {
        violations.push(`${path} ${entry.version ?? 'missing'} is vulnerable`);
      }
    }

    if (/(?:^|\/)node_modules\/js-yaml$/u.test(path)) {
      jsYamlCount += 1;
      const [majorText, minorText, patchText] = entry.version?.split('.') ?? [];
      const major = Number(majorText);
      const minor = Number(minorText);
      const patch = Number(patchText);
      if (!(major > 4 || (major === 4 && (minor > 3 || (minor === 3 && patch >= 1))))) {
        violations.push(`${path} ${entry.version ?? 'missing'} is vulnerable`);
      }
    }
  }

  assert.ok(braceExpansionCount > 0, 'package-lock.json must contain brace-expansion');
  assert.ok(jsYamlCount > 0, 'package-lock.json must contain js-yaml');
  assert.deepEqual(violations, []);
});

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

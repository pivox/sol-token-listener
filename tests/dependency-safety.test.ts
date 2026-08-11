import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

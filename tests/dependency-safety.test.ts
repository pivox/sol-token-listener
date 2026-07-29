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

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageManifest {
  readonly private?: boolean;
  readonly workspaces?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

void test('declares an isolated read-only frontend workspace', async () => {
  assert.equal(existsSync('frontend/package.json'), true, 'frontend/package.json must exist');

  const root = await readManifest('package.json');
  const frontend = await readManifest('frontend/package.json');

  assert.deepEqual(root.workspaces, ['frontend']);
  assert.equal(root.engines?.node, '>=22.12.0');
  assert.equal(root.scripts?.build, 'npm run build:backend && npm run build --workspace frontend');
  assert.equal(root.scripts?.check, 'npm run check:backend && npm run check --workspace frontend');
  assert.equal(root.scripts?.lint, 'npm run lint:backend && npm run lint --workspace frontend');
  assert.equal(root.scripts?.test, 'npm run test:backend && npm test --workspace frontend');
  assert.equal(frontend.private, true);
  assert.equal(frontend.scripts?.test, 'vitest run');
  assert.equal(
    frontend.devDependencies?.jsdom,
    '28.1.0',
    'jsdom must support the declared Node >=22.12 runtime and current Node releases',
  );

  for (const dependency of Object.keys(frontend.dependencies ?? {})) {
    assert.equal(dependency.includes('solana'), false);
    assert.equal(dependency.includes('wallet'), false);
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyMigrationArtifacts } from '../scripts/copy-migrations.js';

void test('copies only canonical migration SQL with deterministic names and exact bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-migrations-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    await writeFile(join(sourceDirectory, '010_last.sql'), Buffer.from([0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x31, 0x3b, 0x0a]));
    await writeFile(join(sourceDirectory, '001_first.sql'), 'CREATE TABLE exact_bytes();\n');
    await writeFile(join(sourceDirectory, 'README.md'), 'not a migration');
    await writeFile(join(targetDirectory, '999_stale.sql'), 'stale');

    const copied = await copyMigrationArtifacts({ sourceDirectory, targetDirectory });

    assert.deepEqual(copied, ['001_first.sql', '010_last.sql']);
    assert.deepEqual((await readdir(targetDirectory)).sort(), ['001_first.sql', '010_last.sql']);
    for (const name of copied) {
      assert.deepEqual(
        await readFile(join(targetDirectory, name)),
        await readFile(join(sourceDirectory, name)),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects a source without canonical migration SQL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-empty-migrations-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  try {
    await mkdir(sourceDirectory);
    await assert.rejects(
      copyMigrationArtifacts({ sourceDirectory, targetDirectory }),
      /No canonical migration SQL files found/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('the build script packages migrations after TypeScript compilation', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };

  assert.equal(
    packageJson.scripts?.build,
    'tsc -p tsconfig.json && tsx scripts/copy-migrations.ts && tsx scripts/copy-qualification-profiles.ts',
  );
});

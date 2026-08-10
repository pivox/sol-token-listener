import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyQualificationProfiles } from '../scripts/copy-qualification-profiles.js';

const profileName = 'pumpfun-v1-unvalidated.json';
const bundledProfile = new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url);

void test('copies the only canonical profile byte-for-byte and removes stale target files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-qualification-profiles-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    const expected = await readFile(bundledProfile);
    await writeFile(join(sourceDirectory, profileName), expected);
    await writeFile(join(sourceDirectory, 'ignored.json'), '{}');
    await writeFile(join(targetDirectory, 'stale.json'), 'stale');

    const copied = await copyQualificationProfiles({ sourceDirectory, targetDirectory });

    assert.deepEqual(copied, [profileName]);
    assert.deepEqual(await readFile(join(targetDirectory, profileName)), expected);
    assert.deepEqual((await readdir(targetDirectory)).sort(), [profileName]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects missing, invalid, and oversized profile sources before cleaning the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-invalid-qualification-profile-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    const stale = join(targetDirectory, 'preserve-me');
    await writeFile(stale, 'stale');
    for (const contents of [undefined, Buffer.from('{'), Buffer.alloc(65_537)]) {
      if (contents === undefined) {
        await rm(join(sourceDirectory, profileName), { force: true });
      } else {
        await writeFile(join(sourceDirectory, profileName), contents);
      }
      await assert.rejects(copyQualificationProfiles({ sourceDirectory, targetDirectory }));
      assert.equal(await readFile(stale, 'utf8'), 'stale');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects symlinked sources and source-target aliases without altering the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-unsafe-qualification-profile-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    await symlink(bundledProfile, join(sourceDirectory, profileName));
    await assert.rejects(copyQualificationProfiles({ sourceDirectory, targetDirectory }));
    assert.equal((await lstat(join(sourceDirectory, profileName))).isSymbolicLink(), true);

    await rm(join(sourceDirectory, profileName));
    await writeFile(join(sourceDirectory, profileName), await readFile(bundledProfile));
    await assert.rejects(copyQualificationProfiles({ sourceDirectory, targetDirectory: sourceDirectory }));
    assert.deepEqual(await readFile(join(sourceDirectory, profileName)), await readFile(bundledProfile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects the current working directory as a target without deleting its sentinel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-cwd-target-'));
  const childWorkingDirectory = join(root, 'cwd');
  const sourceDirectory = join(root, 'source');
  const sentinel = join(childWorkingDirectory, 'sentinel');
  const copierPath = fileURLToPath(new URL('../scripts/copy-qualification-profiles.ts', import.meta.url));
  const tsxLoaderPath = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  try {
    await mkdir(sourceDirectory);
    await mkdir(childWorkingDirectory);
    await writeFile(join(sourceDirectory, profileName), await readFile(bundledProfile));
    await writeFile(sentinel, 'preserve-me');
    const script = `
      import { copyQualificationProfiles } from ${JSON.stringify(copierPath)};
      try {
        await copyQualificationProfiles({ sourceDirectory: ${JSON.stringify(sourceDirectory)}, targetDirectory: '.' });
        process.exitCode = 1;
      } catch {
        process.exitCode = 0;
      }
    `;
    const child = spawn(process.execPath, ['--import', tsxLoaderPath, '--input-type=module', '--eval', script], {
      cwd: childWorkingDirectory, stdio: 'inherit',
    });
    await new Promise<void>((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('exit', (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new Error(`child exited ${code}`));
      });
    });
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve-me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects deeply nested JSON before cleaning the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-deep-qualification-profile-'));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  const sentinel = join(targetDirectory, 'preserve-me');
  try {
    await mkdir(sourceDirectory);
    await mkdir(targetDirectory);
    await writeFile(join(sourceDirectory, profileName), `${'['.repeat(15_000)}${']'.repeat(15_000)}`);
    await writeFile(sentinel, 'stale');

    await assert.rejects(
      copyQualificationProfiles({ sourceDirectory, targetDirectory }),
      (error: unknown) => error instanceof Error && !(error instanceof RangeError),
    );

    assert.equal(await readFile(sentinel, 'utf8'), 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

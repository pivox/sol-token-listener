import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readPreflightProtectedFile,
  writeAtomicPreflightBundle,
} from '../src/preflight-bundle/main.js';

void test('publishes an immutable-looking bundle directory with strict permissions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-bundle-'));
  context.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const output = join(root, 'bundle');
  await writeAtomicPreflightBundle(output, Object.freeze({
    qualificationEnvelope: '{"qualification":true}',
    canaryEnvelope: '{"canary":true}',
    manifestJson: '{"manifest":true}',
  }));
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  for (const file of ['qualification.json', 'canary.json', 'manifest.json']) {
    assert.equal((await lstat(join(output, file))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), '{"manifest":true}');
  await assert.rejects(() => writeAtomicPreflightBundle(output, Object.freeze({
    qualificationEnvelope: '{}', canaryEnvelope: '{}', manifestJson: '{}',
  })));
});

void test('reads only owner-protected regular input files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-input-'));
  context.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const safe = join(root, 'safe');
  await writeFile(safe, 'safe', { mode: 0o600 });
  assert.equal(await readPreflightProtectedFile(safe, 16), 'safe');
  const open = join(root, 'open');
  await writeFile(open, 'open', { mode: 0o644 });
  await assert.rejects(() => readPreflightProtectedFile(open, 16));
  const directory = join(root, 'directory');
  await mkdir(directory);
  await assert.rejects(() => readPreflightProtectedFile(directory, 16));
});


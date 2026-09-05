import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeAtomicPreflightSource } from '../src/preflight-source/main.js';

void test('publishes one owner-only no-overwrite source', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-source-'));
  context.after(async () => import('node:fs/promises').then(({ rm }) =>
    rm(root, { recursive: true, force: true })));
  const output = join(root, 'source.json');
  await writeAtomicPreflightSource(output, '{"source":true}');
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.equal(await readFile(output, 'utf8'), '{"source":true}');
  await assert.rejects(() => writeAtomicPreflightSource(output, '{}'));
});

void test('removes a published source when directory durability fails', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-source-fsync-'));
  context.after(async () => import('node:fs/promises').then(({ rm }) =>
    rm(root, { recursive: true, force: true })));
  const output = join(root, 'source.json');
  await assert.rejects(() => writeAtomicPreflightSource(output, '{}', async () => {
    throw new Error('durability failure');
  }));
  await assert.rejects(() => stat(output), { code: 'ENOENT' });
});

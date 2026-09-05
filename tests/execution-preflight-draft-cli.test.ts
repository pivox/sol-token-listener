import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readProtectedDraftInput, writeAtomicDraft } from '../src/preflight-draft/main.js';

void test('reads protected inputs and publishes a mode 0600 no-overwrite draft', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-draft-'));
  context.after(async () => import('node:fs/promises').then(({ rm }) =>
    rm(root, { recursive: true, force: true })));
  const input = join(root, 'source.json');
  const output = join(root, 'draft.json');
  await writeFile(input, '{}', { mode: 0o600 });
  assert.equal(await readProtectedDraftInput(input, 16), '{}');
  await writeAtomicDraft(output, '{"draft":true}');
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.equal(await readFile(output, 'utf8'), '{"draft":true}');
  await assert.rejects(() => writeAtomicDraft(output, '{}'));
  await chmod(input, 0o644);
  await assert.rejects(() => readProtectedDraftInput(input, 16));
});

void test('removes a published draft when parent durability fails', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-draft-fsync-'));
  context.after(async () => import('node:fs/promises').then(({ rm }) =>
    rm(root, { recursive: true, force: true })));
  const output = join(root, 'draft.json');
  await assert.rejects(() => writeAtomicDraft(output, '{}', async () => {
    throw new Error('durability failure');
  }));
  await assert.rejects(() => stat(output), { code: 'ENOENT' });
});

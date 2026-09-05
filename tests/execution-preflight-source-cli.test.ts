import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  runExecutionPreflightSourceCommand,
  writeAtomicPreflightSource,
} from '../src/preflight-source/main.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

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

void test('closes PostgreSQL successfully before publishing any source', async () => {
  const source = preflightDraftInputs().source;
  const calls: string[] = [];
  const database = Object.freeze({
    repository: Object.freeze({ export: async () => { calls.push('export'); return source; } }),
    evict: () => { calls.push('evict'); },
    close: async () => { calls.push('close'); },
  });
  const manifest = await runExecutionPreflightSourceCommand(database,
    { generationId: source.generation.generationId,
      targetIntentId: source.target.intent.id,
      simulationArtifactId: source.simulation.artifactId }, '/outside/source.json',
    async () => { calls.push('publish'); });
  assert.deepEqual(calls, ['export', 'evict', 'close', 'publish']);
  assert.equal(JSON.parse(manifest).state, 'PREFLIGHT_SOURCE_EXPORTED');

  let publications = 0;
  await assert.rejects(runExecutionPreflightSourceCommand(Object.freeze({ ...database,
    close: async () => { throw new Error('close failed'); },
  }), { generationId: source.generation.generationId,
    targetIntentId: source.target.intent.id,
    simulationArtifactId: source.simulation.artifactId }, '/outside/source.json',
  async () => { publications += 1; }));
  assert.equal(publications, 0);
});

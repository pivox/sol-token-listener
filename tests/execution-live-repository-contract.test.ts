import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const portUrl = new URL('../src/ports/execution-live-repository.ts', import.meta.url);
const h1ProductionModuleUrls = Object.freeze([
  new URL('../src/ports/execution-intent-repository.ts', import.meta.url),
  portUrl,
  new URL('../src/storage/execution-intent.repository.ts', import.meta.url),
  new URL('../src/storage/execution-live.repository.ts', import.meta.url),
]);

void test('live repository port exposes only closed durable lifecycle commands', async () => {
  const source = await readFile(portUrl, 'utf8');
  for (const method of [
    'persistSigned',
    'inspectSignedTransaction',
    'authenticatePersistedSignedTransaction',
    'recordSignedSimulation',
    'revokeBeforeSubmission',
    'beginSubmission',
    'recordSubmissionOutcome',
    'recordConfirmation',
    'readConfirmationWork',
    'commitReconciliation',
    'readReconciliationWork',
    'createDeadlineExitIntent',
  ]) assert.match(source, new RegExp(`readonly ${method}:|${method}\\(`, 'u'));
  for (const contract of [
    'ExecutionLiveConfirmationWorkV1',
    'ExecutionLiveReconciliationWorkV1',
  ]) assert.match(source, new RegExp(`interface ${contract}\\b`, 'u'));
  assert.doesNotMatch(
    source,
    /Keypair|sendRawTransaction|sendTransaction|Connection|PRIVATE|SECRET/u,
  );
  assert.doesNotMatch(source, /\bany\b/u);
});

void test('H1 durable modules import no RPC, keypair, signer, or submission gateway', async () => {
  const sources = await Promise.all(h1ProductionModuleUrls.map((url) => readFile(url, 'utf8')));
  const prohibitedImport = /from\s+['"][^'"]*(?:solana\/rpc|keypair|execution-transaction-signer|executor-live\/submission-gateway)[^'"]*['"]/iu;

  for (const source of sources) assert.doesNotMatch(source, prohibitedImport);
});

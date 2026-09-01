import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const portUrl = new URL('../src/ports/execution-live-repository.ts', import.meta.url);

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

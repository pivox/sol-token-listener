import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryUrl = new URL('../src/storage/execution-live.repository.ts', import.meta.url);
const portUrl = new URL('../src/ports/execution-live-repository.ts', import.meta.url);

void test('confirmation and reconciliation expose immutable artifact metadata without signed bytes', async () => {
  const port = await readFile(portUrl, 'utf8');
  assert.match(port, /type ExecutionLiveArtifactReferenceV1 = Omit<\s*SignedTransactionArtifactV1,\s*'signedTransactionBytes'\s*>/u);
  assert.match(
    port,
    /recordConfirmation\([\s\S]*?Promise<ExecutionLiveArtifactReferenceV1>/u,
  );
  assert.match(
    port,
    /ExecutionLiveReconciliationResultV1[\s\S]*?artifact: ExecutionLiveArtifactReferenceV1/u,
  );
});

void test('finality repository paths never select or materialize signed transaction bytes', async () => {
  const source = await readFile(repositoryUrl, 'utf8');
  const confirmation = section(source, 'public async recordConfirmation(', 'public async commitReconciliation(');
  const buy = section(source, 'async function applyLiveReconciliation(', 'function createEntryRecords(');
  const sell = section(source, 'async function commitSellReconciliation(', 'async function createDeadlineExitIntentLocked(');
  for (const candidate of [confirmation, buy, sell]) {
    assert.doesNotMatch(candidate, /signed_transaction_bytes/u);
    assert.doesNotMatch(candidate, /artifactFromRow\(/u);
    assert.doesNotMatch(candidate, /SELECT transaction\.\*/u);
  }
  assert.match(confirmation, /artifactReferenceFromRow\(/u);
  assert.match(buy, /artifactReferenceFromRow\(/u);
  assert.match(sell, /artifactReferenceFromRow\(/u);
});

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1);
  assert.notEqual(to, -1);
  return source.slice(from, to);
}

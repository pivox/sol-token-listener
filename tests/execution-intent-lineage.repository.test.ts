import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionIntentLineageCurrentInTransaction,
  ExecutionIntentLineageRepositoryError,
  type ExecutionIntentLineageTransactionClient,
} from '../src/storage/execution-intent-lineage.repository.js';

const INTENT_ID = `execution_intent_${'a'.repeat(64)}`;

void test('accepts exactly one current causal lineage in the caller transaction', async () => {
  const client = new ScriptedClient([{ rows: [{ lineage_current: true }], rowCount: 1 }]);

  await assertExecutionIntentLineageCurrentInTransaction(client, INTENT_ID);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0]?.values, [INTENT_ID]);
  assert.match(client.calls[0]?.text ?? '', /decision\.raw_event_id=report\.source_raw_event_id/u);
  assert.match(client.calls[0]?.text ?? '', /candidate\.superseded_at IS NULL/u);
  assert.match(client.calls[0]?.text ?? '', /report\.superseded_at IS NULL/u);
  assert.match(client.calls[0]?.text ?? '', /confirmation_status='finalized'/u);
  assert.match(client.calls[0]?.text ?? '', /#>> '\{session,candidateId\}'/u);
});

void test('fails closed for absent, stale, contradictory, or malformed lineage results', async () => {
  for (const result of [
    { rows: [{ lineage_current: false }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ lineage_current: true }, { lineage_current: true }], rowCount: 2 },
    { rows: [{ lineage_current: 'true' }], rowCount: 1 },
  ]) {
    await assert.rejects(
      assertExecutionIntentLineageCurrentInTransaction(new ScriptedClient([result]), INTENT_ID),
      (error: unknown) => error instanceof ExecutionIntentLineageRepositoryError
        && error.code === 'LINEAGE_INVALID'
        && error.message === 'Execution intent causal lineage is invalid.',
    );
  }
});

void test('rejects hostile intent identifiers before querying and redacts database failures', async () => {
  for (const value of ['', 'intent', `execution_intent_${'g'.repeat(64)}`]) {
    const client = new ScriptedClient([]);
    await assert.rejects(
      assertExecutionIntentLineageCurrentInTransaction(client, value),
      (error: unknown) => error instanceof ExecutionIntentLineageRepositoryError
        && error.code === 'INVALID_INPUT',
    );
    assert.equal(client.calls.length, 0);
  }
  const failed = new ScriptedClient([new Error('postgres secret')]);
  await assert.rejects(
    assertExecutionIntentLineageCurrentInTransaction(failed, INTENT_ID),
    (error: unknown) => error instanceof ExecutionIntentLineageRepositoryError
      && error.code === 'DATABASE_FAILURE'
      && !error.message.includes('secret'),
  );
});

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

class ScriptedClient implements ExecutionIntentLineageTransactionClient {
  public readonly calls: { readonly text: string; readonly values?: readonly unknown[] }[] = [];

  public constructor(private readonly results: readonly (QueryResult | Error)[]) {}

  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const result = this.results[this.calls.length - 1];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error('Unexpected query.');
    return result;
  }
}

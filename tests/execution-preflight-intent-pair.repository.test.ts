import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import {
  createExecutionPreflightIntentPairDraft,
  ExecutionPreflightIntentPairValidationError,
} from '../src/domain/execution-preflight-intent-pair.js';
import {
  createExecutionPreflightIntentPairInTransaction,
  ExecutionPreflightIntentPairRepositoryError,
  replayExecutionPreflightIntentPairInTransaction,
  type ExecutionPreflightIntentPairTransactionClient,
} from '../src/storage/execution-preflight-intent-pair.repository.js';

const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = 1_787_990_445_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

void test('creates an immutable pair through the caller transaction client', async () => {
  const target = targetDraft();
  const pair = createExecutionPreflightIntentPairDraft(target);
  const client = new ScriptedClient([
    result([intentRow(pair.simulationIntent)], 1),
    result([], 0),
    result([pairRow(pair)], 1),
  ]);

  const outcome = await createExecutionPreflightIntentPairInTransaction(client, target);

  assert.equal(outcome.kind, 'CREATED');
  assert.deepEqual(outcome.pair, pair);
  assert.equal(client.calls.length, 3);
  const insert = required(client.calls[2]);
  assert.match(insert.text, /^INSERT INTO execution_preflight_intent_pairs/mu);
  assert.match(insert.text, /ON CONFLICT DO NOTHING/u);
  assert.deepEqual(insert.values, [
    pair.pairId,
    pair.payloadVersion,
    pair.pairFingerprint,
    pair.targetIntentId,
    pair.simulationIntent.id,
    pair.decisionEventId,
    pair.decisionFingerprint,
    pair.expiresAtMs,
  ]);
});

void test('refuses to pair a newly created target with any pre-existing sibling', async () => {
  const target = targetDraft();
  const pair = createExecutionPreflightIntentPairDraft(target);
  const client = new ScriptedClient([
    result([], 0),
    result([], 0),
    result([intentRow(pair.simulationIntent)], 1),
    result([], 0),
    result([pairRow(pair)], 1),
  ]);

  await assert.rejects(
    createExecutionPreflightIntentPairInTransaction(client, target),
    (error: unknown) => error instanceof ExecutionPreflightIntentPairRepositoryError
      && error.code === 'PAIR_DUPLICATE',
  );
  assert.equal(client.calls.length, 3);
});

void test('rejects collisions and contradictory database results with a fixed typed error', async () => {
  const target = targetDraft();
  const pair = createExecutionPreflightIntentPairDraft(target);
  const cases = [
    new ScriptedClient([
      result([intentRow(pair.simulationIntent)], 1), result([], 0),
      result([], 0), result([], 0),
    ]),
    new ScriptedClient([
      result([intentRow(pair.simulationIntent)], 1), result([], 0),
      result([], 0),
      result([{ ...pairRow(pair), pair_fingerprint: 'b'.repeat(64) }], 1),
    ]),
    new ScriptedClient([
      result([intentRow(pair.simulationIntent)], 1), result([], 0),
      result([pairRow(pair)], 0),
    ]),
  ];

  for (const client of cases) {
    await assert.rejects(
      createExecutionPreflightIntentPairInTransaction(client, target),
      (error: unknown) => error instanceof ExecutionPreflightIntentPairRepositoryError
        && error.name === 'ExecutionPreflightIntentPairRepositoryError'
        && error.code === 'PAIR_DUPLICATE'
        && error.message === 'Execution preflight intent pair persistence failed.',
    );
  }
});

void test('rejects hostile target drafts before issuing any query', async () => {
  const target = targetDraft();
  let proxyTrapCalls = 0;
  const proxy = new Proxy(target, {
    get: () => { proxyTrapCalls += 1; throw new Error('must not run'); },
  });
  for (const hostile of [
    { ...target },
    proxy,
    Object.freeze({ ...target, pairId: 'forged' }),
  ]) {
    const client = new ScriptedClient([]);
    await assert.rejects(
      createExecutionPreflightIntentPairInTransaction(client, hostile as never),
      ExecutionPreflightIntentPairValidationError,
    );
    assert.equal(client.calls.length, 0);
  }
  assert.equal(proxyTrapCalls, 0);
});

void test('replay lookup never retro-forms an absent pair and validates an existing one', async () => {
  const target = targetDraft();
  const pair = createExecutionPreflightIntentPairDraft(target);
  const absentClient = new ScriptedClient([result([], 0)]);
  const existingClient = new ScriptedClient([result([pairRow(pair)], 1)]);

  assert.equal(
    await replayExecutionPreflightIntentPairInTransaction(absentClient, target),
    'ABSENT',
  );
  assert.equal(
    await replayExecutionPreflightIntentPairInTransaction(existingClient, target),
    'REPLAYED',
  );
  for (const client of [absentClient, existingClient]) {
    assert.equal(client.calls.length, 1);
    assert.match(required(client.calls[0]).text, /^SELECT/mu);
  }
});

function targetDraft() {
  return createExecutionIntentDraft(Object.freeze({
    strategyId: 'creation-entry-v1',
    strategyVersion: 1,
    positionId: 'paper-position-1',
    logicalCommandId: `paper_open_${'1'.repeat(64)}`,
    mint: '11111111111111111111111111111111',
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: WSOL_MINT,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 500_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1',
    decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: REQUESTED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
  }));
}

function pairRow(
  pair: ReturnType<typeof createExecutionPreflightIntentPairDraft>,
): Readonly<Record<string, unknown>> {
  return {
    pair_id: pair.pairId,
    payload_version: pair.payloadVersion,
    pair_fingerprint: pair.pairFingerprint,
    target_intent_id: pair.targetIntentId,
    simulation_intent_id: pair.simulationIntent.id,
    decision_event_id: pair.decisionEventId,
    decision_fingerprint: pair.decisionFingerprint,
    expires_at_ms: String(pair.expiresAtMs),
  };
}

function intentRow(
  intent: ReturnType<typeof createExecutionIntentDraft>,
): Readonly<Record<string, unknown>> {
  return {
    id: intent.id, payload_version: 1, logical_order_key: intent.logicalOrderKey,
    strategy_id: intent.strategyId, strategy_version: intent.strategyVersion,
    position_id: intent.positionId, logical_command_id: intent.logicalCommandId,
    mint: intent.mint, side: intent.side, venue_policy: intent.venuePolicy,
    quote_mint: intent.quoteMint, quote_token_program: intent.quoteTokenProgram,
    quote_decimals: intent.quoteDecimals, quote_amount_raw: intent.quoteAmountRaw?.toString() ?? null,
    base_amount_raw: intent.baseAmountRaw?.toString() ?? null,
    minimum_amount_out_raw: intent.minimumAmountOutRaw.toString(),
    decision_event_id: intent.decisionEventId, decision_fingerprint: intent.decisionFingerprint,
    requested_at_ms: String(intent.requestedAtMs), expires_at_ms: String(intent.expiresAtMs),
    status: 'PENDING', attempt_count: 0, state_revision: '0', last_reason_code: null,
    terminal_at_ms: null, reconciliation_completed_at_ms: null, purge_after_ms: null,
    created_at_ms: String(intent.requestedAtMs), updated_at_ms: String(intent.requestedAtMs),
    lease_owner: null, lease_token: null, lease_expires_at_ms: null,
  };
}

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

interface Call {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class ScriptedClient implements ExecutionPreflightIntentPairTransactionClient {
  public readonly calls: Call[] = [];

  public constructor(private readonly results: readonly QueryResult[]) {}

  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const next = this.results[this.calls.length - 1];
    if (next === undefined) throw new Error('Unexpected query.');
    return next;
  }
}

function result(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number | null,
): QueryResult {
  return { rows, rowCount };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value.');
  return value;
}

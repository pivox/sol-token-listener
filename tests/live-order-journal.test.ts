import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PostgresLiveOrderJournal } from '../src/live/postgres-live-order-journal.js';

void test('order intent and signed bytes are committed before submission and wallet lock is exclusive', async () => {
  const client = new FakeClient(true);
  const journal = new PostgresLiveOrderJournal({ connect: async () => client });
  const lease = await journal.acquireWalletLock('wallet-address');
  await journal.prepare({
    orderId: 'order-1', wallet: 'wallet-address', positionId: 'position-1', side: 'BUY',
    intent: { mint: 'mint-1', amountInRaw: '1000' }, validity: { slot: '500', expiresAtBlockHeight: '600' },
  });
  await journal.persistSigned('order-1', 'signature-1', Uint8Array.of(1, 2, 3));
  await journal.markSubmitted('order-1');
  assert.deepEqual(client.statements.map((entry) => entry.text.match(/INSERT INTO live_orders|UPDATE live_orders|pg_try_advisory_lock/u)?.[0]).filter(Boolean), [
    'pg_try_advisory_lock', 'INSERT INTO live_orders', 'UPDATE live_orders', 'UPDATE live_orders',
  ]);
  const signedBytes = client.statements[2]?.values?.[2] as Uint8Array | undefined;
  assert.deepEqual(signedBytes === undefined ? undefined : [...signedBytes], [1, 2, 3]);
  const competing = new PostgresLiveOrderJournal({ connect: async () => new FakeClient(false) });
  await assert.rejects(() => competing.acquireWalletLock('wallet-address'), /already has an executor/u);
  await lease.release();
  assert.equal(client.released, true);
});

void test('critical persistence failure rejects before an order can be submitted', async () => {
  const client = new FakeClient(true);
  client.failInsert = true;
  const journal = new PostgresLiveOrderJournal({ connect: async () => client });
  await assert.rejects(() => journal.prepare({
    orderId: 'order-2', wallet: 'wallet-address', positionId: 'position-2', side: 'BUY',
    intent: { mint: 'mint-2' }, validity: { slot: '700' },
  }), /journal unavailable/u);
  assert.equal(client.statements.some((entry) => entry.text.includes('UPDATE live_orders')), false);
});

void test('empty intent or validity is rejected before any database write', async () => {
  const client = new FakeClient(true);
  const journal = new PostgresLiveOrderJournal({ connect: async () => client });
  await assert.rejects(() => journal.prepare({
    orderId: 'order-empty', wallet: 'wallet-address', positionId: 'position-empty', side: 'BUY',
    intent: {}, validity: {},
  }), /intent and validity/u);
  assert.equal(client.statements.length, 0);
});

void test('journal migration defines recoverable state and is never applied by this offline test', async () => {
  const sql = await readFile(new URL('../migrations/016_live_order_journal.sql', import.meta.url), 'utf8');
  for (const token of ['PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'UNKNOWN', 'signed_transaction BYTEA', 'intent JSONB', 'validity JSONB']) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE\s+TABLE/iu);
});

void test('recovery query returns unresolved prepared, submitted, and unknown orders without converting them to failure', async () => {
  const client = new FakeClient(true);
  client.resultRows = [
    { order_id: 'o1', wallet: 'wallet-address', position_id: 'p1', side: 'BUY', status: 'SUBMITTED', signature: 's1', signed_transaction: Buffer.from([4, 5]), intent: {}, validity: {} },
    { order_id: 'o2', wallet: 'wallet-address', position_id: 'p2', side: 'SELL', status: 'UNKNOWN', signature: 's2', signed_transaction: Buffer.from([6]), intent: {}, validity: {} },
  ];
  const journal = new PostgresLiveOrderJournal({ connect: async () => client });
  const unresolved = await journal.listUnresolved('wallet-address');
  assert.deepEqual(unresolved.map((row) => row.status), ['SUBMITTED', 'UNKNOWN']);
  assert.deepEqual(unresolved[0]?.signedTransaction, Uint8Array.of(4, 5));
  assert.deepEqual(unresolved[1]?.signedTransaction, Uint8Array.of(6));
  assert.match(client.statements.at(-1)?.text ?? '', /PREPARED.*SIGNED.*SUBMITTED.*UNKNOWN/u);
});

class FakeClient {
  public readonly statements: { text: string; values?: readonly unknown[] }[] = [];
  public released = false;
  public failInsert = false;
  public resultRows: readonly Record<string, unknown>[] = [];
  public constructor(private readonly lockAvailable: boolean) {}
  public async query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.statements.push(values === undefined ? { text } : { text, values });
    if (this.failInsert && text.includes('INSERT INTO live_orders')) throw new Error('journal unavailable');
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: this.lockAvailable }] };
    if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (text.includes('SELECT order_id')) return { rows: this.resultRows };
    return { rows: text.includes('RETURNING') ? [{ order_id: String(values?.[0] ?? 'o') }] : [] };
  }
  public release(): void { this.released = true; }
}

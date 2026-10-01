import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTrustedTerminalAttribution, trustedTerminalAttribution } from '../src/domain/terminal-attribution.js';
import type { QualificationProjectionTransaction } from '../src/ports/qualification-projection-repository.js';
import { PostgresQualificationProjectionRepository, QualificationProjectionRepositoryError } from '../src/storage/qualification-projection.repository.js';

const conflict = () => Object.assign(new Error('secret'), { code: '40001' });
function fixture(options: {
  query?: (label: string, attempt: number) => void;
  connect?: () => void;
  release?: () => void;
  unlock?: boolean;
  wait?: () => void;
} = {}) {
  const trace: string[] = [];
  const waits: number[] = [];
  let connections = 0;
  const repository = new PostgresQualificationProjectionRepository({
    async connect() {
      const attempt = ++connections;
      trace.push(`${attempt}:connect`);
      options.connect?.();
      return {
        async query(sql: string) {
          const label = sql.includes('pg_advisory_unlock') ? 'unlock'
            : sql.includes('pg_advisory_lock') ? 'lock'
              : sql.startsWith('BEGIN') ? 'BEGIN'
                : sql.includes('qualification_launch') ? 'load' : sql;
          trace.push(`${attempt}:${label}`);
          options.query?.(label, attempt);
          return { rows: label === 'unlock' ? [{ pg_advisory_unlock: options.unlock ?? true }] : [], rowCount: 0 };
        },
        release() { trace.push(`${attempt}:release`); options.release?.(); },
      };
    },
  }, { reauthorize: () => undefined }, async (delay: number) => {
    waits.push(delay);
    trace.push(`wait:${delay}`);
    options.wait?.();
  });
  return { repository, trace, waits, connections: () => connections };
}

for (const boundary of ['load', 'COMMIT']) {
  void test(`recovers actual ${boundary} serialization after complete cleanup`, async () => {
    const f = fixture({ query(label, attempt) { if (label === boundary && attempt === 1) throw conflict(); } });
    const transactions: QualificationProjectionTransaction[] = [];
    const result = await f.repository.transact('mint', async (tx) => {
      transactions.push(tx);
      await tx.loadCanonicalInput('mint');
      return 'rebuilt';
    }, 'bounded-serialization');
    assert.equal(result, 'rebuilt');
    assert.equal(transactions.length, 2);
    assert.notEqual(transactions[0], transactions[1]);
    assert.deepEqual(f.waits, [10]);
    assert.deepEqual(f.trace, [
      '1:connect', '1:lock', '1:BEGIN', '1:load', ...(boundary === 'COMMIT' ? ['1:COMMIT'] : []),
      '1:ROLLBACK', '1:unlock', '1:release', 'wait:10',
      '2:connect', '2:lock', '2:BEGIN', '2:load', '2:COMMIT', '2:unlock', '2:release',
    ]);
  });
}

void test('persistent serialization stops after three attempts', async () => {
  const f = fixture({ query(label) { if (label === 'load') throw conflict(); } });
  await assert.rejects(f.repository.transact('mint', (tx) => tx.loadCanonicalInput('mint'), 'bounded-serialization'), (error: unknown) => {
    assertRedacted(error, 'QUALIFICATION_POSTGRES_SERIALIZATION'); return true;
  });
  assert.equal(f.connections(), 3);
  assert.deepEqual(f.waits, [10, 20]);
});

const negatives = [
  'default', 'none', 'callback-code', 'forged-diagnostic', 'inherited', 'getter', 'proxy', 'revoked',
  'deadlock', 'connect', 'lock', 'BEGIN', 'unknown-COMMIT', 'cleanup-unlock', 'cleanup-false',
  'cleanup-release', 'conflict-ROLLBACK', 'conflict-unlock', 'conflict-false', 'conflict-release', 'wait',
] as const;
for (const kind of negatives) {
  void test(`does not replay unsafe ${kind} failure`, async () => {
    let hostileReads = 0;
    const primary = conflict();
    if (kind === 'forged-diagnostic') registerTrustedTerminalAttribution(primary, {
      version: 1, diagnosticCode: 'QUALIFICATION_POSTGRES_SERIALIZATION', causeKind: null, pumpWire: null,
    });
    const f = fixture({
      connect() { if (kind === 'connect') throw primary; },
      query(label) {
        if (kind === label || (kind === 'unknown-COMMIT' && label === 'COMMIT')) {
          throw kind === 'unknown-COMMIT' ? new Error('secret') : primary;
        }
        if (label === 'load') {
          if (kind === 'inherited') {
            throw Object.create({ code: '40001' });
          }
          if (kind === 'getter') {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an arbitrary driver rejection.
            throw Object.defineProperty({}, 'code', { get() { hostileReads++; return '40001'; } });
          }
          if (kind === 'proxy') throw new Proxy(primary, { getOwnPropertyDescriptor() { hostileReads++; throw new Error('secret'); } });
          if (kind === 'revoked') { const p = Proxy.revocable(primary, {}); p.revoke(); throw p.proxy; }
          if (kind === 'deadlock') throw Object.assign(new Error('secret'), { code: '40P01' });
          if (kind === 'default' || kind === 'none' || kind.startsWith('conflict-') || kind === 'wait') throw primary;
        }
        if (kind.endsWith(`-${label}`)) throw conflict();
      },
      unlock: !kind.endsWith('-false'),
      release() { if (kind.endsWith('-release')) throw conflict(); },
      wait() { if (kind === 'wait') throw new Error('secret wait'); },
    });
    await assert.rejects(f.repository.transact('mint', async (tx) => {
      if (kind === 'callback-code' || kind === 'forged-diagnostic') throw primary;
      return tx.loadCanonicalInput('mint');
    }, kind === 'default' ? undefined : kind === 'none' ? 'none' : 'bounded-serialization'), (error: unknown) => {
      const expected = kind === 'connect' ? 'QUALIFICATION_CONNECT_FAILED'
        : kind.startsWith('cleanup-') ? 'QUALIFICATION_CLEANUP_FAILED'
          : kind === 'deadlock' ? 'QUALIFICATION_POSTGRES_DEADLOCK'
            : ['callback-code', 'inherited', 'getter', 'proxy', 'revoked', 'unknown-COMMIT'].includes(kind)
              ? 'QUALIFICATION_PERSISTENCE_UNKNOWN' : 'QUALIFICATION_POSTGRES_SERIALIZATION';
      assertRedacted(error, expected); return true;
    });
    assert.equal(f.connections(), 1);
    assert.deepEqual(f.waits, kind === 'wait' ? [10] : []);
    assert.equal(hostileReads, 0);
  });
}

void test('rejects invalid replay policy before connecting', async () => {
  const f = fixture();
  await assert.rejects(f.repository.transact('mint', async () => undefined,
    'invalid' as 'none'), /replay policy is invalid/u);
  assert.equal(f.connections(), 0);
});

void test('a query error from a previous attempt cannot authorize a later callback replay', async () => {
  const primary = conflict();
  const f = fixture({ query(label, attempt) { if (label === 'load' && attempt === 1) throw primary; } });
  let callbacks = 0;
  await assert.rejects(f.repository.transact('mint', async (tx) => {
    if (++callbacks === 2) throw primary;
    return tx.loadCanonicalInput('mint');
  }, 'bounded-serialization'));
  assert.equal(f.connections(), 2);
  assert.deepEqual(f.waits, [10]);
});

function assertRedacted(error: unknown, diagnostic: string): void {
  assert.ok(error instanceof QualificationProjectionRepositoryError);
  assert.equal(trustedTerminalAttribution(error)?.diagnosticCode, diagnostic);
  assert.doesNotMatch(JSON.stringify(error), /secret/u);
  if (error.cause instanceof AggregateError) {
    for (const nested of error.cause.errors as Error[]) assert.doesNotMatch(nested.message, /secret/u);
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTrustedTerminalAttribution, trustedTerminalAttribution } from '../src/domain/terminal-attribution.js';
import { trustedObservedPipelineOrigin } from '../src/domain/observed-pipeline-failure.js';
import {
  PostgresQualificationProjectionRepository,
  QualificationProjectionDataError,
  QualificationProjectionRepositoryError,
} from '../src/storage/qualification-projection.repository.js';

function fixture(options: {
  connect?: () => void;
  query?: (sql: string) => void;
  release?: () => void;
  unlock?: boolean;
} = {}) {
  const calls: string[] = [];
  const repository = new PostgresQualificationProjectionRepository({
    async connect() {
      options.connect?.();
      return {
        async query(sql: string) {
          calls.push(sql);
          options.query?.(sql);
          return { rows: sql.includes('pg_advisory_unlock')
            ? [{ pg_advisory_unlock: options.unlock ?? true }] : [], rowCount: 0 };
        },
        release() { calls.push('release'); options.release?.(); },
      };
    },
  }, { reauthorize: () => undefined });
  return { repository, calls };
}

function diagnostic(error: unknown, code: string): void {
  assert.deepEqual(trustedTerminalAttribution(error), {
    version: 1, diagnosticCode: code, causeKind: null, pumpWire: null,
  });
  assert.equal(trustedObservedPipelineOrigin(error), null);
}

void test('connect failure retains redaction and fixed attribution', async () => {
  const { repository, calls } = fixture({ connect() { throw new Error('secret'); } });
  await assert.rejects(repository.transact('mint', async () => undefined), (error: unknown) => {
    assert.ok(error instanceof QualificationProjectionRepositoryError);
    assert.equal(error.cause, undefined);
    diagnostic(error, 'QUALIFICATION_CONNECT_FAILED');
    return true;
  });
  assert.deepEqual(calls, []);
});

for (const [sqlstate, expected] of [
  ['40001', 'QUALIFICATION_POSTGRES_SERIALIZATION'],
  ['40P01', 'QUALIFICATION_POSTGRES_DEADLOCK'],
  ['XX000', 'QUALIFICATION_PERSISTENCE_UNKNOWN'],
] as const) {
  void test(`actual query ${sqlstate} is attributed through redaction`, async () => {
    const { repository, calls } = fixture({ query(sql) {
      if (sql.includes('qualification_launch')) throw Object.assign(new Error('secret'), { code: sqlstate });
    } });
    await assert.rejects(repository.transact('mint', (tx) => tx.loadCanonicalInput('mint')), (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 1);
      assert.doesNotMatch(JSON.stringify(error), /secret/u);
      diagnostic(error, expected);
      return true;
    });
    assert.equal(calls.at(-3), 'ROLLBACK');
    assert.match(calls.at(-2) ?? '', /pg_advisory_unlock/u);
    assert.equal(calls.at(-1), 'release');
  });
}

void test('callback SQLSTATE spoof is only persistence unknown', async () => {
  const { repository } = fixture();
  await assert.rejects(repository.transact('mint', async () => {
    throw Object.assign(new Error('secret'), { code: '40001' });
  }), (error: unknown) => { diagnostic(error, 'QUALIFICATION_PERSISTENCE_UNKNOWN'); return true; });
});

for (const primary of [new TypeError('secret'), new RangeError('secret'), new QualificationProjectionDataError()]) {
  void test(`${primary.name} preserves invalid-data outcome and provenance`, async () => {
    const { repository } = fixture();
    await assert.rejects(repository.transact('mint', async () => { throw primary; }), (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      if (primary instanceof QualificationProjectionDataError) assert.equal(error, primary);
      diagnostic(error, 'QUALIFICATION_DATA_INVALID');
      return true;
    });
  });
}

void test('repository invalid locked-mint outcome is attributed', async () => {
  const { repository } = fixture();
  await assert.rejects(repository.transact('mint', (tx) => tx.loadCanonicalInput('other')), (error: unknown) => {
    assert.ok(error instanceof QualificationProjectionDataError);
    diagnostic(error, 'QUALIFICATION_DATA_INVALID');
    return true;
  });
});

for (const hostileKind of ['getter', 'proxy', 'revoked', 'inherited'] as const) {
  void test(`query ${hostileKind} cannot supply SQLSTATE or interrupt cleanup`, async () => {
    let reads = 0;
    let hostile: unknown;
    if (hostileKind === 'getter') hostile = Object.defineProperty({}, 'code', { get() { reads++; throw new Error('secret'); } });
    else if (hostileKind === 'proxy') hostile = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('secret'); }, getOwnPropertyDescriptor() { reads++; throw new Error('secret'); } });
    else if (hostileKind === 'revoked') { const proxy = Proxy.revocable({}, {}); proxy.revoke(); hostile = proxy.proxy; }
    else hostile = Object.create({ code: '40001' });
    const { repository, calls } = fixture({ query(sql) { if (sql.includes('qualification_launch')) throw hostile; } });
    await assert.rejects(repository.transact('mint', (tx) => tx.loadCanonicalInput('mint')), (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      diagnostic(error, 'QUALIFICATION_PERSISTENCE_UNKNOWN'); return true;
    });
    assert.equal(reads, 0);
    assert.equal(calls.at(-1), 'release');
  });
}

void test('specific trusted primary survives all cleanup failures and aggregation', async () => {
  const primary = new Error('secret');
  registerTrustedTerminalAttribution(primary, { version: 1, diagnosticCode: 'QUALIFICATION_LAUNCH_MISSING', causeKind: null, pumpWire: null });
  const { repository } = fixture({
    query(sql) { if (sql === 'ROLLBACK' || sql.includes('pg_advisory_unlock')) throw Object.assign(new Error('secret'), { code: '40P01' }); },
    release() { throw new Error('secret'); },
  });
  await assert.rejects(repository.transact('mint', async () => { throw primary; }), (error: unknown) => {
    assert.ok(error instanceof QualificationProjectionRepositoryError);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 4);
    diagnostic(error, 'QUALIFICATION_LAUNCH_MISSING'); return true;
  });
});

void test('unknown primary wins over cleanup SQLSTATE', async () => {
  const { repository } = fixture({ query(sql) { if (sql === 'ROLLBACK') throw Object.assign(new Error('secret'), { code: '40001' }); } });
  await assert.rejects(repository.transact('mint', async () => { throw new Error('secret'); }), (error: unknown) => {
    diagnostic(error, 'QUALIFICATION_PERSISTENCE_UNKNOWN'); return true;
  });
});

for (const cleanup of ['unlock', 'false-unlock', 'release'] as const) {
  void test(`cleanup-only ${cleanup} has distinct attribution`, async () => {
    const { repository } = fixture({
      unlock: cleanup !== 'false-unlock',
      query(sql) { if (cleanup === 'unlock' && sql.includes('pg_advisory_unlock')) throw Object.assign(new Error('secret'), { code: '40001' }); },
      release() { if (cleanup === 'release') throw new Error('secret'); },
    });
    await assert.rejects(repository.transact('mint', async () => undefined), (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      diagnostic(error, 'QUALIFICATION_CLEANUP_FAILED'); return true;
    });
  });
}

for (const primary of [undefined, null, 'secret', 1]) {
  void test(`primitive primary ${String(primary)} is not mistaken for cleanup-only`, async () => {
    const { repository } = fixture({ release() { throw new Error('secret'); } });
    await assert.rejects(repository.transact('mint', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise arbitrary callback rejections.
      throw primary;
    }), (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      diagnostic(error, 'QUALIFICATION_PERSISTENCE_UNKNOWN'); return true;
    });
  });
}

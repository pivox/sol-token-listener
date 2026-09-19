import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import type pg from 'pg';
import { waitForBackendDrain } from './helpers/postgres-backend-drain.js';

const DRAIN_DELAY_MS = 100;
const DRAIN_TIMEOUT_MS = 5_000;

void test('waits until every backend for the isolated database has closed', async () => {
  const counts = ['1', '0'];
  const queryCalls: DrainQuery[] = [];
  const delays: number[] = [];
  let now = 0;
  const maintenance = Object.freeze({
    async query(query: DrainQuery) {
      queryCalls.push(query);
      return Object.freeze({ rows: Object.freeze([{ count: counts.shift() ?? '0' }]) });
    },
  }) as unknown as Pick<InstanceType<typeof pg.Pool>, 'query'>;

  await waitForBackendDrain(maintenance, 'isolated_database', {
    now: () => now,
    wait: async (delayMs) => { delays.push(delayMs); now += delayMs; },
  });

  assert.equal(queryCalls.length, 2);
  assert.deepEqual(queryCalls[0]?.values, ['isolated_database']);
  assert.match(queryCalls[0]?.text ?? '', /pg_stat_activity/u);
  assert.equal(queryCalls[0]?.query_timeout, DRAIN_TIMEOUT_MS);
  assert.deepEqual(delays, [DRAIN_DELAY_MS]);
});

void test('bounds backend draining before destructive cleanup', async () => {
  let queryCount = 0;
  let delayCount = 0;
  let now = 0;
  const maintenance = Object.freeze({
    async query(query: DrainQuery) {
      queryCount += 1;
      assert.equal(query.query_timeout, DRAIN_TIMEOUT_MS - now);
      return Object.freeze({ rows: Object.freeze([{ count: '1' }]) });
    },
  }) as unknown as Pick<InstanceType<typeof pg.Pool>, 'query'>;

  await assert.rejects(
    waitForBackendDrain(maintenance, 'isolated_database', {
      now: () => now,
      wait: async (delayMs) => { delayCount += 1; now += delayMs; },
    }),
    /Database backends did not close before forced teardown/u,
  );
  assert.equal(queryCount, DRAIN_TIMEOUT_MS / DRAIN_DELAY_MS);
  assert.equal(delayCount, queryCount);
});

type DrainQuery = pg.QueryConfig & Readonly<{ query_timeout: number }>;

void test('gates live-recovery forced cleanup behind the backend drain barrier', async () => {
  const source = await readFile(
    new URL('./execution-live.repository.test.ts', import.meta.url),
    'utf8',
  );
  const testStart = source.indexOf(
    "void test('PostgreSQL 16 recovery authority commits finality and creates a deadline SELL'",
  );
  assert.notEqual(testStart, -1);
  const testEnd = source.indexOf('\n  });\n\nasync function liveFixture', testStart);
  assert.notEqual(testEnd, -1);
  const body = source.slice(testStart, testEnd);
  const close = body.indexOf('await recoveryDatabase.close()');
  const isolatedEnd = body.indexOf('await isolated.end()');
  const drain = body.indexOf('await waitForBackendDrain(maintenance, databaseName)');
  const terminate = body.indexOf('SELECT pg_terminate_backend(pid)');
  const terminationAssertion = body.indexOf('assert.equal(terminated.rowCount, 0)');
  const dropDatabase = body.indexOf('DROP DATABASE IF EXISTS');
  const dropRole = body.indexOf('DROP ROLE IF EXISTS');
  assert.ok(
    close >= 0
      && isolatedEnd > close
      && drain > isolatedEnd
      && terminate > drain
      && terminationAssertion > terminate
      && dropDatabase > terminationAssertion
      && dropRole > dropDatabase,
  );
});

void test('gates listener-authority forced cleanup behind the backend drain barrier', async () => {
  const source = await readFile(
    new URL('./listener-database-authority.test.ts', import.meta.url),
    'utf8',
  );
  const testStart = source.indexOf(
    "void test('PostgreSQL 16 listener login can write business projections but no live state'",
  );
  assert.notEqual(testStart, -1);
  const testEnd = source.indexOf('\n  });\n\nfunction quoteIdentifier', testStart);
  assert.notEqual(testEnd, -1);
  const body = source.slice(testStart, testEnd);
  const listenerEnd = body.indexOf('await listener.end()');
  const isolatedEnd = body.indexOf('await isolated.end()');
  const drain = body.indexOf('await waitForBackendDrain(maintenance, databaseName)');
  const terminate = body.indexOf('SELECT pg_terminate_backend(pid)');
  const terminationAssertion = body.indexOf('assert.equal(terminated.rowCount, 0)');
  const dropDatabase = body.indexOf('DROP DATABASE IF EXISTS');
  const dropRole = body.indexOf('DROP ROLE IF EXISTS');
  assert.ok(
    listenerEnd >= 0
      && isolatedEnd > listenerEnd
      && drain > isolatedEnd
      && terminate > drain
      && terminationAssertion > terminate
      && dropDatabase > terminationAssertion
      && dropRole > dropDatabase,
  );
});

void test('guards every datname-scoped destructive database cleanup', async () => {
  const testsUrl = new URL('./', import.meta.url);
  const entries = (await readdir(testsUrl, { recursive: true }))
    .filter((entry) => entry.endsWith('.ts'))
    .sort();
  const cleanupCounts = new Map<string, number>();
  const violations: string[] = [];
  const terminationPattern = /SELECT pg_terminate_backend\(pid\)[\s\S]{0,160}?WHERE datname=\$1 AND pid<>pg_backend_pid\(\)/gu;
  for (const entry of entries) {
    const source = await readFile(new URL(entry, testsUrl), 'utf8');
    for (const match of source.matchAll(terminationPattern)) {
      const terminate = match.index;
      cleanupCounts.set(entry, (cleanupCounts.get(entry) ?? 0) + 1);
      const precedingDrop = source.lastIndexOf('DROP DATABASE IF EXISTS', terminate);
      const drain = source.lastIndexOf(
        'await waitForBackendDrain(maintenance, databaseName)',
        terminate,
      );
      const close = Math.max(
        source.lastIndexOf('.end()', drain),
        source.lastIndexOf('.close()', drain),
      );
      const capture = source.lastIndexOf('const terminated = await maintenance.query(', terminate);
      const assertion = source.indexOf('assert.equal(terminated.rowCount, 0)', terminate);
      const drop = source.indexOf('DROP DATABASE IF EXISTS', terminate);
      if (!(drain > precedingDrop
        && close > precedingDrop
        && close < drain
        && capture > drain
        && assertion > terminate
        && drop > assertion)) {
        violations.push(`${entry}:${source.slice(0, terminate).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(Object.fromEntries(cleanupCounts), {
    'execution-live.repository.test.ts': 1,
    'execution-worker-live-partition-migration.test.ts': 3,
    'executor-main.integration.test.ts': 1,
    'executor-roles-provisioning.test.ts': 2,
    'executor-worker-database-authority.test.ts': 2,
    'listener-database-authority.test.ts': 1,
  });
  assert.deepEqual(violations, []);
});

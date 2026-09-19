import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

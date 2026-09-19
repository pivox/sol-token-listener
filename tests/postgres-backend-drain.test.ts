import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import type pg from 'pg';
import ts from 'typescript';
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

void test('inventories every destructive database cleanup and guards forced termination', async () => {
  const testsUrl = new URL('./', import.meta.url);
  const violations: string[] = [];
  const cleanupCounts: Record<string, number> = {};
  const entries = (await readdir(testsUrl, { recursive: true }))
    .filter((entry) => entry.endsWith('.ts'))
    .sort();
  for (const entry of entries) {
    const source = await readFile(new URL(entry, testsUrl), 'utf8');
    const sourceFile = ts.createSourceFile(
      entry,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const drops = sqlQueriesMatching(sourceFile, DROP_DATABASE_SQL)
      .map((query) => query.arguments[0])
      .filter((argument): argument is ts.Expression => argument !== undefined);
    if (drops.length === 0) continue;
    cleanupCounts[entry] = drops.length;
    for (const drop of drops) {
      const guarded = entry in FORCED_DATABASE_CLEANUPS
        ? hasGuardedCleanupOrder(sourceFile, drop)
        : entry in GRACEFUL_DATABASE_CLEANUPS
          ? hasGracefulCleanupOrder(sourceFile, drop)
          : false;
      if (!guarded) {
        const line = sourceFile.getLineAndCharacterOfPosition(drop.getStart(sourceFile)).line + 1;
        violations.push(`${entry}:${line}`);
      }
    }
  }
  assert.deepEqual(cleanupCounts, {
    'execution-live.repository.test.ts': 1,
    'execution-preflight-source-database.test.ts': 1,
    'execution-worker-live-partition-migration.test.ts': 3,
    'executor-main.integration.test.ts': 1,
    'executor-readiness-database.test.ts': 1,
    'executor-roles-provisioning.test.ts': 2,
    'executor-worker-database-authority.test.ts': 2,
    'listener-database-authority.test.ts': 1,
  });
  assert.deepEqual(violations, []);
});

const FORCED_DATABASE_CLEANUPS = Object.freeze({
  'execution-live.repository.test.ts': 1,
  'execution-worker-live-partition-migration.test.ts': 3,
  'executor-main.integration.test.ts': 1,
  'executor-roles-provisioning.test.ts': 2,
  'executor-worker-database-authority.test.ts': 2,
  'listener-database-authority.test.ts': 1,
});

const GRACEFUL_DATABASE_CLEANUPS = Object.freeze({
  'execution-preflight-source-database.test.ts': 1,
  'executor-readiness-database.test.ts': 1,
});

const DROP_DATABASE_SQL = /\bdrop\s+database\s+if\s+exists\b/iu;
const TERMINATE_DATABASE_SQL = /\bselect\s+pg_terminate_backend\s*\(\s*pid\s*\)[\s\S]*?\bwhere\s+datname\s*=\s*\$1\b[\s\S]*?\bpid\s*<>\s*pg_backend_pid\s*\(\s*\)/iu;

function sqlQueriesMatching(sourceFile: ts.SourceFile, pattern: RegExp): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'query'
      && node.arguments[0] !== undefined
      && pattern.test(node.arguments[0].getText(sourceFile))) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function hasGracefulCleanupOrder(sourceFile: ts.SourceFile, drop: ts.Expression): boolean {
  const dropFunction = nearestFunction(drop);
  if (dropFunction === null) return false;
  const closes = awaitedCalls(dropFunction, ['close', 'end'], sourceFile);
  const close = closes.filter((node) => node.getStart(sourceFile) < drop.getStart(sourceFile)).at(-1);
  return close !== undefined
    && firstSqlQuery(dropFunction, sourceFile, TERMINATE_DATABASE_SQL) === null;
}

function hasGuardedCleanupOrder(sourceFile: ts.SourceFile, drop: ts.Expression): boolean {
  const dropFunction = nearestFunction(drop);
  if (dropFunction === null) return false;
  const cleanupScope = nearestCleanupScope(drop, dropFunction, sourceFile);
  const terminate = firstSqlQuery(dropFunction, sourceFile, TERMINATE_DATABASE_SQL);
  if (terminate === null || !ts.isAwaitExpression(terminate.parent)) return false;
  const declaration = terminate.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const assertion = zeroRowAssertion(dropFunction, declaration.name.text, sourceFile);
  if (assertion === null) return false;
  const closes = awaitedCalls(cleanupScope, ['close', 'end'], sourceFile);
  const drains = awaitedCalls(cleanupScope, ['waitForBackendDrain'], sourceFile);
  const close = closes.filter((node) => node.getStart(sourceFile) < drop.getStart(sourceFile)).at(-1);
  const drain = drains.filter((node) => node.getStart(sourceFile) < drop.getStart(sourceFile)).at(-1);
  return close !== undefined
    && drain !== undefined
    && close.getStart(sourceFile) < drain.getStart(sourceFile)
    && drain.getStart(sourceFile) < terminate.getStart(sourceFile)
    && terminate.getStart(sourceFile) < assertion.getStart(sourceFile)
    && assertion.getStart(sourceFile) < drop.getStart(sourceFile);
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isExecutableFunction(current)) return current;
    current = current.parent;
  }
  return null;
}

function isExecutableFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function nearestCleanupScope(
  node: ts.Node,
  fallback: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isCallExpression(current)
      && current.expression.getText(sourceFile) === 'collectCleanupFailures') return current;
    current = current.parent;
  }
  return fallback;
}

function firstSqlQuery(
  scope: ts.Node,
  sourceFile: ts.SourceFile,
  pattern: RegExp,
): ts.CallExpression | null {
  let match: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (match !== null) return;
    if (ts.isCallExpression(node)) {
      const sql = node.arguments[0];
      if (sql !== undefined && pattern.test(sql.getText(sourceFile))) {
        match = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return match;
}

function zeroRowAssertion(
  scope: ts.Node,
  resultName: string,
  sourceFile: ts.SourceFile,
): ts.CallExpression | null {
  let match: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (match !== null) return;
    if (ts.isCallExpression(node)
      && node.expression.getText(sourceFile).replaceAll(/\s/gu, '') === 'assert.equal'
      && node.arguments[0]?.getText(sourceFile).replaceAll(/\s/gu, '')
        === `${resultName}.rowCount`
      && node.arguments[1]?.getText(sourceFile) === '0') {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return match;
}

function awaitedCalls(
  scope: ts.Node,
  names: readonly string[],
  sourceFile: ts.SourceFile,
): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isAwaitExpression(node.parent)) {
      const expression = node.expression;
      const name = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.getText(sourceFile);
      if (names.includes(name)) matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return matches.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
}

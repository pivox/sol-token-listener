import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresPaperDecisionRepository } from '../src/storage/paper-decision.repository.js';

const QUALIFICATION_PROFILE = Object.freeze({
  id: 'pumpfun-v1-initial',
  version: 1,
  fingerprint: 'c'.repeat(64),
});

void test('acquires the relation-scoped scheduler lock before the claim statement snapshot', async () => {
  const statements: string[] = [];
  const client = Object.freeze({
    async query(text: string) {
      statements.push(text);
      return Object.freeze({ rows: Object.freeze([]), rowCount: 0 });
    },
    release() {},
  });
  const pool = Object.freeze({
    async connect() { return client; },
  }) as ConstructorParameters<typeof PostgresPaperDecisionRepository>[0];
  const repository = new PostgresPaperDecisionRepository(
    pool,
    {},
    QUALIFICATION_PROFILE,
  );

  assert.equal(await repository.claim({ nowMs: 100_000, leaseMs: 10_000 }), null);
  assert.equal(statements.length, 4);
  assert.equal(statements[0], 'BEGIN');
  assert.match(statements[1] ?? '', /pg_advisory_xact_lock/u);
  assert.match(statements[1] ?? '', /paper-decision-claim-scheduler:v1/u);
  assert.match(statements[1] ?? '', /'paper_decision_jobs'::regclass::oid/u);
  assert.match(statements[2] ?? '', /^WITH inspection AS MATERIALIZED/u);
  assert.equal(statements[3], 'COMMIT');
});

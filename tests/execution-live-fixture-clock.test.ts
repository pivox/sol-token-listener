import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Positive qualification and quote evidence must share PostgreSQL's guard clock.
// A source contract catches host/DB skew deterministically, without timing sleeps.
for (const fixture of [
  {
    file: 'execution-live.repository.test.ts',
    name: 'exactBuyPersistenceFixture',
    clocks: ['snapshotNowMs', 'nowMs', 'quoteObservedAtMs'],
  },
  {
    file: 'execution-live-revocation.repository.test.ts',
    name: 'createBuyFixture',
    clocks: ['nowMs', 'quoteObservedAtMs'],
  },
]) {
  void test(`${fixture.name} uses the database clock for positive evidence`, async () => {
    const source = await readFile(new URL(fixture.file, import.meta.url), 'utf8');
    const start = source.indexOf(`async function ${fixture.name}(`);
    assert.notEqual(start, -1);
    const end = source.indexOf('\n}\n', start);
    assert.notEqual(end, -1);
    const body = source.slice(start, end);
    for (const clock of fixture.clocks) {
      assert.ok(body.includes(`const ${clock} = await databaseNowMs(pool);`),
        `${fixture.name}.${clock} must use PostgreSQL rather than the host clock`);
    }
    assert.match(body, /safetyQualification\(nowMs, simulation/u);
  });
}

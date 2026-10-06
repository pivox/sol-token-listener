import assert from 'node:assert/strict';

const liveMigrations = [
  '016_live_order_journal.sql',
  '017_live_positions.sql',
  '018_live_position_market_route.sql',
  '019_live_position_market_route_recovery.sql',
  '020_live_position_market_resolution.sql',
] as const;

/** Assert the migration under test and current live schema additions, without
 * assuming that the migration under test is the final migration in the repo. */
export function assertCurrentMigrationsApplied(
  applied: readonly string[],
  migrationUnderTest: string,
): void {
  assert.ok(applied.includes(migrationUnderTest), `missing migration under test: ${migrationUnderTest}`);
  for (const migration of liveMigrations) {
    assert.ok(applied.includes(migration), `missing current live migration: ${migration}`);
  }
}

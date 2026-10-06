import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({ quiet: true });
// Source readiness only; never starts a listener or a trading process.
if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ status: 'UNAVAILABLE', reason: 'DATABASE_URL_MISSING', additionalRpcRequests: 0 }));
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 750, statement_timeout: 750 });
  try {
    const result = await pool.query<{ latest_event: Date | null }>(`SELECT max(observed_at) AS latest_event
      FROM (SELECT observed_at FROM domain_events WHERE type = 'BondingCurveTradeObserved'
        UNION ALL SELECT observed_at FROM market_trades) AS observed_trades`);
    const latest = result.rows[0]?.latest_event ?? null;
    const ageMs = latest === null ? null : Date.now() - latest.getTime();
    const recent = ageMs !== null && ageMs >= 0 && ageMs <= 60000;
    console.log(JSON.stringify({ status: recent ? 'RECENT_TRADES_OBSERVED' : 'UNAVAILABLE',
      reason: recent ? null : 'NO_RECENT_INGESTED_TRADES', latestObservedAt: latest?.toISOString() ?? null,
      ageMs, additionalRpcRequests: 0, note: 'Recent trades are necessary, but do not prove complete coverage or graph availability.' }));
    if (!recent) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: 'UNAVAILABLE', reason: 'DATABASE_READ_FAILED', additionalRpcRequests: 0 }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}

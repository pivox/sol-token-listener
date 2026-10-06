import pg from 'pg';
import type { ExecutorDatabaseSource } from '../executor/database.js';
import { createExecutionPreflightSourceDatabase } from '../preflight-source/database.js';

export interface OperatorApiDatabase {
  readonly source: ExecutorDatabaseSource;
  readonly close: () => Promise<void>;
}

/**
 * One bounded connection that forces SET ROLE sol_token_operator_reader, the closed search
 * path and session_replication_role=origin on every checkout and refuses to serve when the
 * role authority drifts: the same exact-authority wrapper the preflight source export uses.
 */
export function openOperatorApiDatabase(options: Readonly<{
  databaseUrl: string;
  statementTimeoutMs: number;
  onIdleError: () => void;
}>): OperatorApiDatabase {
  const timeout = options.statementTimeoutMs;
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 1,
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
    statement_timeout: timeout,
    lock_timeout: timeout,
    idle_in_transaction_session_timeout: timeout,
  });
  pool.on('error', options.onIdleError);
  return Object.freeze({
    source: createExecutionPreflightSourceDatabase(pool).pool,
    close: () => pool.end(),
  });
}

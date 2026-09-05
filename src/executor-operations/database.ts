import pg from 'pg';
import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import { PostgresExecutionOperationsRepository } from
  '../storage/execution-operations.repository.js';

export const EXECUTION_OPERATIONS_ROLE = 'sol_token_executor_operations';

export class ExecutionOperationsDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;

  public constructor() {
    super('Execution operations database authority is invalid.');
    this.name = 'ExecutionOperationsDatabaseError';
  }
}

export interface ExecutionOperationsBootstrapDatabase {
  readonly repository: PostgresExecutionOperationsRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export interface OpenExecutionOperationsDatabaseOptions {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly onIdleError: () => void;
}

export function openExecutionOperationsDatabase(
  options: OpenExecutionOperationsDatabaseOptions,
): ExecutionOperationsBootstrapDatabase {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs,
  });
  pool.on('error', options.onIdleError);
  return createExecutionOperationsBootstrapDatabase(pool, () => pool.end());
}

export function createExecutionOperationsBootstrapDatabase(
  source: ExecutorDatabaseSource,
  closeSource: () => Promise<void>,
): ExecutionOperationsBootstrapDatabase {
  const tracked = createExecutionOperationsDatabase(source);
  const repository = new PostgresExecutionOperationsRepository(tracked.pool);
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    repository,
    close: () => {
      closePromise ??= closeSource();
      return closePromise;
    },
    evict: tracked.evictActive,
  });
}

export function createExecutionOperationsDatabase(
  source: ExecutorDatabaseSource,
): ExecutorDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try {
        client = await source.connect();
      } catch {
        throw new ExecutionOperationsDatabaseError();
      }
      try {
        await client.query(`SET ROLE ${EXECUTION_OPERATIONS_ROLE}`);
        await client.query('SET search_path = pg_catalog, public');
        const result = await client.query(
          'SELECT current_user AS current_user, session_user AS session_user, '
            + "current_setting('search_path') AS search_path, "
            + "current_setting('session_replication_role') AS session_replication_role",
        );
        const row = result.rows[0];
        const sessionUser = row?.session_user;
        if (result.rowCount !== 1 || result.rows.length !== 1
          || row?.current_user !== EXECUTION_OPERATIONS_ROLE
          || typeof sessionUser !== 'string' || sessionUser.length === 0
          || sessionUser === EXECUTION_OPERATIONS_ROLE
          || row.search_path !== 'pg_catalog, public'
          || row.session_replication_role !== 'origin') throw new Error();
      } catch {
        safeRelease(client, true);
        throw new ExecutionOperationsDatabaseError();
      }
      let released = false;
      return Object.freeze({
        query: (text: string, values?: readonly unknown[]) => client.query(text, values),
        release: (evict?: boolean): void => {
          if (released) return;
          released = true;
          client.release(evict === true);
        },
      });
    },
  }));
}

function safeRelease(client: ExecutorDatabaseClient, evict: boolean): void {
  try {
    client.release(evict);
  } catch {
    // A release failure must not replace the closed, redacted authority error.
  }
}

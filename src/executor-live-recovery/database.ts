import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import pg from 'pg';
import { PostgresExecutionIntentRepository } from '../storage/execution-intent.repository.js';
import { PostgresExecutionLiveRepository } from '../storage/execution-live.repository.js';
import {
  createExecutionLiveRecoveryIntentRepository,
  createExecutionLiveRecoveryRepository,
  type ExecutionLiveRecoveryIntentRepository,
  type ExecutionLiveRecoveryRepository,
} from '../ports/execution-live-recovery-repository.js';

export const LIVE_RECOVERY_ROLE = 'sol_token_executor_live_recovery';

export class LiveRecoveryDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;

  public constructor() {
    super('Live recovery database operation failed.');
    this.name = 'LiveRecoveryDatabaseError';
  }
}

export type LiveRecoveryDatabaseSource = ExecutorDatabaseSource;
export type LiveRecoveryDatabase = ExecutorDatabase;

export interface LiveRecoveryBootstrapDatabase {
  readonly startup: Readonly<{
    readonly query: ExecutorDatabaseClient['query'];
  }>;
  readonly intents: ExecutionLiveRecoveryIntentRepository;
  readonly live: ExecutionLiveRecoveryRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export interface OpenLiveRecoveryDatabaseOptions {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly onIdleError: () => void;
}

export function openLiveRecoveryDatabase(
  options: OpenLiveRecoveryDatabaseOptions,
): LiveRecoveryBootstrapDatabase {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs,
  });
  pool.on('error', options.onIdleError);
  return createLiveRecoveryBootstrapDatabase(pool, () => pool.end());
}

export function createLiveRecoveryBootstrapDatabase(
  source: LiveRecoveryDatabaseSource,
  closeSource: () => Promise<void>,
): LiveRecoveryBootstrapDatabase {
  const tracked = createLiveRecoveryDatabase(source);
  const intentRepository = new PostgresExecutionIntentRepository(tracked.pool);
  const liveRepository = new PostgresExecutionLiveRepository(tracked.pool);
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    startup: Object.freeze({
      query: async (text: string, values?: readonly unknown[]) => {
        const client = await tracked.pool.connect();
        let evict = true;
        try {
          const result = await client.query(text, values);
          evict = false;
          return result;
        } finally {
          client.release(evict);
        }
      },
    }),
    intents: createExecutionLiveRecoveryIntentRepository(intentRepository),
    live: createExecutionLiveRecoveryRepository(liveRepository),
    close: () => {
      closePromise ??= closeSource();
      return closePromise;
    },
    evict: tracked.evictActive,
  });
}

export function createLiveRecoveryDatabase(
  source: LiveRecoveryDatabaseSource,
): LiveRecoveryDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try {
        client = await source.connect();
      } catch {
        throw new LiveRecoveryDatabaseError();
      }
      try {
        await client.query(`SET ROLE ${LIVE_RECOVERY_ROLE}`);
        await client.query('SET search_path = pg_catalog, public');
        const result = await client.query(
          'SELECT current_user AS current_user, session_user AS session_user, '
            + "current_setting('search_path') AS search_path, "
            + "current_setting('session_replication_role') AS session_replication_role",
        );
        const row = result.rows[0];
        const currentUser = row?.current_user;
        const sessionUser = row?.session_user;
        if (result.rowCount !== 1 || result.rows.length !== 1
          || currentUser !== LIVE_RECOVERY_ROLE
          || typeof sessionUser !== 'string'
          || sessionUser === LIVE_RECOVERY_ROLE
          || row?.search_path !== 'pg_catalog, public'
          || row.session_replication_role !== 'origin') {
          throw new Error();
        }
      } catch {
        safeRelease(client, true);
        throw new LiveRecoveryDatabaseError();
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

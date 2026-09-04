import pg from 'pg';
import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import {
  createExecutionLiveRuntimeIntentRepository,
  createExecutionLiveRuntimeRepository,
  createExecutionLiveRuntimeSimulationRepository,
  createExecutionLiveRuntimeVenueRepository,
  type ExecutionLiveRuntimeIntentRepository,
  type ExecutionLiveRuntimeRepository,
  type ExecutionLiveRuntimeSimulationRepository,
  type ExecutionLiveRuntimeVenueRepository,
} from '../ports/execution-live-runtime-repository.js';
import { PostgresExecutionSimulationRepository } from
  '../storage/execution-simulation.repository.js';
import { PostgresExecutionIntentRepository } from
  '../storage/execution-intent.repository.js';
import { PostgresExecutionLiveRepository } from
  '../storage/execution-live.repository.js';
import { PostgresExecutionVenueRepository } from
  '../storage/execution-venue.repository.js';
import type { LiveExecutorConfig } from './config.js';
import {
  validateLiveExecutorStartup,
  type LiveExecutorStartupDatabase,
  type LiveExecutorStartupEvidenceV1,
} from './startup-validator.js';

export const LIVE_EXECUTOR_ROLE = 'sol_token_executor_live';

export class LiveExecutorDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;

  public constructor() {
    super('Live executor database operation failed.');
    this.name = 'LiveExecutorDatabaseError';
  }
}

export class LiveExecutorStartupValidationConsumedError extends Error {
  public readonly code = 'STARTUP_VALIDATION_CONSUMED' as const;

  public constructor() {
    super('Live executor startup validation is no longer available.');
    this.name = 'LiveExecutorStartupValidationConsumedError';
  }
}

export type LiveExecutorDatabaseSource = ExecutorDatabaseSource;
export type LiveExecutorDatabase = ExecutorDatabase;

export interface LiveExecutorBootstrapDatabase {
  readonly validateStartup: (
    config: LiveExecutorConfig,
  ) => Promise<LiveExecutorStartupEvidenceV1>;
  readonly intents: ExecutionLiveRuntimeIntentRepository;
  readonly venues: ExecutionLiveRuntimeVenueRepository;
  readonly live: ExecutionLiveRuntimeRepository;
  readonly simulations: ExecutionLiveRuntimeSimulationRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export type LiveExecutorStartupValidator = (
  database: LiveExecutorStartupDatabase,
  config: LiveExecutorConfig,
) => Promise<LiveExecutorStartupEvidenceV1>;

export interface OpenLiveExecutorDatabaseOptions {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly onIdleError: () => void;
}

export function openLiveExecutorDatabase(
  options: OpenLiveExecutorDatabaseOptions,
): LiveExecutorBootstrapDatabase {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs,
  });
  pool.on('error', options.onIdleError);
  return createLiveExecutorBootstrapDatabase(
    pool,
    () => pool.end(),
    validateLiveExecutorStartup,
  );
}

export function createLiveExecutorBootstrapDatabase(
  source: LiveExecutorDatabaseSource,
  closeSource: () => Promise<void>,
  startupValidator: LiveExecutorStartupValidator = validateLiveExecutorStartup,
): LiveExecutorBootstrapDatabase {
  const tracked = createLiveExecutorDatabase(source);
  const intentRepository = new PostgresExecutionIntentRepository(tracked.pool);
  const venueRepository = new PostgresExecutionVenueRepository(tracked.pool);
  const liveRepository = new PostgresExecutionLiveRepository(tracked.pool);
  const simulationRepository = new PostgresExecutionSimulationRepository(tracked.pool);
  let closePromise: Promise<void> | null = null;
  let startupValidationConsumed = false;
  return Object.freeze({
    validateStartup: async (config: LiveExecutorConfig) => {
      if (startupValidationConsumed) {
        throw new LiveExecutorStartupValidationConsumedError();
      }
      startupValidationConsumed = true;
      return startupValidator(createStartupDatabase(tracked.pool), config);
    },
    intents: createExecutionLiveRuntimeIntentRepository(intentRepository),
    venues: createExecutionLiveRuntimeVenueRepository(venueRepository),
    live: createExecutionLiveRuntimeRepository(liveRepository),
    simulations: createExecutionLiveRuntimeSimulationRepository(simulationRepository),
    close: () => {
      closePromise ??= closeSource();
      return closePromise;
    },
    evict: tracked.evictActive,
  });
}

export function createLiveExecutorDatabase(
  source: LiveExecutorDatabaseSource,
): LiveExecutorDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try {
        client = await source.connect();
      } catch {
        throw new LiveExecutorDatabaseError();
      }
      try {
        await client.query(`SET ROLE ${LIVE_EXECUTOR_ROLE}`);
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
          || currentUser !== LIVE_EXECUTOR_ROLE
          || typeof sessionUser !== 'string'
          || sessionUser.length === 0
          || sessionUser === LIVE_EXECUTOR_ROLE
          || row?.search_path !== 'pg_catalog, public'
          || row.session_replication_role !== 'origin') {
          throw new Error();
        }
      } catch {
        safeRelease(client, true);
        throw new LiveExecutorDatabaseError();
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

function createStartupDatabase(
  source: LiveExecutorDatabaseSource,
): LiveExecutorStartupDatabase {
  return Object.freeze({
    query: async (text: string, values?: readonly unknown[]) => {
      const client = await source.connect();
      let evict = true;
      try {
        const result = await client.query(text, values);
        evict = false;
        return result;
      } finally {
        client.release(evict);
      }
    },
  });
}

function safeRelease(client: ExecutorDatabaseClient, evict: boolean): void {
  try {
    client.release(evict);
  } catch {
    // A release failure must not replace the closed, redacted authority error.
  }
}

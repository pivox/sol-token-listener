import type pg from 'pg';

export interface ExecutorDatabaseClient {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{ readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly rowCount: number | null }>>;
  readonly release: (evict?: boolean) => void;
}

export interface ExecutorDatabaseSource {
  readonly connect: () => Promise<ExecutorDatabaseClient>;
}

export interface ExecutorDatabase {
  readonly pool: ExecutorDatabaseSource;
  readonly evictActive: () => void;
  readonly hasActiveClient: () => boolean;
}

export class ExecutorDatabaseError extends Error {
  public readonly code = 'EXECUTOR_DATABASE_BUSY' as const;

  public constructor() {
    super('Executor database operation failed.');
    this.name = 'ExecutorDatabaseError';
  }
}

export function createExecutorDatabase(
  source: ExecutorDatabaseSource | Pick<InstanceType<typeof pg.Pool>, 'connect'>,
): ExecutorDatabase {
  let connecting = false;
  let active: Readonly<{ client: ExecutorDatabaseClient; release(evict?: boolean): void }> | null = null;
  const connect = async (): Promise<ExecutorDatabaseClient> => {
    if (connecting || active !== null) throw new ExecutorDatabaseError();
    connecting = true;
    let client: ExecutorDatabaseClient;
    try {
      client = await source.connect();
    } finally {
      connecting = false;
    }
    let released = false;
    const tracked = Object.freeze({
      client,
      release: (evict?: boolean): void => {
        if (released) return;
        released = true;
        if (active === tracked) active = null;
        client.release(evict === true);
      },
    });
    active = tracked;
    return Object.freeze({
      query: (text: string, values?: readonly unknown[]) => client.query(text, values),
      release: tracked.release,
    });
  };
  const evictActive = (): void => {
    active?.release(true);
  };
  return Object.freeze({
    pool: Object.freeze({ connect }),
    evictActive,
    hasActiveClient: () => active !== null || connecting,
  });
}

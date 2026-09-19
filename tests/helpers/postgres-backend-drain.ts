import type pg from 'pg';

const BACKEND_DRAIN_DELAY_MS = 100;
const BACKEND_DRAIN_TIMEOUT_MS = 5_000;

type BackendDrainQuery = pg.QueryConfig & Readonly<{ query_timeout: number }>;

export type BackendDrainDependencies = Readonly<{
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}>;

export async function waitForBackendDrain(
  maintenance: Pick<InstanceType<typeof pg.Pool>, 'query'>,
  databaseName: string,
  dependencies: BackendDrainDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const wait = dependencies.wait ?? (async (delayMs) => new Promise<void>(
    (resolve) => { setTimeout(resolve, delayMs); },
  ));
  const deadline = now() + BACKEND_DRAIN_TIMEOUT_MS;
  for (;;) {
    const remainingMs = Math.ceil(deadline - now());
    if (remainingMs <= 0) break;
    const query: BackendDrainQuery = {
      text: `SELECT COUNT(*)::TEXT AS count FROM pg_stat_activity
        WHERE datname=$1`,
      values: [databaseName],
      query_timeout: remainingMs,
    };
    const activeCount = (await settleBeforeDeadline(
      maintenance.query<{ readonly count: string }>(query), remainingMs,
    )).rows[0]?.count;
    if (activeCount === '0') return;
    const delayMs = Math.min(BACKEND_DRAIN_DELAY_MS, Math.max(0, deadline - now()));
    if (delayMs <= 0) break;
    await wait(delayMs);
  }
  throw new Error('Database backends did not close before forced teardown.');
}

async function settleBeforeDeadline<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error('Database backend drain query exceeded its deadline.')); },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

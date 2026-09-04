import type { Pool } from 'pg';

const EXECUTOR_ROLE_TEST_LOCK = 'sol-token-listener:executor-role-tests:v1';

export async function acquireExecutorRoleTestLock(
  pool: Pool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [EXECUTOR_ROLE_TEST_LOCK],
    );
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [EXECUTOR_ROLE_TEST_LOCK],
      );
    } finally {
      client.release();
    }
  };
}

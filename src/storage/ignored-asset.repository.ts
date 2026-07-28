import type { QueryResult, QueryResultRow } from 'pg';
import { getDatabasePool } from './database.js';

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class IgnoredAssetRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async add(tokenMint: string, reason: string, source: string): Promise<void> {
    await this.database.query(
      `INSERT INTO ignored_assets(token_mint, reason, source)
       VALUES ($1,$2,$3)
       ON CONFLICT (token_mint) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source`,
      [tokenMint, reason, source],
    );
  }

  async contains(tokenMint: string): Promise<boolean> {
    const result = await this.database.query<{ readonly exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM ignored_assets WHERE token_mint = $1) AS exists',
      [tokenMint],
    );
    return result.rows[0]?.exists === true;
  }
}

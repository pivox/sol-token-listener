import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl=new URL('../migrations/015_paper_active_session_per_mint.sql',import.meta.url);

void test('defines one active paper session per mint without rewriting stored rows',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.match(sql,/DROP INDEX IF EXISTS paper_strategy_sessions_active_idx/u);
  assert.match(sql,/UNIQUE INDEX[\s\S]*paper_strategy_sessions\(mint\)/u);
  assert.match(sql,/GROUP BY mint[\s\S]*HAVING COUNT\(\*\) > 1/u);
  assert.doesNotMatch(sql,/\b(?:DELETE|UPDATE)\b/iu);
});

void test('applies migration 015 on an empty PostgreSQL schema and replays cleanly',async(context)=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  if(databaseUrl===undefined||databaseUrl.trim()===''){
    context.skip('TEST_DATABASE_URL is not configured');return;
  }
  const schema=`paper_active_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({ connectionString:databaseUrl });
  const pool=new pg.Pool({ connectionString:databaseUrl,options:`-c search_path=${schema}` });
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied=await migrateDatabase({ pool });
    assert.ok(applied.includes('015_paper_active_session_per_mint.sql'));
    assert.deepEqual(await migrateDatabase({ pool }),[]);
    const index=await pool.query<{readonly definition:string}>(`SELECT indexdef AS definition
      FROM pg_indexes WHERE schemaname=current_schema()
        AND indexname='paper_strategy_sessions_active_idx'`);
    assert.match(index.rows[0]?.definition??'',/UNIQUE INDEX[\s\S]*\(mint\)/u);
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

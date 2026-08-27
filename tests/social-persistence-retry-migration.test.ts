import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl=new URL('../migrations/014_social_persistence_retry.sql',import.meta.url);
const databaseUrl=process.env.TEST_DATABASE_URL;

void test('defines bounded social persistence retry cycles',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.match(sql,/persistence_retry_cycles/u);
  assert.match(sql,/persistence_retry_cycles BETWEEN 0 AND 2/u);
  assert.match(sql,/attempts BETWEEN 0 AND 300/u);
});

void test('applies social persistence retry migration and replays cleanly',async(context)=>{
  if(databaseUrl===undefined){
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema=`social_persist_retry_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({ connectionString:databaseUrl });
  const pool=new pg.Pool({ connectionString:databaseUrl,options:`-c search_path=${schema}` });
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied=await migrateDatabase({ pool });
    assert.equal(applied.at(-1),'020_paper_mvp_derived_pnl.sql');
    assert.deepEqual(await migrateDatabase({ pool }),[]);
    const row=await pool.query(`SELECT column_default,is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='social_enrichment_jobs'
        AND column_name='persistence_retry_cycles'`);
    assert.deepEqual(row.rows,[{ column_default:'0',is_nullable:'NO' }]);
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

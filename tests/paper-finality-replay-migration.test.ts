import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { paperFinalityRelevantRawSql } from '../src/storage/paper-finality-barrier.js';

const migrationsDirectory=new URL('../migrations/',import.meta.url);
const migrationName='028_paper_finality_replay_evidence.sql';
const migrationUrl=new URL(`../migrations/${migrationName}`,import.meta.url);
const programId='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

void test('adds replay-safe terminal receipts and bounded finality preflight indexes',async(context)=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  if(databaseUrl===undefined||databaseUrl.trim()===''){
    context.skip('TEST_DATABASE_URL absent: paper finality replay migration test skipped');
    return;
  }
  const schema=`paper_finality_replay_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:databaseUrl});
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const legacyNames=(await readdir(migrationsDirectory))
      .filter((name)=>/^(?:00[1-9]|01[0-9]|02[0-7])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left,right)=>left.localeCompare(right));
    assert.equal(legacyNames.at(-1),'027_listener_provider_affine_finality.sql');
    for(const name of legacyNames){
      await pool.query(await readFile(new URL(name,migrationsDirectory),'utf8'));
    }
    for(const version of legacyNames){
      await pool.query(`INSERT INTO migration_history(version) VALUES ($1)
        ON CONFLICT (version) DO NOTHING`,[version]);
    }
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,normalized_transaction,immutable_fingerprint,observed_at,
      processed_at,terminal_at,purge_after,finality_evidence_version
    ) VALUES ('backfilled-finalized',10,ARRAY['WEBSOCKET'],ARRAY[$1],'finalized',
      'PROCESSED','{"signature":"backfilled-finalized"}'::jsonb,$2,
      $3::timestamptz,$3::timestamptz,$3::timestamptz,
      $3::timestamptz+INTERVAL '4 hours',7),
      ('backfilled-orphaned',11,ARRAY['CATCH_UP'],ARRAY[$1],'orphaned',
      'PROCESSED','{"signature":"backfilled-orphaned"}'::jsonb,$4,
      $3::timestamptz,$3::timestamptz,$3::timestamptz,
      $3::timestamptz+INTERVAL '4 hours',8)`,[
      programId,'a'.repeat(64),new Date(1_000),
      'c'.repeat(64),
    ]);

    assert.deepEqual(await migrateDatabase({pool}),[
      migrationName,'029_paper_finality_claim_scheduler.sql','030_listener_websocket_health.sql',
      '031_execution_intents.sql', '032_execution_dry_run_assessments.sql',
      '033_execution_simulation_artifacts.sql',
      '034_execution_risk_reconciliation.sql',
      '035_execution_preflight_operations.sql',
      '036_execution_live_canary.sql',
      '037_execution_live_orchestration.sql',
      '038_execution_live_rpc_budget.sql',
    ]);
    assert.deepEqual((await pool.query(`SELECT signature,observed_slot::text AS observed_slot,
      confirmation_status,finality_evidence_version::text AS finality_evidence_version,
      immutable_fingerprint,replay_completed_at
      FROM chain_transaction_finality_replay_receipts ORDER BY signature`)).rows,[{
      signature:'backfilled-finalized',observed_slot:'10',confirmation_status:'finalized',
      finality_evidence_version:'7',immutable_fingerprint:'a'.repeat(64),
      replay_completed_at:new Date(1_000),
    },{
      signature:'backfilled-orphaned',observed_slot:'11',confirmation_status:'orphaned',
      finality_evidence_version:'8',immutable_fingerprint:'c'.repeat(64),
      replay_completed_at:new Date(1_000),
    }]);
    const sql=await readFile(migrationUrl,'utf8');
    await pool.query(sql);
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_finality_replay_receipts',
    )).rows[0]?.count,'2');
    await pool.query(`UPDATE chain_transaction_finality_replay_receipts
      SET immutable_fingerprint=$2 WHERE signature=$1`,[
      'backfilled-finalized','b'.repeat(64),
    ]);
    await assert.rejects(pool.query(sql),/terminal replay receipt conflicts/u);
    await pool.query(`UPDATE chain_transaction_finality_replay_receipts
      SET immutable_fingerprint=$2 WHERE signature=$1`,[
      'backfilled-finalized','a'.repeat(64),
    ]);
    assert.deepEqual(await migrateDatabase({pool}),[]);
    const index=(await pool.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname=CURRENT_SCHEMA()
        AND indexname='raw_chain_events_paper_finality_cursor_idx'`)).rows[0]?.indexdef;
    assert.equal(typeof index,'string');
    assert.match(index,/mint, slot, transaction_index, instruction_index.*COALESCE.*event_id/iu);
    assert.doesNotMatch(index,/\bWHERE\b/iu);
    await pool.query(`INSERT INTO raw_chain_events (
      event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload
    ) SELECT 'hostile-'||value,'pumpfun','pump','hostile-mint',
      'hostile-signature-'||value,10,value,0,
      CASE MOD(value,4) WHEN 0 THEN 'processed' WHEN 1 THEN 'orphaned'
        WHEN 2 THEN 'confirmed' ELSE 'finalized' END,$1,1,'{}'::jsonb
      FROM generate_series(1,100000) value`,[
      new Date(900),
    ]);
    await pool.query('ANALYZE raw_chain_events');
    const explained=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,COSTS OFF)
      ${paperFinalityRelevantRawSql('parameters')}`,[
      'hostile-mint','hostile-1',4_097,
    ]);
    const planNodes=collectPlanNodes(explained.rows[0]);
    const cursorNode=planNodes.find((node)=>
      node['Index Name']==='raw_chain_events_paper_finality_cursor_idx');
    assert.ok(cursorNode);
    assert.equal(typeof cursorNode['Index Cond'],'string');
    assert.match(cursorNode['Index Cond'] as string,/ROW\(slot.*<=/iu);
    assert.ok((cursorNode['Actual Rows'] as number)<=4_097);
    assert.equal(planNodes.some((node)=>node['Node Type']==='Sort'),false);
    assert.equal(planNodes.some((node)=>'Join Filter' in node),false);
    assert.equal(planNodes.some((node)=>
      node['Node Type']==='Seq Scan'&&node['Relation Name']==='raw_chain_events'),false);
    const purged=await purgeExpiredFoundationData(pool);
    assert.equal(purged.websocketHealthEvidence,0);
    assert.equal(purged.transactionInbox,2);
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_finality_replay_receipts',
    )).rows[0]?.count,'0');
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(value:string):string{
  if(!/^[a-z_][a-z0-9_]*$/u.test(value))throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function collectPlanNodes(value:unknown,nodes:Record<string,unknown>[]=[]):Record<string,unknown>[] {
  if(Array.isArray(value)){
    for(const item of value)collectPlanNodes(item,nodes);
  }else if(typeof value==='object'&&value!==null){
    const record=value as Record<string,unknown>;
    if(typeof record['Node Type']==='string')nodes.push(record);
    for(const item of Object.values(record))collectPlanNodes(item,nodes);
  }
  return nodes;
}

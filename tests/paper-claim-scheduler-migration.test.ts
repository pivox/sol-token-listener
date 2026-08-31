import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { paperDecisionClaimSql } from '../src/storage/paper-decision.repository.js';

const migrationsDirectory=new URL('../migrations/',import.meta.url);
const migrationName='029_paper_finality_claim_scheduler.sql';
const migrationUrl=new URL(`../migrations/${migrationName}`,import.meta.url);

void test('adds a replay-safe monotone paper finality claim scheduler',async(context)=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  if(databaseUrl===undefined||databaseUrl.trim()===''){
    context.skip('TEST_DATABASE_URL absent: paper claim scheduler migration test skipped');
    return;
  }
  const schema=`paper_claim_scheduler_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:databaseUrl});
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const legacyNames=(await readdir(migrationsDirectory))
      .filter((name)=>/^(?:00[1-9]|01[0-9]|02[0-8])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left,right)=>left.localeCompare(right));
    assert.equal(legacyNames.at(-1),'028_paper_finality_replay_evidence.sql');
    for(const name of legacyNames){
      await pool.query(await readFile(new URL(name,migrationsDirectory),'utf8'));
      await pool.query(`INSERT INTO migration_history(version) VALUES ($1)
        ON CONFLICT (version) DO NOTHING`,[name]);
    }
    await seedSource(pool);
    await insertJobs(pool,3);

    assert.deepEqual(await migrateDatabase({pool}),[
      migrationName,
      '030_listener_websocket_health.sql',
      '031_execution_intents.sql', '032_execution_dry_run_assessments.sql',
      '033_execution_simulation_artifacts.sql',
      '034_execution_risk_reconciliation.sql',
      '035_execution_preflight_operations.sql',
    ]);
    assert.deepEqual((await pool.query(`SELECT mint,finality_checked_at,
      claim_scan_generation::text AS claim_scan_generation
      FROM paper_decision_jobs ORDER BY created_at,job_id`)).rows,[
      {mint:'scheduler-mint',finality_checked_at:null,claim_scan_generation:'1'},
      {mint:'scheduler-mint',finality_checked_at:null,claim_scan_generation:'2'},
      {mint:'scheduler-mint',finality_checked_at:null,claim_scan_generation:'3'},
    ]);
    const before=(await pool.query(`SELECT job_id,claim_scan_generation::text AS generation
      FROM paper_decision_jobs ORDER BY job_id`)).rows;
    await pool.query(await readFile(migrationUrl,'utf8'));
    assert.deepEqual((await pool.query(`SELECT job_id,claim_scan_generation::text AS generation
      FROM paper_decision_jobs ORDER BY job_id`)).rows,before);
    assert.deepEqual(await migrateDatabase({pool}),[]);
    const index=(await pool.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname=CURRENT_SCHEMA()
        AND indexname='paper_decision_jobs_finality_preflight_idx'`)).rows[0]?.indexdef;
    assert.equal(typeof index,'string');
    assert.match(index,/CASE[^]*PENDING[^]*RETRYABLE_FAILED[^]*PROCESSING/iu);
    assert.match(index,/claim_scan_generation.*created_at.*job_id/iu);

    await insertJobs(pool,100_000,3);
    await pool.query(`UPDATE paper_decision_jobs SET
      status=CASE MOD(claim_scan_generation,3)
        WHEN 0 THEN 'PENDING'
        WHEN 1 THEN 'RETRYABLE_FAILED'
        ELSE 'PROCESSING' END,
      next_attempt_at=CASE WHEN MOD(claim_scan_generation,3)=1 THEN to_timestamp(90) END,
      error_code=CASE WHEN MOD(claim_scan_generation,3)=1 THEN 'RPC_TRANSIENT' END,
      lease_token=CASE WHEN MOD(claim_scan_generation,3)=2 THEN 'expired' END,
      lease_expires_at=CASE WHEN MOD(claim_scan_generation,3)=2 THEN to_timestamp(90) END`);
    await pool.query('ANALYZE paper_decision_jobs');
    await pool.query('BEGIN');
    const explained=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,COSTS OFF)
      ${paperDecisionClaimSql()}`,[
      new Date(100_000),'scheduler-lease',new Date(110_000),4_097,16,new Date(14_500_000),
    ]);
    await pool.query('ROLLBACK');
    const nodes=collectPlanNodes(explained.rows[0]);
    const schedulerNode=nodes.find((node)=>
      node['Index Name']==='paper_decision_jobs_finality_preflight_idx');
    assert.ok(schedulerNode);
    assert.equal(typeof schedulerNode['Index Cond'],'string');
    assert.ok((schedulerNode['Actual Rows'] as number)<=16);
    assert.ok((schedulerNode['Actual Loops'] as number)<=1);
    assert.equal(nodes.some((node)=>node['Node Type']==='Sort'),false,
      JSON.stringify(nodes.filter((node)=>node['Node Type']==='Sort')));
    assert.equal(nodes.some((node)=>
      node['Node Type']==='Seq Scan'&&node['Relation Name']==='paper_decision_jobs'),false);
    const rawNodes=nodes.filter((node)=>
      node['Index Name']==='raw_chain_events_paper_finality_cursor_idx');
    assert.ok(rawNodes.length>0);
    assert.ok(rawNodes.every((node)=>(node['Actual Loops'] as number)<=16));
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

async function seedSource(pool:pg.Pool):Promise<void>{
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) VALUES ('scheduler-mint','pumpfun','pump','creator','SPL_TOKEN','DETECTED',
    'scheduler-signature',10,0,1,to_timestamp(1),to_timestamp(1))`);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ('scheduler-raw','pumpfun','pump','scheduler-mint','scheduler-signature',
    10,0,1,'confirmed',to_timestamp(1),1,'{}')`);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ('scheduler-event','scheduler-raw','TokenLaunchDetected','scheduler-mint',
    'pumpfun','pump','scheduler-signature',10,0,1,'confirmed',to_timestamp(1),1,'{}')`);
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
    processing_status,observed_at
  ) VALUES ('scheduler-signature',10,ARRAY['WEBSOCKET'],
    ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],'confirmed','PENDING',
    to_timestamp(1))`);
}

async function insertJobs(pool:pg.Pool,count:number,offset=0):Promise<void>{
  await pool.query(`INSERT INTO paper_decision_jobs (
    job_id,mint,source_event_id,source_raw_event_id,source_confirmation_status,
    input_fingerprint,status,max_attempts,base_delay_ms,created_at,updated_at,
    payload_version,payload
  ) SELECT 'paper_job_'||md5((value+$2)::text)||md5('scheduler-job-'||(value+$2)),
    'scheduler-mint','scheduler-event','scheduler-raw','confirmed',
    md5('scheduler-left-'||(value+$2))||md5('scheduler-right-'||(value+$2)),
    'PENDING',5,500,to_timestamp(1)+(value+$2)*INTERVAL '1 millisecond',
    to_timestamp(1)+(value+$2)*INTERVAL '1 millisecond',1,'{}'::jsonb
    FROM generate_series(1,$1) value`,[count,offset]);
}

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

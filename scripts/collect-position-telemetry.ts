import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';
import { EvidenceJournal, identity } from '../src/telemetry/journal.js';
import { normalizeRunner, type RunnerRow } from '../src/telemetry/runner.js';
import { captureMarket } from '../src/telemetry/postgres.js';
import { SNAPSHOT_SECONDS, snapshotPosition, summarizePosition, type Observation, type Snapshot } from '../src/telemetry/position.js';
import { loadDataset } from '../src/telemetry/dataset.js';

const {values}=parseArgs({options:{source:{type:'string'},out:{type:'string'},follow:{type:'boolean'},history:{type:'boolean'},'no-db':{type:'boolean'},'quote-source':{type:'string'}}});
if(!values.source||!values.out)throw new Error('Usage: tsx scripts/collect-position-telemetry.ts --source EVIDENCE_DIR --out NEW_TELEMETRY_DIR [--follow] [--history --no-db]');
if(values.history && !values['no-db'])throw new Error('Historical import requires --no-db (no retrospective DB backfill).');
dotenv.config({quiet:true});
const source=path.resolve(values.source);const out=path.resolve(values.out);
const input=await EvidenceJournal.open(path.join(out,'inputs.v1.jsonl'));
const output=await EvidenceJournal.open(path.join(out,'position_telemetry.v1.jsonl'));
const manifest=input.rows.find(r=>r.kind==='manifest');
const startedAtMs=typeof manifest?.startedAtMs==='number'?manifest.startedAtMs:Date.now();
const runId=typeof manifest?.runId==='string'?manifest.runId:identity([path.basename(source),startedAtMs]);
await input.append({id:`manifest:${runId}`,schema:'position_telemetry_input.v1',kind:'manifest',runId,startedAtMs,
  additionalRpcRequests:0,sourceMode:values.history?'HISTORICAL_RUNNER_ONLY':'LIVE_SIDECAR'});
const pool=values['no-db']||!process.env.DATABASE_URL?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:750,statement_timeout:750,application_name:'position_telemetry_readonly'});
const stop={requested:false};process.on('SIGINT',()=>{stop.requested=true;});process.on('SIGTERM',()=>{stop.requested=true;});
let dbCaptures=0;let dbErrors=0;let lastDbPoll=0;
let quoteRowsLoaded=0;let quoteRowsInvalid=0;
const seenQuoteRows=new Set<string>();
const marketContent=new Map<string,string>();

async function runnerFiles():Promise<string[]>{
  let children;try{children=await readdir(source,{withFileTypes:true});}catch{return [];}
  return children.filter(x=>x.isDirectory()&&/^wave-\d+$/.test(x.name)).map(x=>path.join(source,x.name,'canary.jsonl'));
}
async function readRows(file:string):Promise<RunnerRow[]>{
  let content;try{content=await readFile(file,'utf8');}catch{return [];}
  // A concurrent writer can leave an incomplete last line; only complete lines are eligible.
  return content.slice(0,content.lastIndexOf('\n')+1).split('\n').filter(Boolean).flatMap(line=>{
    try{const row:unknown=JSON.parse(line);return typeof row==='object'&&row!==null&&!Array.isArray(row)?[{...row}]:[];}catch{return [];}
  });
}
try{
  console.log(JSON.stringify({event:'telemetry_started',runId,additionalRpcRequests:0,databaseConfigured:pool!==null}));
  do{
    for(const file of await runnerFiles()){
      const positions=normalizeRunner(runId,await readRows(file));
      for(const position of positions){
        if(!values.history && position.entry.entryAtMs<startedAtMs)continue;
        await input.append({id:identity(['position',position.entry]),schema:'position_telemetry_input.v1',kind:'position',data:position.entry});
        for(const observation of position.observations)await input.append({id:observation.id,schema:'position_telemetry_input.v1',kind:'observation',positionId:position.entry.positionId,data:observation});
      }
    }
    if(values['quote-source']){
      let quoteRows:RunnerRow[]=[];
      try{await access(path.resolve(values['quote-source']));quoteRows=await readRows(path.resolve(values['quote-source']));}
      catch{const missingId=identity(['missing_quote_source',path.resolve(values['quote-source'])]);if(!seenQuoteRows.has(missingId)){seenQuoteRows.add(missingId);quoteRowsInvalid++;}}
      const knownPositions=new Set(loadDataset(input.rows).map(p=>p.entry.positionId));
      for(const row of quoteRows){
        const rowId=typeof row.id==='string'?row.id:identity(row);if(seenQuoteRows.has(rowId))continue;seenQuoteRows.add(rowId);
        const positionId=typeof row.positionId==='string'?row.positionId:null;
        const atMs=typeof row.receivedAtMs==='number'&&Number.isFinite(row.receivedAtMs)?row.receivedAtMs:null;
        const quote=typeof row.quote==='object'&&row.quote!==null&&!Array.isArray(row.quote)?row.quote as Observation['quote']:null;
        if(row.schema!=='quote_observation.v1'||!positionId||atMs===null||!quote||!knownPositions.has(positionId)){quoteRowsInvalid++;continue;}
        const observation:Observation={id:identity([positionId,row.id]),atMs,kind:'quote',creator:null,coverage:'UNAVAILABLE',trades:[],clusters:[],relationships:[],graphAvailable:false,graphCoverage:null,quote};
        if(await input.append({id:identity(['quote_observation',observation]),schema:'position_telemetry_input.v1',kind:'observation',positionId,data:observation}))quoteRowsLoaded++;
      }
    }
    const now=Date.now();
    if(pool && now-lastDbPoll>=2000){
      lastDbPoll=now;
      // Keep finality/reorg capture for 120 seconds after exit, independently of trading.
      for(const p of loadDataset(input.rows).filter(p=>p.entry.exit===null||now-p.entry.exit.atMs<120000).slice(-15)){
        let observation:Observation;
        try{if(p.entry.entrySlot===null)throw new Error('BUY_SLOT_UNKNOWN');observation=await captureMarket(pool,p.entry.mint,p.entry.entrySlot);dbCaptures++;}
        catch{dbErrors++;const atMs=Date.now();observation={id:identity([p.entry.positionId,atMs,'DB_UNAVAILABLE']),atMs,kind:'market',creator:null,coverage:'UNAVAILABLE',trades:[],clusters:[],relationships:[],graphAvailable:false,graphCoverage:null,quote:null};}
        const hash=identity({...observation,id:null,atMs:null});
        if(marketContent.get(p.entry.positionId)!==hash){
          await input.append({id:observation.id,schema:'position_telemetry_input.v1',kind:'observation',positionId:p.entry.positionId,data:observation});
          marketContent.set(p.entry.positionId,hash);
        }
      }
    }
    for(const p of loadDataset(input.rows)){
      let previous:Snapshot|undefined;
      for(const seconds of SNAPSHOT_SECONDS){
        const atMs=p.entry.entryAtMs+seconds*1000;if(atMs>Date.now())continue;
        const snapshot=snapshotPosition(p.entry,p.observations,atMs,previous);previous=snapshot;
        await output.append({id:identity(snapshot),...snapshot});
      }
      if(p.entry.exit!==null){const summary=summarizePosition(p.entry,p.observations);await output.append({id:identity(summary),...summary});}
    }
    await output.append({id:identity(['health',Math.floor(now/30000),dbCaptures,dbErrors,quoteRowsLoaded,quoteRowsInvalid]),schema:'position_telemetry.v1',kind:'health',atMs:now,
      additionalRpcRequests:0,dbCaptures,dbErrors,databaseConfigured:pool!==null,quoteRowsLoaded,quoteRowsInvalid,quoteSourceConfigured:values['quote-source']!==undefined});
    if(values.follow&&!stop.requested)await sleep(1000);
  }while(values.follow&&!stop.requested);
}catch{
  console.error('TELEMETRY_COLLECTOR_FAILED: inspect disk space, permissions and evidence format; trading is independent.');
  process.exitCode=1;
}finally{await pool?.end();await input.close();await output.close();}

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJournal } from '../src/telemetry/journal.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../',import.meta.url));
void test('independent collector replay, restart and report require no signer, RPC or trading changes', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'telemetry-isolation-'));
  const source=path.join(dir,'source');const out=path.join(dir,'out');
  await mkdir(path.join(source,'wave-001'),{recursive:true});
  const rows=[
    {event:'preflight',at:'2026-01-01T00:00:00Z',mint:'mint',wallet:'wallet',initialWalletLamports:10000,krakenSolUsdt:100,sellNetworkFeeReserveLamports:'5'},
    {event:'buy_confirmed',at:'2026-01-01T00:00:01Z',signature:'buy',slot:100,feeLamports:10},
    {event:'position_open',at:'2026-01-01T00:00:02Z',signature:'buy',slot:100,tokenRaw:'100',buyEconomicCostLamports:'1010',tokenAccountRentLamports:90},
    {event:'price_progress',at:'2026-01-01T00:00:05Z',expectedSellQuoteLamports:'1200',requiredSellQuoteLamports:'1100'},
    {event:'fatal',at:'2026-01-01T00:00:06Z',message:'SECRET_SENTINEL https://private-rpc.example/?api-key=SECRET_SENTINEL'},
  ];
  const file=path.join(source,'wave-001','canary.jsonl');const original=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
  await writeFile(file,original);
  const args=['--import','tsx','scripts/collect-position-telemetry.ts','--source',source,'--out',out,'--history','--no-db'];
  try {
    const env={...process.env,SOLANA_HTTP_RPC_URL:'http://127.0.0.1:1',EXECUTOR_KEYPAIR_PATH:'/nonexistent',DATABASE_URL:'postgres://invalid'};
    await exec(process.execPath,args,{cwd:root,env});
    const a=parseJournal(await readFile(path.join(out,'inputs.v1.jsonl'),'utf8'));
    await exec(process.execPath,args,{cwd:root,env});
    const b=parseJournal(await readFile(path.join(out,'inputs.v1.jsonl'),'utf8'));
    assert.deepEqual(a,b);
    assert.equal(await readFile(file,'utf8'),original);
    assert.ok(!JSON.stringify(b).includes('SECRET_SENTINEL'));
    const telemetry=parseJournal(await readFile(path.join(out,'position_telemetry.v1.jsonl'),'utf8'));
    assert.equal(telemetry.filter(r=>r.kind==='snapshot').length,7);
    await exec(process.execPath,['--import','tsx','scripts/report-position-telemetry.ts','--input',path.join(out,'inputs.v1.jsonl'),'--out',path.join(out,'report.md')],{cwd:root,env});
    const report: any=JSON.parse(await readFile(path.join(out,'report.md.json'),'utf8'));
    assert.equal(report.positions.length,1);
    assert.equal(report.positions[0].snapshots[0].netExecutablePnlRaw,null);
    assert.equal(report.positions[0].snapshots[0].quote.reason,'HISTORICAL_TIMING_NOT_CAPTURED');
    assert.equal(report.positions[0].snapshots[0].activity,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});

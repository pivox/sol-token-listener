export const MAX_PAPER_FINALITY_RAW_ROWS = 4_096;

interface QueryResultLike {
  readonly rows:readonly unknown[];
}

export interface PaperFinalityBarrierClient {
  query(text:string,values?:readonly unknown[]):Promise<QueryResultLike>;
}

export class PaperFinalityBarrierError extends Error {
  public constructor(){
    super('Paper source replay is not current.');
    this.name='PaperFinalityBarrierError';
  }
}

interface RawReplayState {
  readonly eventId:string;
  readonly signature:string;
  readonly observedSlot:string;
  readonly confirmationStatus:string;
}

interface InboxReplayState {
  readonly signature:string;
  readonly processingStatus:string;
  readonly confirmationStatus:string;
}

interface FinalityReplayReceipt {
  readonly signature:string;
  readonly observedSlot:string;
  readonly confirmationStatus:string;
}

export async function assertPaperFinalityReplayCurrent(
  client:PaperFinalityBarrierClient,
  input:Readonly<{ mint:string;sourceRawEventId:string }>,
):Promise<void>{
  const rawResult=await client.query(paperFinalityRelevantRawSql('parameters'),[
    input.mint,input.sourceRawEventId,MAX_PAPER_FINALITY_RAW_ROWS+1,
  ]);
  if(rawResult.rows.length===0||rawResult.rows.length>MAX_PAPER_FINALITY_RAW_ROWS){
    throw new PaperFinalityBarrierError();
  }
  const rawRows=rawResult.rows.map(rawReplayState);
  if(!rawRows.some((row)=>row.eventId===input.sourceRawEventId)){
    throw new PaperFinalityBarrierError();
  }
  const signatures=Object.freeze([...new Set(rawRows.map((row)=>row.signature))].sort());
  const inboxResult=await client.query(`SELECT signature,processing_status,
    target_confirmation_status
    FROM chain_transaction_inbox
    WHERE signature=ANY($1::text[])
    ORDER BY signature COLLATE "C"
    FOR SHARE`,[signatures]);
  const inboxBySignature=new Map(
    inboxResult.rows.map(inboxReplayState).map((row)=>[row.signature,row] as const),
  );
  const missingTerminalSignatures=Object.freeze([...new Set(rawRows
    .filter((raw)=>!inboxBySignature.has(raw.signature)
      &&isTerminalConfirmation(raw.confirmationStatus))
    .map((raw)=>raw.signature))].sort());
  const receiptResult=missingTerminalSignatures.length===0
    ? { rows:[] as readonly unknown[] }
    : await client.query(`SELECT signature,observed_slot::text AS observed_slot,
        confirmation_status
      FROM chain_transaction_finality_replay_receipts
      WHERE signature=ANY($1::text[])
      ORDER BY signature COLLATE "C"
      FOR SHARE`,[missingTerminalSignatures]);
  const receiptBySignature=new Map(
    receiptResult.rows.map(finalityReplayReceipt).map((row)=>[row.signature,row] as const),
  );
  for(const raw of rawRows){
    const inbox=inboxBySignature.get(raw.signature);
    if(inbox===undefined){
      const receipt=receiptBySignature.get(raw.signature);
      if(!isTerminalConfirmation(raw.confirmationStatus)
        ||receipt?.observedSlot!==raw.observedSlot
        ||receipt.confirmationStatus!==raw.confirmationStatus){
        throw new PaperFinalityBarrierError();
      }
    }else if(inbox.processingStatus!=='PROCESSED'
      ||inbox.confirmationStatus!==raw.confirmationStatus){
      throw new PaperFinalityBarrierError();
    }
  }
}

export function paperFinalityRelevantRawSql(
  context:'parameters'|'paper-decision-job',
):string{
  const mint=context==='parameters'?'$1':'job.mint';
  const sourceRawEventId=context==='parameters'?'$2':'job.source_raw_event_id';
  const rowLimit=context==='parameters'?'$3':'$4';
  return `WITH source_raw AS MATERIALIZED (
    SELECT event_id,signature,slot,transaction_index,instruction_index,
      inner_instruction_index,confirmation_status,
      ${rowLimit}::integer-CASE WHEN confirmation_status='orphaned' THEN 1 ELSE 0 END
        AS active_limit
    FROM raw_chain_events
    WHERE event_id=${sourceRawEventId} AND mint=${mint}
  )
  SELECT relevant.event_id,relevant.signature,relevant.slot::text AS observed_slot,
    relevant.confirmation_status
  FROM (
    (SELECT raw.event_id,raw.signature,raw.slot,raw.confirmation_status
     FROM raw_chain_events raw
     WHERE raw.mint=${mint}
       AND raw.confirmation_status<>'orphaned'
       AND ROW(
         raw.slot,raw.transaction_index,raw.instruction_index,
         COALESCE(raw.inner_instruction_index,-1)
       ) <= (SELECT
         source.slot,source.transaction_index,source.instruction_index,
         COALESCE(source.inner_instruction_index,-1)
       FROM source_raw source
       )
     ORDER BY raw.slot,raw.transaction_index,raw.instruction_index,
       COALESCE(raw.inner_instruction_index,-1),raw.event_id
     LIMIT (SELECT active_limit FROM source_raw))
    UNION ALL
    SELECT source.event_id,source.signature,source.slot,source.confirmation_status
    FROM source_raw source
    WHERE source.confirmation_status='orphaned'
  ) relevant`;
}

function rawReplayState(value:unknown):RawReplayState{
  const row=record(value);
  return Object.freeze({
    eventId:text(row.event_id),signature:text(row.signature),
    observedSlot:text(row.observed_slot),
    confirmationStatus:text(row.confirmation_status),
  });
}

function finalityReplayReceipt(value:unknown):FinalityReplayReceipt{
  const row=record(value);
  return Object.freeze({
    signature:text(row.signature),observedSlot:text(row.observed_slot),
    confirmationStatus:text(row.confirmation_status),
  });
}

function isTerminalConfirmation(value:string):boolean{
  return value==='finalized'||value==='orphaned';
}

function inboxReplayState(value:unknown):InboxReplayState{
  const row=record(value);
  return Object.freeze({
    signature:text(row.signature),processingStatus:text(row.processing_status),
    confirmationStatus:text(row.target_confirmation_status),
  });
}

function record(value:unknown):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value)){
    throw new PaperFinalityBarrierError();
  }
  return value as Record<string,unknown>;
}

function text(value:unknown):string{
  if(typeof value!=='string'||value.length===0)throw new PaperFinalityBarrierError();
  return value;
}

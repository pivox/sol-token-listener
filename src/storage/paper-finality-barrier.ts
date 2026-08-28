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
  readonly confirmationStatus:string;
}

interface InboxReplayState {
  readonly signature:string;
  readonly processingStatus:string;
  readonly confirmationStatus:string;
}

export async function assertPaperFinalityReplayCurrent(
  client:PaperFinalityBarrierClient,
  input:Readonly<{ mint:string;sourceRawEventId:string }>,
):Promise<void>{
  const rawResult=await client.query(`WITH source_cursor AS (
    SELECT slot,transaction_index,instruction_index,inner_instruction_index
    FROM raw_chain_events
    WHERE event_id=$2 AND mint=$1
  )
  SELECT raw.event_id,raw.signature,raw.confirmation_status
  FROM raw_chain_events raw
  CROSS JOIN source_cursor source
  WHERE raw.mint=$1
    AND (
      raw.event_id=$2
      OR (
        raw.confirmation_status<>'orphaned'
        AND ROW(
          raw.slot,raw.transaction_index,raw.instruction_index,
          COALESCE(raw.inner_instruction_index,-1)
        ) <= ROW(
          source.slot,source.transaction_index,source.instruction_index,
          COALESCE(source.inner_instruction_index,-1)
        )
      )
    )
  ORDER BY raw.slot,raw.transaction_index,raw.instruction_index,
    COALESCE(raw.inner_instruction_index,-1),raw.event_id
  LIMIT $3`,[
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
  for(const raw of rawRows){
    const inbox=inboxBySignature.get(raw.signature);
    if(inbox?.processingStatus!=='PROCESSED'
      ||inbox.confirmationStatus!==raw.confirmationStatus){
      throw new PaperFinalityBarrierError();
    }
  }
}

function rawReplayState(value:unknown):RawReplayState{
  const row=record(value);
  return Object.freeze({
    eventId:text(row.event_id),signature:text(row.signature),
    confirmationStatus:text(row.confirmation_status),
  });
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

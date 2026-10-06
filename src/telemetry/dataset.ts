import type { JournalRow } from './journal.js';
import type { Observation, PositionEvidence } from './position.js';
import type { NormalizedPosition } from './runner.js';

/** Internal versioned journal. Readers reject unsupported schemas rather than reinterpret them. */
export function loadDataset(rows: readonly JournalRow[]): NormalizedPosition[] {
  const positions=new Map<string,NormalizedPosition>();
  for(const row of rows){
    if(row.kind!=='position' && row.kind!=='observation')continue;
    if(row.schema!=='position_telemetry_input.v1')throw new Error('UNSUPPORTED_TELEMETRY_SCHEMA');
    if(typeof row.data!=='object'||row.data===null)throw new Error('INVALID_TELEMETRY_DATA');
    if(row.kind==='position'){
      const data=row.data as PositionEvidence;
      if(typeof data.positionId!=='string'||typeof data.entryAtMs!=='number')throw new Error('INVALID_POSITION');
      const old=positions.get(data.positionId);
      positions.set(data.positionId,{entry:data,observations:old?.observations??[]});
    }else{
      if(typeof row.positionId!=='string')throw new Error('INVALID_OBSERVATION_POSITION');
      const position=positions.get(row.positionId);if(!position)throw new Error('MISSING_POSITION');
      const data=row.data as Observation;
      if(typeof data.id!=='string'||typeof data.atMs!=='number')throw new Error('INVALID_OBSERVATION');
      position.observations.push(data);
    }
  }
  return [...positions.values()].map(p=>({...p,observations:[...new Map(p.observations.map(o=>[o.id,o])).values()].sort((a,b)=>a.atMs-b.atMs)}));
}

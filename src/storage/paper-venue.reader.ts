import type { CanonicalMarketPool } from '../domain/market.js';
import type {
  CanonicalPaperVenueReader,
  CanonicalPaperVenueState,
} from '../paper/paper-quote-router.js';
import { fromJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface Result { readonly rows: readonly unknown[] }
interface Client { query(text:string,values?:readonly unknown[]):Promise<Result>;release():void }
interface Pool { connect():Promise<Client> }

export class PostgresPaperVenueReader implements CanonicalPaperVenueReader {
  public constructor(
    private readonly headSlot:()=>Promise<bigint>,
    private readonly pool:Pool=getDatabasePool(),
  ) {}

  public async read(mint:string):Promise<CanonicalPaperVenueState> {
    if(mint.length===0)throw new TypeError('Paper venue mint is required.');
    const client=await this.pool.connect();
    try {
      const curveResult=await client.query(`SELECT complete FROM bonding_curve_snapshots
        WHERE mint=$1 AND confirmation_status<>'orphaned'
        ORDER BY slot DESC,transaction_index DESC,instruction_index DESC,
          COALESCE(inner_instruction_index,-1) DESC,snapshot_id DESC LIMIT 1`,[mint]);
      const migrationResult=await client.query(`SELECT 1 AS present
        FROM migrations migration
        JOIN domain_events event ON event.event_id=migration.event_id
        WHERE migration.mint=$1 AND migration.confirmation_status<>'orphaned'
          AND event.confirmation_status<>'orphaned'
        ORDER BY event.slot DESC,event.transaction_index DESC,event.instruction_index DESC,
          COALESCE(event.inner_instruction_index,-1) DESC,migration.migration_id DESC LIMIT 1`,[mint]);
      const poolResult=await client.query(`SELECT payload FROM market_pools
        WHERE base_mint=$1 AND pool_state='active' AND confirmation_status<>'orphaned'
        ORDER BY slot DESC,transaction_index DESC,instruction_index DESC,
          COALESCE(inner_instruction_index,-1) DESC,pool_address DESC LIMIT 1`,[mint]);
      const curveRow=curveResult.rows[0];
      const complete=curveRow===undefined?null:booleanField(curveRow,'complete');
      const poolRow=poolResult.rows[0];
      return Object.freeze({
        mint,
        bondingCurve:complete===null?null:Object.freeze({ active:!complete,complete }),
        migrationObserved:migrationResult.rows.length>0,
        pumpSwap:poolRow===undefined?null:Object.freeze({
          active:true,pool:decodePool(field(poolRow,'payload')),
        }),
        headSlot:await this.headSlot(),
      });
    } finally { client.release(); }
  }
}

function decodePool(value:unknown):CanonicalMarketPool {
  const decoded=fromJsonValue(value);
  if(typeof decoded!=='object'||decoded===null)throw new TypeError('Paper venue pool payload is invalid.');
  return deepFreeze(decoded) as CanonicalMarketPool;
}

function deepFreeze<T>(value:T):T {
  if(typeof value!=='object'||value===null||Object.isFrozen(value))return value;
  for(const nested of Object.values(value))deepFreeze(nested);
  return Object.freeze(value);
}

function field(row:unknown,name:string):unknown {
  if(typeof row!=='object'||row===null||!(name in row))throw new TypeError(`Paper venue field ${name} is missing.`);
  return (row as Record<string,unknown>)[name];
}

function booleanField(row:unknown,name:string):boolean {
  const value=field(row,name);
  if(typeof value!=='boolean')throw new TypeError(`Paper venue field ${name} is invalid.`);
  return value;
}

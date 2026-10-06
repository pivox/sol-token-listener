import { Connection, PublicKey } from '@solana/web3.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  PostgresMarketPoolTrackingRepository,
  type PoolCheckpoint,
  type PoolCheckpointPosition,
} from '../storage/market-pool-tracking.repository.js';

type MarketPoolOperatorCommand =
  | { readonly action: 'inspect'; readonly pool: string; readonly confirmed: false }
  | { readonly action: 'reseed'; readonly pool: string; readonly confirmed: boolean };

export function parseMarketPoolOperatorCommand(args: readonly string[]): MarketPoolOperatorCommand {
  const [command, ...rest] = args;
  if (command !== 'inspect' && command !== 'reseed-at-finalized-frontier') {
    throw new TypeError('Expected inspect or reseed-at-finalized-frontier.');
  }
  let pool: string | undefined;
  let confirmed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--pool' && pool === undefined) {
      pool = rest[++index];
    } else if (argument === '--confirm-pool-history-gap' && command !== 'inspect' && !confirmed) {
      confirmed = true;
    } else {
      throw new TypeError('Unsupported or duplicate market pool operator argument.');
    }
  }
  if (pool === undefined) throw new TypeError('--pool is required.');
  try {
    new PublicKey(pool);
  } catch {
    throw new TypeError('--pool must be a valid public key.');
  }
  return command === 'inspect'
    ? Object.freeze({ action: 'inspect', pool, confirmed: false })
    : Object.freeze({ action: 'reseed', pool, confirmed });
}

export interface MarketPoolReseedPlanInput {
  readonly checkpoint: PoolCheckpoint | null;
  readonly frontier: PoolCheckpointPosition | null;
  readonly genesisHash: string;
  readonly expectedGenesisHash: string | undefined;
  readonly confirmed: boolean;
}

export function planMarketPoolReseed(
  input: MarketPoolReseedPlanInput,
): { readonly apply: boolean; readonly refusal: string | null } {
  const refuse = (refusal: string): { readonly apply: boolean; readonly refusal: string | null } => Object.freeze({ apply: false, refusal });
  if (!input.confirmed) return refuse('CONFIRMATION_REQUIRED');
  if (input.expectedGenesisHash === undefined || input.expectedGenesisHash.trim() === '') {
    return refuse('EXPECTED_GENESIS_HASH_NOT_SET');
  }
  if (input.genesisHash !== input.expectedGenesisHash.trim()) return refuse('GENESIS_HASH_MISMATCH');
  if (input.checkpoint === null) return refuse('NO_CHECKPOINT');
  if (input.frontier === null) return refuse('NO_FRONTIER');
  if (input.frontier.slot < input.checkpoint.slot) return refuse('FRONTIER_BEHIND_CHECKPOINT');
  return Object.freeze({ apply: true, refusal: null });
}

export function truncateSignature(signature: string | null): string | null {
  if (signature === null || signature.length <= 17) return signature;
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

async function main(args: readonly string[]): Promise<void> {
  const command = parseMarketPoolOperatorCommand(args);
  const databaseUrl = process.env.DATABASE_URL;
  const rpcUrl = process.env.SOLANA_HTTP_RPC_URL;
  if (databaseUrl === undefined || rpcUrl === undefined) {
    throw new Error('DATABASE_URL and SOLANA_HTTP_RPC_URL are required.');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const repository = new PostgresMarketPoolTrackingRepository(pool);
    const checkpoint = await repository.readCheckpoint(command.pool);
    const connection = new Connection(rpcUrl, 'finalized');
    const [newest] = await connection.getSignaturesForAddress(
      new PublicKey(command.pool), { limit: 1 }, 'finalized',
    );
    const frontier: PoolCheckpointPosition | null = newest === undefined
      ? null : { slot: BigInt(newest.slot), signature: newest.signature };
    const report = {
      event: 'market.pool.checkpoint.operator',
      pool: command.pool,
      checkpointSlot: checkpoint?.slot.toString() ?? null,
      checkpointSignature: truncateSignature(checkpoint?.signature ?? null),
      frontierSlot: frontier?.slot.toString() ?? null,
      frontierSignature: truncateSignature(frontier?.signature ?? null),
    };
    if (command.action === 'inspect') {
      console.log(JSON.stringify({ ...report, applied: false }));
      return;
    }
    const plan = planMarketPoolReseed({
      checkpoint,
      frontier,
      genesisHash: await connection.getGenesisHash(),
      expectedGenesisHash: process.env.LIVE_EXPECTED_GENESIS_HASH,
      confirmed: command.confirmed,
    });
    if (!plan.apply || frontier === null) {
      console.log(JSON.stringify({ ...report, applied: false, refusal: plan.refusal }));
      process.exitCode = plan.refusal === 'CONFIRMATION_REQUIRED' ? 0 : 1;
      return;
    }
    await repository.reseedAtFrontier(command.pool, frontier, Date.now());
    console.log(JSON.stringify({ ...report, applied: true, reason: 'operator-approved-pool-frontier-seed' }));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Market pool operator failed.');
    process.exitCode = 1;
  });
}

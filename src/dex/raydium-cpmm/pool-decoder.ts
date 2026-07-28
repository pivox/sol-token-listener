import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { CPMM_DISCRIMINATORS, CPMM_POOL_STATE_SIZE, CPMM_SWAP_DISABLED_BIT } from './constants.js';
import type { DecodedPoolState } from './types.js';

export function decodePoolState(data: Uint8Array): DecodedPoolState {
  if (data.byteLength < CPMM_POOL_STATE_SIZE) {
    throw new Error(`Compte PoolState trop court: ${data.byteLength} octets.`);
  }
  if (!data.subarray(0, 8).every((value, index) => value === CPMM_DISCRIMINATORS.poolState[index])) {
    throw new Error('Discriminateur PoolState Raydium invalide.');
  }
  return {
    config: readPublicKey(data, 8),
    creator: readPublicKey(data, 40),
    vaultA: readPublicKey(data, 72),
    vaultB: readPublicKey(data, 104),
    lpMint: readPublicKey(data, 136),
    mintA: readPublicKey(data, 168),
    mintB: readPublicKey(data, 200),
    tokenProgramA: readPublicKey(data, 232),
    tokenProgramB: readPublicKey(data, 264),
    observation: readPublicKey(data, 296),
    bump: data[328],
    status: data[329],
    lpDecimals: data[330],
    mintDecimalsA: data[331],
    mintDecimalsB: data[332],
    lpSupplyRaw: readU64(data, 333),
    protocolFeesA: readU64(data, 341),
    protocolFeesB: readU64(data, 349),
    fundFeesA: readU64(data, 357),
    fundFeesB: readU64(data, 365),
    openTimeUnix: readU64(data, 373),
    recentEpoch: readU64(data, 381),
    feeOn: data[389],
    enableCreatorFee: data[390] !== 0,
    creatorFeesA: readU64(data, 397),
    creatorFeesB: readU64(data, 405),
  };
}

export async function readPoolState(
  connection: Connection,
  pool: string,
  expectedProgramId: string,
): Promise<{ state: DecodedPoolState; slot: bigint }> {
  const response = await connection.getAccountInfoAndContext(new PublicKey(pool), 'confirmed');
  if (!response.value) throw new Error(`Compte PoolState introuvable: ${pool}.`);
  if (response.value.owner.toBase58() !== expectedProgramId) {
    throw new Error(`Le compte ${pool} n’appartient pas au programme CPMM attendu.`);
  }
  return { state: decodePoolState(response.value.data), slot: BigInt(response.context.slot) };
}

export function swapsEnabled(status: number): boolean {
  return (status & CPMM_SWAP_DISABLED_BIT) === 0;
}

function readPublicKey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

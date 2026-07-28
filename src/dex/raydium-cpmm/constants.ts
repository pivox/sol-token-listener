import { createHash } from 'node:crypto';

export const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const RAYDIUM_BURN_AND_EARN_AUTHORITY = 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE';

export const CPMM_DISCRIMINATORS = {
  initialize: anchorDiscriminator('global', 'initialize'),
  initializeWithPermission: anchorDiscriminator('global', 'initialize_with_permission'),
  swapBaseInput: anchorDiscriminator('global', 'swap_base_input'),
  swapBaseOutput: anchorDiscriminator('global', 'swap_base_output'),
  deposit: anchorDiscriminator('global', 'deposit'),
  withdraw: anchorDiscriminator('global', 'withdraw'),
  poolState: anchorDiscriminator('account', 'PoolState'),
} as const;

// The decoded fixed fields end at byte 413. New trailing fields remain forward compatible.
export const CPMM_POOL_STATE_SIZE = 413;
export const CPMM_SWAP_DISABLED_BIT = 1 << 2;

export function anchorDiscriminator(namespace: 'global' | 'account', name: string): Uint8Array {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}

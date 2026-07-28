import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { CPMM_DISCRIMINATORS } from './constants.js';
import type {
  DecodedInitializeInstruction,
  DecodedSwapInstruction,
  RaydiumCpmmInstructionKind,
} from './types.js';

export function classifyCpmmInstruction(instruction: NormalizedInstruction): RaydiumCpmmInstructionKind {
  const discriminator = instruction.data.subarray(0, 8);
  if (equal(discriminator, CPMM_DISCRIMINATORS.initialize)) return 'INITIALIZE';
  if (equal(discriminator, CPMM_DISCRIMINATORS.initializeWithPermission)) return 'INITIALIZE_WITH_PERMISSION';
  if (equal(discriminator, CPMM_DISCRIMINATORS.swapBaseInput)) return 'SWAP_BASE_INPUT';
  if (equal(discriminator, CPMM_DISCRIMINATORS.swapBaseOutput)) return 'SWAP_BASE_OUTPUT';
  if (equal(discriminator, CPMM_DISCRIMINATORS.deposit)) return 'DEPOSIT';
  if (equal(discriminator, CPMM_DISCRIMINATORS.withdraw)) return 'WITHDRAW';
  return 'UNKNOWN';
}

export function decodeInitializeInstruction(instruction: NormalizedInstruction): DecodedInitializeInstruction | null {
  const kind = classifyCpmmInstruction(instruction);
  if (kind !== 'INITIALIZE' && kind !== 'INITIALIZE_WITH_PERMISSION') return null;
  const permission = kind === 'INITIALIZE_WITH_PERMISSION';
  const minimumAccounts = permission ? 21 : 20;
  const minimumData = permission ? 33 : 32;
  if (instruction.accounts.length < minimumAccounts || instruction.data.length < minimumData) return null;
  const account = (index: number): string => {
    const value = instruction.accounts[index];
    if (!value) throw new Error(`Compte CPMM manquant à l’index ${index}.`);
    return value;
  };
  if (permission) {
    return {
      kind,
      instruction,
      payer: account(0),
      creator: account(1),
      config: account(2),
      authority: account(3),
      pool: account(4),
      mintA: account(5),
      mintB: account(6),
      lpMint: account(7),
      vaultA: account(11),
      vaultB: account(12),
      observation: account(14),
      tokenProgramA: account(17),
      tokenProgramB: account(18),
      amountA: readU64(instruction.data, 8),
      amountB: readU64(instruction.data, 16),
      openTimeUnix: readU64(instruction.data, 24),
      feeOn: instruction.data[32] ?? null,
    };
  }
  return {
    kind,
    instruction,
    payer: account(0),
    creator: account(0),
    config: account(1),
    authority: account(2),
    pool: account(3),
    mintA: account(4),
    mintB: account(5),
    lpMint: account(6),
    vaultA: account(10),
    vaultB: account(11),
    observation: account(13),
    tokenProgramA: account(15),
    tokenProgramB: account(16),
    amountA: readU64(instruction.data, 8),
    amountB: readU64(instruction.data, 16),
    openTimeUnix: readU64(instruction.data, 24),
    feeOn: null,
  };
}

export function decodeSwapInstruction(instruction: NormalizedInstruction): DecodedSwapInstruction | null {
  const kind = classifyCpmmInstruction(instruction);
  if (kind !== 'SWAP_BASE_INPUT' && kind !== 'SWAP_BASE_OUTPUT') return null;
  if (instruction.accounts.length < 13 || instruction.data.length < 24) return null;
  const account = (index: number): string => instruction.accounts[index] ?? '';
  if (instruction.accounts.slice(0, 13).some((value) => !value)) return null;
  return {
    kind,
    instruction,
    payer: account(0),
    authority: account(1),
    config: account(2),
    pool: account(3),
    userInputAccount: account(4),
    userOutputAccount: account(5),
    inputVault: account(6),
    outputVault: account(7),
    inputTokenProgram: account(8),
    outputTokenProgram: account(9),
    inputMint: account(10),
    outputMint: account(11),
    observation: account(12),
    amountInRaw: readU64(instruction.data, 8),
    amountOutRaw: readU64(instruction.data, 16),
  };
}

function readU64(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new Error('Données d’instruction CPMM tronquées.');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

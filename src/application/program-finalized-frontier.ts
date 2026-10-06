import bs58 from 'bs58';

export type FrontierProgram = 'launchpad' | 'market';

export interface FinalizedProgramFrontier {
  readonly program: FrontierProgram;
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: 'finalized';
}

export class ProgramFinalizedFrontierError extends Error {
  public override readonly cause?: unknown;

  public constructor(public readonly code:
    | 'EMPTY_FINALIZED_PAGE'
    | 'INVALID_FINALIZED_FRONTIER'
    | 'FINALIZED_FRONTIER_RPC_ERROR', cause?: unknown) {
    super('Could not capture a finalized signature frontier for the program.');
    this.name = 'ProgramFinalizedFrontierError';
    if (cause !== undefined) this.cause = cause;
  }
}

export async function captureFinalizedProgramFrontier(
  program: FrontierProgram,
  readLatestFinalizedSignatures: () => Promise<unknown>,
): Promise<FinalizedProgramFrontier> {
  let raw: unknown;
  try {
    raw = await readLatestFinalizedSignatures();
  } catch (cause) {
    throw new ProgramFinalizedFrontierError('FINALIZED_FRONTIER_RPC_ERROR', cause);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProgramFinalizedFrontierError('EMPTY_FINALIZED_PAGE');
  }
  for (const row of raw) {
    const signature = property(row, 'signature');
    const slot = property(row, 'slot');
    const confirmationStatus = property(row, 'confirmationStatus');
    if (confirmationStatus !== 'finalized'
      || typeof signature !== 'string'
      || !validSignature(signature)
      || typeof slot !== 'number'
      || !Number.isSafeInteger(slot)
      || slot < 0
      || Object.is(slot, -0)) continue;
    return Object.freeze({
      program,
      signature,
      slot: BigInt(slot),
      confirmationStatus: 'finalized',
    });
  }
  throw new ProgramFinalizedFrontierError('INVALID_FINALIZED_FRONTIER');
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true
    ? descriptor.value : undefined;
}

function validSignature(value: string): boolean {
  try {
    return bs58.decode(value).byteLength === 64;
  } catch {
    return false;
  }
}

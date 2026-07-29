export type PumpSwapDecodingErrorCode =
  | 'PUMPSWAP_ACCOUNT_MISSING'
  | 'PUMPSWAP_BORSH_INVALID'
  | 'PUMPSWAP_BORSH_TRUNCATED'
  | 'PUMPSWAP_EVENT_AMBIGUOUS'
  | 'PUMPSWAP_EVENT_DUPLICATE'
  | 'PUMPSWAP_EVENT_MISMATCH'
  | 'PUMPSWAP_EVENT_MISSING'
  | 'PUMPSWAP_EVENT_ORPHANED'
  | 'PUMPSWAP_SCHEMA_UNSUPPORTED'
  | 'PUMPSWAP_STACK_HEIGHT_REQUIRED'
  | 'PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED';

export class PumpSwapDecodingError extends Error {
  public constructor(
    public readonly code: PumpSwapDecodingErrorCode,
    message: string,
    public readonly signature: string | null = null,
    options?: ErrorOptions,
    public readonly cursor: ChainCursor | null = null,
  ) {
    super(message, options);
    this.name = 'PumpSwapDecodingError';
  }
}
import type { ChainCursor } from '../../domain/types.js';

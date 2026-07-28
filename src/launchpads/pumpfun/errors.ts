export const PUMP_DECODING_ERROR_CODES = [
  'PUMP_TRANSACTION_INDEX_REQUIRED',
  'PUMP_SCHEMA_UNSUPPORTED',
  'PUMP_BORSH_TRUNCATED',
  'PUMP_BORSH_INVALID',
  'PUMP_ACCOUNT_MISSING',
  'PUMP_STACK_HEIGHT_REQUIRED',
  'PUMP_STACK_HEIGHT_INVALID',
  'PUMP_EVENT_MISSING',
  'PUMP_EVENT_DUPLICATE',
  'PUMP_EVENT_ORPHANED',
  'PUMP_EVENT_AMBIGUOUS',
  'PUMP_EVENT_MISMATCH',
  'PUMP_QUOTE_ASSET_UNRESOLVED',
  'PUMP_QUOTE_ASSET_CONFLICT',
  'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
] as const;

export type PumpDecodingErrorCode =
  (typeof PUMP_DECODING_ERROR_CODES)[number];

export class PumpDecodingError extends Error {
  public readonly decodingCause: unknown;

  public constructor(
    public readonly code: PumpDecodingErrorCode,
    public readonly retryable: boolean,
    message: string,
    public readonly signature: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PumpDecodingError';
    this.decodingCause = cause;
  }
}

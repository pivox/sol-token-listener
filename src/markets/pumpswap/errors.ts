import { registerInternalDecodingFailure, trustedObservedPipelineOrigin } from '../../domain/observed-pipeline-failure.js';
import {
  inheritTrustedTerminalAttribution,
  registerTrustedTerminalAttribution,
  trustedTerminalAttribution,
  type TerminalDiagnosticCode,
} from '../../domain/terminal-attribution.js';
import type { ChainCursor } from '../../domain/types.js';
export const PUMPSWAP_DECODING_ERROR_CODES = [
  'PUMPSWAP_ACCOUNT_MISSING',
  'PUMPSWAP_BORSH_INVALID',
  'PUMPSWAP_BORSH_TRUNCATED',
  'PUMPSWAP_EVENT_AMBIGUOUS',
  'PUMPSWAP_EVENT_DUPLICATE',
  'PUMPSWAP_EVENT_MISMATCH',
  'PUMPSWAP_EVENT_MISSING',
  'PUMPSWAP_EVENT_ORPHANED',
  'PUMPSWAP_SCHEMA_UNSUPPORTED',
  'PUMPSWAP_STACK_HEIGHT_REQUIRED',
  'PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED',
] as const;

export type PumpSwapDecodingErrorCode = (typeof PUMPSWAP_DECODING_ERROR_CODES)[number];

const knownCodes = new Set<unknown>(PUMPSWAP_DECODING_ERROR_CODES);

/** Internal decoder factory. Public error construction does not grant terminal authority. */
export function createPumpSwapDecodingError(
  ...args: ConstructorParameters<typeof PumpSwapDecodingError>
): PumpSwapDecodingError {
  const error = new PumpSwapDecodingError(...args);
  if (knownCodes.has(args[0])) registerInternalDecodingFailure(error, args[0]);
  return error;
}

/** @internal Adds diagnostics only to an error authenticated by the internal factory. */
export function registerPumpSwapDecodingTerminalAttribution(
  error: PumpSwapDecodingError,
  attribution: unknown,
): void {
  if (trustedPumpSwapDecodingCode(error) === null) {
    throw new TypeError('PumpSwap decoding error identity is not trusted.');
  }
  registerTrustedTerminalAttribution(error, attribution);
}

export function trustedPumpSwapDecodingCode(value: unknown): PumpSwapDecodingErrorCode | null {
  const code = trustedObservedPipelineOrigin(value);
  return knownCodes.has(code) ? code as PumpSwapDecodingErrorCode : null;
}

export class PumpSwapMutableRpcDecodingError extends Error {
  public constructor(cause: unknown) {
    super('PumpSwap mutable RPC account decoding failed.', { cause });
    this.name = 'PumpSwapMutableRpcDecodingError';
  }
}

/** Remove terminal authority only from a trusted decoder error at a mutable RPC boundary. */
export function rethrowMutablePumpSwapRpcFailure(cause: unknown): never {
  if (trustedPumpSwapDecodingCode(cause) !== null) {
    registerPumpSwapTerminalDiagnostic(
      cause,
      'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
    );
    const error = new PumpSwapMutableRpcDecodingError(cause);
    inheritTrustedTerminalAttribution(error, cause);
    throw error;
  }
  throw cause;
}

/** @internal Registers a closed diagnostic only at a trusted PumpSwap boundary. */
export function registerPumpSwapTerminalDiagnostic(
  identity: unknown,
  diagnosticCode: Extract<TerminalDiagnosticCode,
    | 'PUMPSWAP_MUTABLE_RPC_UNAVAILABLE'
    | 'PUMPSWAP_RPC_CONTEXT_INVALID'
    | 'PUMPSWAP_MUTABLE_ACCOUNT_DECODING'
    | 'PUMPSWAP_MARKET_POOL_MISMATCH'
    | 'PUMPSWAP_MARKET_POOL_NON_CANONICAL'
    | 'PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION'
    | 'PUMPSWAP_PERSISTENCE_UNKNOWN'
    | 'UNAVAILABLE'>,
): void {
  if (typeof identity !== 'object'
    || identity === null
    || trustedTerminalAttribution(identity) !== null) return;
  try {
    registerTrustedTerminalAttribution(identity, {
      version: 1,
      diagnosticCode,
      causeKind: null,
      pumpWire: null,
    });
  } catch {
    // Hostile/proxied/revoked identities keep their existing runtime behavior.
  }
}

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

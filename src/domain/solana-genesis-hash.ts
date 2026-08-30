import bs58 from 'bs58';

const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const MIN_GENESIS_HASH_LENGTH = 32;
const MAX_GENESIS_HASH_LENGTH = 44;

export class SolanaGenesisHashError extends TypeError {
  public readonly field = 'SOLANA_EXPECTED_GENESIS_HASH' as const;

  public constructor() {
    super('SOLANA_EXPECTED_GENESIS_HASH is invalid.');
    this.name = 'SolanaGenesisHashError';
    Object.defineProperty(this, 'name', { enumerable: false });
    Object.freeze(this);
  }
}

export function canonicalSolanaGenesisHash(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length < MIN_GENESIS_HASH_LENGTH
    || value.length > MAX_GENESIS_HASH_LENGTH
    || !BASE58_TEXT.test(value)) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.byteLength === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

export function requireSolanaGenesisHash(
  value: string | undefined,
  listenerEnabled: boolean,
): string | null {
  if (!listenerEnabled && (value === undefined || value === '')) return null;
  if (canonicalSolanaGenesisHash(value)) return value;
  throw new SolanaGenesisHashError();
}

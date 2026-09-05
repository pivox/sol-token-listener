import { isProxy } from 'node:util/types';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export type ReadinessRpcErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_ABORTED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_TIMEOUT'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_TOO_LARGE'
  | 'RPC_RESPONSE_INVALID'
  | 'GENESIS_MISMATCH'
  | 'SLOT_LAG_EXCEEDED';

export class ReadinessRpcError extends Error {
  public constructor(public readonly code: ReadinessRpcErrorCode) {
    super('Execution readiness RPC operation failed.');
    this.name = 'ReadinessRpcError';
  }
}

export interface SolanaReadinessRpcConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
}

export interface ReadinessWalletObservationV1 {
  readonly slot: bigint;
  readonly blockTimeMs: number | null;
  readonly observedAtMs: number;
  readonly walletLamports: bigint;
  readonly tokenBalanceCount: number;
}

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TOKEN_ACCOUNTS = 10_000;

export class SolanaReadinessRpcGateway {
  readonly #config: SolanaReadinessRpcConfig;
  readonly #fetch: typeof fetch;
  #requestId = 0;
  #verified = false;

  public constructor(config: SolanaReadinessRpcConfig, fetchImplementation: typeof fetch = fetch) {
    try {
      if (!Object.isFrozen(config) && isProxy(config)) throw new TypeError();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(config.providerId)) throw new TypeError();
      const url = new URL(config.httpRpcUrl);
      if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
        throw new TypeError();
      }
      if (new PublicKey(config.expectedGenesisHash).toBase58() !== config.expectedGenesisHash
        || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100
        || config.timeoutMs > 30_000 || typeof fetchImplementation !== 'function'
        || isProxy(fetchImplementation)) throw new TypeError();
      this.#config = Object.freeze({ ...config });
      this.#fetch = fetchImplementation;
    } catch {
      throw failure('INVALID_INPUT');
    }
  }

  public async verifyGenesis(signal: AbortSignal): Promise<void> {
    this.assertSignal(signal);
    const result = await this.dispatch('getGenesisHash', Object.freeze([]), signal);
    if (publicKey(result) !== this.#config.expectedGenesisHash) throw failure('GENESIS_MISMATCH');
    this.#verified = true;
  }

  public async observeWallet(
    walletPublicKeyValue: string,
    maximumSlotLag: number,
    signal: AbortSignal,
    now: () => number = Date.now,
  ): Promise<ReadinessWalletObservationV1> {
    try {
      this.assertSignal(signal);
      if (!this.#verified || !Number.isSafeInteger(maximumSlotLag)
        || maximumSlotLag < 0 || maximumSlotLag > 8 || typeof now !== 'function') throw new TypeError();
      const walletPublicKey = publicKey(walletPublicKeyValue);
      const baseSlot = unsignedSafeInteger(await this.dispatch('getSlot', Object.freeze([
        Object.freeze({ commitment: 'finalized' as const }),
      ]), signal));
      const blockTimeRaw = await this.dispatch('getBlockTime', Object.freeze([baseSlot]), signal);
      const blockTimeMs = blockTimeRaw === null ? null : timestampSeconds(blockTimeRaw) * 1_000;
      const balance = contextValue(await this.dispatch('getBalance', Object.freeze([
        walletPublicKey,
        Object.freeze({ commitment: 'finalized' as const, minContextSlot: baseSlot }),
      ]), signal));
      const tokenProgram = await this.tokenAccounts(walletPublicKey,
        TOKEN_PROGRAM_ID.toBase58(), baseSlot, signal);
      const token2022 = await this.tokenAccounts(walletPublicKey,
        TOKEN_2022_PROGRAM_ID.toBase58(), baseSlot, signal);
      const slots = [BigInt(baseSlot), balance.slot, tokenProgram.slot, token2022.slot];
      const lowest = slots.reduce((left, right) => left < right ? left : right);
      const highest = slots.reduce((left, right) => left > right ? left : right);
      if (highest - lowest > BigInt(maximumSlotLag)) throw failure('SLOT_LAG_EXCEEDED');
      const observedAtMs = timestampMilliseconds(now());
      return Object.freeze({ slot: highest, blockTimeMs, observedAtMs,
        walletLamports: unsignedBigint(balance.value),
        tokenBalanceCount: tokenProgram.count + token2022.count });
    } catch (error) {
      if (error instanceof ReadinessRpcError) throw error;
      throw failure('INVALID_INPUT');
    }
  }

  private async tokenAccounts(
    walletPublicKey: string,
    programId: string,
    minimumSlot: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ slot: bigint; count: number }>> {
    const result = contextValue(await this.dispatch('getTokenAccountsByOwner', Object.freeze([
      walletPublicKey,
      Object.freeze({ programId }),
      Object.freeze({ commitment: 'finalized' as const, minContextSlot: minimumSlot,
        encoding: 'base64' as const, dataSlice: Object.freeze({ offset: 0, length: 0 }) }),
    ]), signal));
    if (!Array.isArray(result.value) || result.value.length > MAX_TOKEN_ACCOUNTS) {
      throw failure('RPC_RESPONSE_INVALID');
    }
    for (const item of result.value) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)
        || publicKey((item as Record<string, unknown>).pubkey) === '') {
        throw failure('RPC_RESPONSE_INVALID');
      }
    }
    return Object.freeze({ slot: result.slot, count: result.value.length });
  }

  private async dispatch(
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.assertSignal(signal);
    const requestId = ++this.#requestId;
    const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    let response: Response;
    try {
      response = await this.#fetch(this.#config.httpRpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#config.timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw failure('OPERATION_ABORTED');
      if (error instanceof DOMException && error.name === 'TimeoutError') throw failure('RPC_TIMEOUT');
      throw failure('RPC_UNAVAILABLE');
    }
    if (response.status === 429) throw failure('RPC_RATE_LIMITED');
    if (!response.ok) throw failure('RPC_UNAVAILABLE');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      throw failure('RPC_RESPONSE_TOO_LARGE');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw failure('RPC_RESPONSE_TOO_LARGE');
    }
    try {
      const envelope = JSON.parse(text) as unknown;
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new Error();
      const record = envelope as Record<string, unknown>;
      if (record.jsonrpc !== '2.0' || 'error' in record || !('result' in record)) throw new Error();
      return record.result;
    } catch {
      throw failure('RPC_RESPONSE_INVALID');
    }
  }

  private assertSignal(signal: AbortSignal): void {
    if (!(signal instanceof AbortSignal)) throw failure('INVALID_INPUT');
    if (signal.aborted) throw failure('OPERATION_ABORTED');
  }
}

function contextValue(value: unknown): Readonly<{ slot: bigint; value: unknown }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw failure('RPC_RESPONSE_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.context !== 'object' || record.context === null
    || Array.isArray(record.context) || !('value' in record)) throw failure('RPC_RESPONSE_INVALID');
  const slot = unsignedSafeInteger((record.context as Record<string, unknown>).slot);
  return Object.freeze({ slot: BigInt(slot), value: record.value });
}

function publicKey(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 64
      || new PublicKey(value).toBase58() !== value) throw new Error();
    return value;
  } catch {
    throw failure('RPC_RESPONSE_INVALID');
  }
}

function unsignedSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw failure('RPC_RESPONSE_INVALID');
  }
  return value as number;
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value === 'number') return BigInt(unsignedSafeInteger(value));
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw failure('RPC_RESPONSE_INVALID');
  }
  const result = BigInt(value);
  if (result > 18_446_744_073_709_551_615n) throw failure('RPC_RESPONSE_INVALID');
  return result;
}

function timestampSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000) throw failure('RPC_RESPONSE_INVALID');
  return value as number;
}

function timestampMilliseconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000) throw failure('INVALID_INPUT');
  return value as number;
}

function failure(code: ReadinessRpcErrorCode): ReadinessRpcError {
  return new ReadinessRpcError(code);
}


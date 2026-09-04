import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { ExecutionReconciliationGateway, FinalizedWalletDeltasV1, ObservedExecutionTransactionV1, WalletDeltaRequestV1 } from '../ports/execution-reconciliation-gateway.js';
import type { LiveConfirmationGateway, LiveSignatureObservationV1 } from '../executor-live/confirmation-worker.js';

export type LiveRecoveryRpcErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_ABORTED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_TIMEOUT'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_TOO_LARGE'
  | 'RPC_RESPONSE_INVALID'
  | 'GENESIS_MISMATCH'
  | 'CALL_BUDGET_EXCEEDED'
  | 'SESSION_FAILED';

export class LiveRecoveryRpcError extends Error {
  public constructor(public readonly code: LiveRecoveryRpcErrorCode) {
    super('Live recovery RPC operation failed.');
    this.name = 'LiveRecoveryRpcError';
  }
}

export interface SolanaFinalityRpcSessionConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
}

export interface LiveRecoveryGenesisEvidenceV1 {
  readonly providerId: string;
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
}

const MAX_RESPONSE_BYTES = 16_777_216;
const MAX_TRANSACTION_BYTES = 1_232;
const WSOL = 'So11111111111111111111111111111111111111112';
const INTERNAL_ERRORS = new WeakSet<LiveRecoveryRpcError>();

interface FinalizedTransactionObservation {
  readonly slot: bigint;
  readonly observedAtMs: number;
  readonly signature: string;
  readonly blockhash: string;
  readonly messageHash: string;
  readonly accountKeys: readonly string[];
  readonly feeLamports: bigint;
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokenBalances: ReadonlyMap<number, TokenBalance>;
  readonly postTokenBalances: ReadonlyMap<number, TokenBalance>;
}

interface TokenBalance {
  readonly mint: string;
  readonly owner: string | null;
  readonly amountRaw: bigint;
}

export class SolanaFinalityRpcSession
implements ExecutionReconciliationGateway, LiveConfirmationGateway {
  public readonly providerId: string;
  readonly #config: SolanaFinalityRpcSessionConfig;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #transactions = new Map<string, Promise<FinalizedTransactionObservation | null>>();
  #nextId = 1;
  #calls = 0;
  #failed = false;

  public constructor(
    config: SolanaFinalityRpcSessionConfig,
    fetchImplementation: typeof fetch = fetch,
    clock: () => number = Date.now,
  ) {
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(config.providerId)
        || !httpUrl(config.httpRpcUrl) || !publicKey(config.expectedGenesisHash)
        || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1
        || config.timeoutMs > 60_000 || !Number.isSafeInteger(config.maxCalls)
        || config.maxCalls < 1 || config.maxCalls > 16
        || typeof fetchImplementation !== 'function' || typeof clock !== 'function') invalid();
      this.#config = Object.freeze({ ...config });
      this.providerId = config.providerId;
      this.#fetch = fetchImplementation;
      this.#clock = clock;
    } catch (error) {
      if (isInternal(error)) throw error;
      throw rpcError('INVALID_INPUT');
    }
  }

  public async verifyGenesis(signal: AbortSignal): Promise<LiveRecoveryGenesisEvidenceV1> {
    this.requireReady(signal);
    const observedGenesisHash = publicKeyValue(await this.dispatch('getGenesisHash', [], signal));
    const evidence = Object.freeze({
      providerId: this.providerId,
      expectedGenesisHash: this.#config.expectedGenesisHash,
      observedGenesisHash,
    });
    if (observedGenesisHash !== this.#config.expectedGenesisHash) {
      this.#failed = true;
      throw rpcError('GENESIS_MISMATCH');
    }
    return evidence;
  }

  public async observeSignature(
    signature: string,
    signal: AbortSignal,
  ): Promise<LiveSignatureObservationV1> {
    const status = await this.signatureStatus(signature, signal);
    const observedAtMs = timestamp(this.#clock());
    if (status === null || status.confirmationStatus === 'processed') {
      return Object.freeze({ confirmationStatus: 'NOT_FOUND', observedSlot: null, observedAtMs });
    }
    return Object.freeze({
      confirmationStatus: status.confirmationStatus === 'finalized' ? 'FINALIZED' : 'CONFIRMED',
      observedSlot: status.slot,
      observedAtMs,
    });
  }

  public async readFinalizedBlockHeight(signal: AbortSignal): Promise<bigint> {
    this.requireReady(signal);
    return unsignedInteger(await this.dispatch(
      'getBlockHeight', [Object.freeze({ commitment: 'finalized' })], signal,
    ));
  }

  public async readSignatureHistory(
    signature: string,
    signal: AbortSignal,
  ): Promise<'PRESENT' | 'ABSENT' | 'UNKNOWN'> {
    return (await this.signatureStatus(signature, signal)) === null ? 'ABSENT' : 'PRESENT';
  }

  public async readNormalizedTransaction(
    signature: string,
    signal: AbortSignal,
  ): Promise<ObservedExecutionTransactionV1 | null> {
    const observed = await this.finalizedTransaction(signature, signal);
    if (observed === null) return null;
    return Object.freeze({
      signature: observed.signature,
      blockhash: observed.blockhash,
      messageHash: observed.messageHash,
    });
  }

  public async readFinalizedWalletDeltas(
    request: WalletDeltaRequestV1,
    signal: AbortSignal,
  ): Promise<FinalizedWalletDeltasV1> {
    validateWalletRequest(request);
    const observed = await this.finalizedTransaction(request.signature, signal);
    const observedAtMs = timestamp(this.#clock());
    if (observed === null) {
      return Object.freeze({
        confirmationStatus: 'NOT_FOUND', observedSlot: null,
        feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n,
        quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs, finalizedAtMs: null,
      });
    }
    const walletIndex = observed.accountKeys.indexOf(request.walletPublicKey);
    if (walletIndex < 0 || observed.preBalances[walletIndex] === undefined
      || observed.postBalances[walletIndex] === undefined) invalidResponse();
    const walletLamportDelta = observed.postBalances[walletIndex]
      - observed.preBalances[walletIndex];
    const base = tokenAmounts(observed, request.walletPublicKey, request.mint);
    const quoteDeltaRaw = request.quoteMint === WSOL
      ? walletLamportDelta + observed.feeLamports
      : tokenAmounts(observed, request.walletPublicKey, request.quoteMint).delta;
    return Object.freeze({
      confirmationStatus: 'FINALIZED',
      observedSlot: observed.slot,
      feeLamports: observed.feeLamports,
      walletLamportDelta,
      baseDeltaRaw: base.delta,
      quoteDeltaRaw,
      unexpectedResidualTokenBalanceRaw: request.side === 'SELL' ? base.post : 0n,
      observedAtMs,
      finalizedAtMs: observedAtMs,
    });
  }

  async signatureStatus(
    signatureValue: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ readonly slot: bigint; readonly confirmationStatus: string }> | null> {
    const signature = signatureValueOf(signatureValue);
    this.requireReady(signal);
    const raw = await this.dispatch('getSignatureStatuses', [
      Object.freeze([signature]), Object.freeze({ searchTransactionHistory: true }),
    ], signal);
    try {
      const root = record(raw);
      exactKeys(root, ['context', 'value']);
      contextSlot(root.context);
      if (!Array.isArray(root.value) || root.value.length !== 1) invalidResponse();
      const values = root.value as unknown[];
      const value: unknown = values[0];
      if (value === null) return null;
      const status = record(value);
      exactKeys(status, ['slot', 'confirmations', 'err', 'confirmationStatus']);
      const confirmationStatus = status.confirmationStatus;
      if (confirmationStatus !== 'processed' && confirmationStatus !== 'confirmed'
        && confirmationStatus !== 'finalized') invalidResponse();
      return Object.freeze({
        slot: unsignedInteger(status.slot),
        confirmationStatus,
      });
    } catch (error) {
      if (isInternal(error)) throw error;
      return invalidResponse();
    }
  }

  private finalizedTransaction(
    signatureValue: string,
    signal: AbortSignal,
  ): Promise<FinalizedTransactionObservation | null> {
    const signature = signatureValueOf(signatureValue);
    this.requireReady(signal);
    const existing = this.#transactions.get(signature);
    if (existing !== undefined) return existing;
    const pending = this.loadFinalizedTransaction(signature, signal);
    this.#transactions.set(signature, pending);
    void pending.then((value) => {
      if (value === null) this.#transactions.delete(signature);
    }, () => { this.#transactions.delete(signature); });
    return pending;
  }

  private async loadFinalizedTransaction(
    signature: string,
    signal: AbortSignal,
  ): Promise<FinalizedTransactionObservation | null> {
    const raw = await this.dispatch('getTransaction', [signature, Object.freeze({
      commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0,
    })], signal);
    if (raw === null) return null;
    try {
      const root = record(raw);
      exactKeys(root, ['slot', 'blockTime', 'transaction', 'meta']);
      const slot = unsignedInteger(root.slot);
      const tuple = root.transaction;
      if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[1] !== 'base64'
        || typeof tuple[0] !== 'string') invalidResponse();
      const bytes = Buffer.from(tuple[0], 'base64');
      if (bytes.length < 1 || bytes.length > MAX_TRANSACTION_BYTES
        || bytes.toString('base64') !== tuple[0]) invalidResponse();
      const transaction = VersionedTransaction.deserialize(bytes);
      const observedSignature = bs58.encode(transaction.signatures[0] ?? new Uint8Array());
      if (observedSignature !== signature) invalidResponse();
      const meta = record(root.meta);
      exactKeys(meta, [
        'err', 'fee', 'preBalances', 'postBalances',
        'preTokenBalances', 'postTokenBalances',
      ]);
      const accountKeys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
      const preBalances = balanceArray(meta.preBalances);
      const postBalances = balanceArray(meta.postBalances);
      if (preBalances.length !== postBalances.length || preBalances.length < accountKeys.length) {
        invalidResponse();
      }
      return Object.freeze({
        slot,
        observedAtMs: timestamp(this.#clock()),
        signature: observedSignature,
        blockhash: publicKeyValue(transaction.message.recentBlockhash),
        messageHash: createHash('sha256').update(transaction.message.serialize()).digest('hex'),
        accountKeys: Object.freeze(accountKeys),
        feeLamports: unsignedInteger(meta.fee),
        preBalances,
        postBalances,
        preTokenBalances: tokenBalanceMap(meta.preTokenBalances),
        postTokenBalances: tokenBalanceMap(meta.postTokenBalances),
      });
    } catch (error) {
      if (isInternal(error)) throw error;
      return invalidResponse();
    }
  }

  private async dispatch(
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.requireReady(signal);
    if (this.#calls >= this.#config.maxCalls) throw rpcError('CALL_BUDGET_EXCEEDED');
    this.#calls += 1;
    const id = this.#nextId;
    this.#nextId += 1;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { controller.abort(); }, this.#config.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#config.httpRpcUrl, {
        method: 'POST',
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: JSON.stringify(Object.freeze({ jsonrpc: '2.0', id, method, params })),
        signal: controller.signal,
      });
    } catch {
      if (signal.aborted) throw rpcError('OPERATION_ABORTED');
      if (controller.signal.aborted) throw rpcError('RPC_TIMEOUT');
      throw rpcError('RPC_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    if (response.status === 429) throw rpcError('RPC_RATE_LIMITED');
    if (!response.ok) throw rpcError('RPC_UNAVAILABLE');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length)
      || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))) throw rpcError('RPC_RESPONSE_TOO_LARGE');
    let text: string;
    try { text = await response.text(); } catch { throw rpcError('RPC_UNAVAILABLE'); }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw rpcError('RPC_RESPONSE_TOO_LARGE');
    }
    try {
      const envelope = record(JSON.parse(text) as unknown);
      if (Object.hasOwn(envelope, 'error')) {
        const rpcFailure = record(envelope.error);
        const code = rpcFailure.code;
        if (code === 429 || code === -32_005) throw rpcError('RPC_RATE_LIMITED');
        throw rpcError('RPC_UNAVAILABLE');
      }
      exactKeys(envelope, ['jsonrpc', 'id', 'result']);
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id) invalidResponse();
      return envelope.result;
    } catch (error) {
      if (isInternal(error)) throw error;
      return invalidResponse();
    }
  }

  private requireReady(signal: AbortSignal): void {
    if (!(signal instanceof AbortSignal)) throw rpcError('INVALID_INPUT');
    if (signal.aborted) throw rpcError('OPERATION_ABORTED');
    if (this.#failed) throw rpcError('SESSION_FAILED');
  }
}

function tokenAmounts(
  observed: FinalizedTransactionObservation,
  wallet: string,
  mint: string,
): Readonly<{ readonly pre: bigint; readonly post: bigint; readonly delta: bigint }> {
  let pre = 0n;
  let post = 0n;
  const indexes = new Set([
    ...observed.preTokenBalances.keys(), ...observed.postTokenBalances.keys(),
  ]);
  for (const index of indexes) {
    const before = observed.preTokenBalances.get(index);
    const after = observed.postTokenBalances.get(index);
    const identity = after ?? before;
    if (identity?.owner !== wallet || identity.mint !== mint) continue;
    if (before !== undefined && (before.owner !== wallet || before.mint !== mint)) invalidResponse();
    if (after !== undefined && (after.owner !== wallet || after.mint !== mint)) invalidResponse();
    pre += before?.amountRaw ?? 0n;
    post += after?.amountRaw ?? 0n;
  }
  return Object.freeze({ pre, post, delta: post - pre });
}

function tokenBalanceMap(value: unknown): ReadonlyMap<number, TokenBalance> {
  if (!Array.isArray(value) || value.length > 256) invalidResponse();
  const result = new Map<number, TokenBalance>();
  for (const item of value) {
    const row = record(item);
    exactKeys(row, ['accountIndex', 'mint', 'owner', 'uiTokenAmount']);
    const index = safeInteger(row.accountIndex);
    const amount = record(row.uiTokenAmount);
    if (!Object.hasOwn(amount, 'amount')) invalidResponse();
    if (result.has(index)) invalidResponse();
    result.set(index, Object.freeze({
      mint: publicKeyValue(row.mint),
      owner: row.owner === undefined || row.owner === null ? null : publicKeyValue(row.owner),
      amountRaw: decimalBigint(amount.amount),
    }));
  }
  return result;
}

function balanceArray(value: unknown): readonly bigint[] {
  if (!Array.isArray(value) || value.length > 512) invalidResponse();
  return Object.freeze(value.map(unsignedInteger));
}

function validateWalletRequest(value: WalletDeltaRequestV1): void {
  const side: unknown = value.side;
  if (!signatureValue(value.signature) || !publicKey(value.walletPublicKey)
    || !publicKey(value.mint) || !publicKey(value.quoteMint)
    || (side !== 'BUY' && side !== 'SELL')) invalid();
}

function signatureValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return bs58.decode(value).length === 64; } catch { return false; }
}

function signatureValueOf(value: unknown): string {
  if (!signatureValue(value)) invalid();
  return value as string;
}

function publicKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function publicKeyValue(value: unknown): string {
  if (!publicKey(value)) invalidResponse();
  return value as string;
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hash === '';
  } catch { return false; }
}

function contextSlot(value: unknown): bigint {
  const context = record(value);
  exactKeys(context, ['slot']);
  return unsignedInteger(context.slot);
}

function unsignedInteger(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  return invalidResponse();
}

function decimalBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) invalidResponse();
  return BigInt(value);
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || value > 8_640_000_000_000_000) invalidResponse();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalidResponse();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalidResponse();
  }
}

function invalid(): never { throw rpcError('INVALID_INPUT'); }
function invalidResponse(): never { throw rpcError('RPC_RESPONSE_INVALID'); }
function rpcError(code: LiveRecoveryRpcErrorCode): LiveRecoveryRpcError {
  const error = new LiveRecoveryRpcError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}
function isInternal(value: unknown): value is LiveRecoveryRpcError {
  return value instanceof LiveRecoveryRpcError && INTERNAL_ERRORS.has(value);
}

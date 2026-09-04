import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type {
  ExecutionLiveGateway,
  ExecutionRawSubmissionRequestV1,
  ExecutionSignedSimulationRequestV1,
  ExecutionSignedSimulationResultV1,
} from '../ports/execution-live-gateway.js';

export type LiveRpcErrorCode =
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

export class LiveRpcError extends Error {
  public constructor(public readonly code: LiveRpcErrorCode) {
    super('Live RPC operation failed.');
    this.name = 'LiveRpcError';
  }
}

export interface SolanaLiveRpcSessionConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
}

export interface LiveRpcGenesisEvidenceV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
}

export interface LiveRpcBlockhashValidityV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly blockhash: string;
  readonly valid: true;
  readonly contextSlot: bigint;
  readonly observedBlockHeight: bigint;
}

export interface LiveRpcUsageV1 {
  readonly providerId: string;
  readonly rpcCallsUsed: number;
  readonly rpcCallsLimit: number;
}

interface ValidatedConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
}

interface JsonRpcEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

interface ContextValue {
  readonly contextSlot: bigint;
  readonly value: unknown;
}

interface ParsedAccount {
  readonly lamports: bigint;
  readonly owner: string;
  readonly executable: false;
  readonly data: Uint8Array;
}

interface ParsedTokenAccount extends ParsedAccount {
  readonly tokenProgram: string;
  readonly mint: string;
  readonly holder: string;
  readonly amount: bigint;
}

interface SimulationAccounts {
  readonly payer: ParsedAccount;
  readonly base: ParsedTokenAccount | null;
  readonly quote: ParsedTokenAccount | null;
}

const CONFIG_KEYS = Object.freeze([
  'providerId', 'httpRpcUrl', 'expectedGenesisHash', 'timeoutMs', 'maxCalls',
] as const);
const SIGNED_SIMULATION_KEYS = Object.freeze([
  'payloadVersion', 'transactionBase64', 'snapshotSlot', 'accountAddresses',
  'commitment', 'sigVerify', 'replaceRecentBlockhash',
] as const);
const SUBMISSION_KEYS = Object.freeze([
  'payloadVersion', 'transactionBase64', 'skipPreflight', 'maxRetries',
  'preflightCommitment',
] as const);
const ACCOUNT_KEYS = Object.freeze([
  'lamports', 'owner', 'executable', 'rentEpoch', 'space', 'data',
] as const);
const SIMULATION_VALUE_KEYS = Object.freeze([
  'err', 'logs', 'unitsConsumed', 'accounts', 'returnData',
  'innerInstructions', 'loadedAccountsDataSize', 'replacementBlockhash',
] as const);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const SPL_TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(),
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_ACCOUNT_DATA_BYTES = 65_536;
const MAX_LOG_LINES = 256;
const MAX_LOG_BYTES = 1_024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 512;
export const LIVE_RPC_MAX_REQUEST_BYTES = 16_384;
export const LIVE_RPC_MAX_RESPONSE_BYTES = 1_048_576;
const INTERNAL_ERRORS = new WeakSet<LiveRpcError>();

export class SolanaLiveRpcSession implements ExecutionLiveGateway {
  public readonly providerId: string;
  readonly #config: ValidatedConfig;
  readonly #fetch: typeof fetch;
  #callsUsed = 0;
  #failed = false;
  #genesisReserved = false;
  #genesisEvidence: LiveRpcGenesisEvidenceV1 | null = null;
  #simulationReserved = false;
  #blockhashReserved = false;
  #submissionReserved = false;

  public constructor(
    configValue: SolanaLiveRpcSessionConfig,
    fetchImplementation: typeof fetch = fetch,
  ) {
    try {
      this.#config = configFrom(configValue);
      if (typeof fetchImplementation !== 'function' || isProxy(fetchImplementation)) {
        throw new TypeError();
      }
      this.#fetch = fetchImplementation;
      this.providerId = this.#config.providerId;
    } catch {
      throw rpcError('INVALID_INPUT');
    }
  }

  public async verifyGenesis(signal: AbortSignal): Promise<LiveRpcGenesisEvidenceV1> {
    this.requireSession(signal);
    if (this.#genesisEvidence !== null) return this.#genesisEvidence;
    if (this.#genesisReserved) throw this.fail('INVALID_INPUT');
    this.#genesisReserved = true;
    const result = await this.dispatch('getGenesisHash', Object.freeze([]), signal);
    let observedGenesisHash: string;
    try {
      observedGenesisHash = publicKey(result);
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    const evidence = Object.freeze({
      payloadVersion: 1 as const,
      providerId: this.providerId,
      expectedGenesisHash: this.#config.expectedGenesisHash,
      observedGenesisHash,
    });
    if (observedGenesisHash !== this.#config.expectedGenesisHash) {
      throw this.fail('GENESIS_MISMATCH');
    }
    this.#genesisEvidence = evidence;
    return evidence;
  }

  public async simulateSignedTransaction(
    requestValue: ExecutionSignedSimulationRequestV1,
    signal: AbortSignal,
  ): Promise<ExecutionSignedSimulationResultV1> {
    this.requireReady(signal);
    if (this.#simulationReserved) throw this.fail('INVALID_INPUT');
    let request: ExecutionSignedSimulationRequestV1;
    try {
      request = signedSimulationRequest(requestValue);
    } catch {
      throw this.fail('INVALID_INPUT');
    }
    this.#simulationReserved = true;
    const addresses = Object.freeze([...request.accountAddresses]);
    const preRaw = await this.dispatch('getMultipleAccounts', Object.freeze([
      addresses,
      Object.freeze({
        encoding: 'base64' as const,
        commitment: 'confirmed' as const,
        minContextSlot: Number(request.snapshotSlot),
      }),
    ]), signal);
    let preContext: ContextValue;
    let pre: SimulationAccounts;
    try {
      preContext = contextValue(preRaw);
      if (preContext.contextSlot < request.snapshotSlot) throw new TypeError();
      pre = simulationAccounts(preContext.value, request.accountAddresses);
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    const simulatedRaw = await this.dispatch('simulateTransaction', Object.freeze([
      request.transactionBase64,
      Object.freeze({
        encoding: 'base64' as const,
        commitment: 'confirmed' as const,
        sigVerify: true as const,
        replaceRecentBlockhash: false as const,
        minContextSlot: Number(request.snapshotSlot),
        accounts: Object.freeze({
          encoding: 'base64' as const,
          addresses,
        }),
      }),
    ]), signal);
    try {
      const simulated = contextValue(simulatedRaw);
      if (simulated.contextSlot < preContext.contextSlot) throw new TypeError();
      const value = plainRecord(simulated.value);
      knownKeys(value, SIMULATION_VALUE_KEYS, [
        'err', 'logs', 'unitsConsumed', 'accounts',
      ]);
      validateSupplementarySimulationFields(value);
      const post = simulationAccounts(value.accounts, request.accountAddresses);
      const logs = simulationLogs(value.logs);
      const unitsConsumed = positiveSafeIntegerBigint(value.unitsConsumed);
      const failureKind = simulationFailure(value.err);
      const baseDeltaRaw = tokenDelta(pre.base, post.base);
      const quoteDeltaRaw = tokenDelta(pre.quote, post.quote);
      const baseIdentity = pre.base ?? post.base;
      const quoteIdentity = pre.quote ?? post.quote;
      if (baseIdentity === null || quoteIdentity === null
        || baseIdentity.mint === quoteIdentity.mint
        || quoteIdentity.mint !== NATIVE_MINT.toBase58()) {
        throw new TypeError();
      }
      const feePayerLamportDebit = pre.payer.lamports > post.payer.lamports
        ? pre.payer.lamports - post.payer.lamports : 0n;
      return Object.freeze({
        payloadVersion: 1,
        providerId: this.providerId,
        contextSlot: simulated.contextSlot,
        failureKind,
        unitsConsumed,
        feePayerLamportDebit,
        baseDeltaRaw,
        quoteDeltaRaw,
        logsFingerprint: sha256(lengthPrefixedUtf8([
          'execution-simulation-logs-v1', ...logs,
        ])),
        logsLineCount: logs.length,
      });
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw this.fail('RPC_RESPONSE_INVALID');
    }
  }

  public async blockhashValidity(
    blockhashValue: string,
    signal: AbortSignal,
  ): Promise<LiveRpcBlockhashValidityV1> {
    this.requireReady(signal);
    if (this.#blockhashReserved) throw this.fail('INVALID_INPUT');
    let blockhash: string;
    try {
      blockhash = publicKey(blockhashValue);
    } catch {
      throw this.fail('INVALID_INPUT');
    }
    this.#blockhashReserved = true;
    const validityRaw = await this.dispatch('isBlockhashValid', Object.freeze([
      blockhash,
      Object.freeze({ commitment: 'confirmed' as const }),
    ]), signal);
    let contextSlot: bigint;
    try {
      const validity = contextValue(validityRaw);
      if (validity.value !== true) throw new TypeError();
      contextSlot = validity.contextSlot;
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    const heightRaw = await this.dispatch('getBlockHeight', Object.freeze([
      Object.freeze({ commitment: 'confirmed' as const }),
    ]), signal);
    let observedBlockHeight: bigint;
    try {
      observedBlockHeight = safeIntegerBigint(heightRaw);
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    return Object.freeze({
      payloadVersion: 1,
      providerId: this.providerId,
      blockhash,
      valid: true,
      contextSlot,
      observedBlockHeight,
    });
  }

  public async sendRawTransaction(
    requestValue: ExecutionRawSubmissionRequestV1,
    signal: AbortSignal,
  ): Promise<Readonly<{ readonly signature: string }>> {
    this.requireReady(signal);
    if (this.#submissionReserved) throw this.fail('INVALID_INPUT');
    let request: ExecutionRawSubmissionRequestV1;
    try {
      request = submissionRequest(requestValue);
    } catch {
      throw this.fail('INVALID_INPUT');
    }
    this.#submissionReserved = true;
    const result = await this.dispatch('sendTransaction', Object.freeze([
      request.transactionBase64,
      Object.freeze({
        encoding: 'base64' as const,
        skipPreflight: true as const,
        maxRetries: 0 as const,
        preflightCommitment: 'confirmed' as const,
      }),
    ]), signal);
    let signature: string;
    try {
      signature = canonicalSignature(result);
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    return Object.freeze({ signature });
  }

  public usage(): LiveRpcUsageV1 {
    return Object.freeze({
      providerId: this.providerId,
      rpcCallsUsed: this.#callsUsed,
      rpcCallsLimit: this.#config.maxCalls,
    });
  }

  private requireSession(signal: unknown): asserts signal is AbortSignal {
    if (!(signal instanceof AbortSignal)) throw this.fail('INVALID_INPUT');
    if (this.#failed) throw rpcError('SESSION_FAILED');
    if (signal.aborted) throw this.fail('OPERATION_ABORTED');
  }

  private requireReady(signal: unknown): asserts signal is AbortSignal {
    this.requireSession(signal);
    if (this.#genesisEvidence === null) throw this.fail('INVALID_INPUT');
  }

  private async dispatch(
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.requireSession(signal);
    if (this.#callsUsed >= this.#config.maxCalls) {
      throw this.fail('CALL_BUDGET_EXCEEDED');
    }
    this.#callsUsed += 1;
    const id = this.#callsUsed;
    const envelope: JsonRpcEnvelope = Object.freeze({
      jsonrpc: '2.0', id, method, params,
    });
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body, 'utf8') > LIVE_RPC_MAX_REQUEST_BYTES) {
      throw this.fail('INVALID_INPUT');
    }
    let text: string;
    try {
      text = await this.withDeadline(async (deadlineSignal) => {
        const fetched = await this.#fetch(this.#config.httpRpcUrl, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal: deadlineSignal,
        });
        if (!(fetched instanceof Response)) throw this.fail('RPC_RESPONSE_INVALID');
        if (fetched.status === 429) {
          cancelResponseBody(fetched);
          throw this.fail('RPC_RATE_LIMITED');
        }
        if (fetched.status < 200 || fetched.status >= 300) {
          cancelResponseBody(fetched);
          throw this.fail('RPC_UNAVAILABLE');
        }
        const contentLength = fetched.headers.get('content-length');
        if (contentLength !== null) {
          if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
            cancelResponseBody(fetched);
            throw this.fail('RPC_RESPONSE_INVALID');
          }
          if (BigInt(contentLength) > BigInt(LIVE_RPC_MAX_RESPONSE_BYTES)) {
            cancelResponseBody(fetched);
            throw this.fail('RPC_RESPONSE_TOO_LARGE');
          }
        }
        try {
          return await readBoundedResponse(fetched, deadlineSignal);
        } catch (error) {
          if (isInternalError(error)) throw error;
          if (error instanceof ResponseTooLargeError) {
            throw this.fail('RPC_RESPONSE_TOO_LARGE');
          }
          throw this.fail('RPC_RESPONSE_INVALID');
        }
      }, signal);
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw this.fail('RPC_UNAVAILABLE');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw this.fail('RPC_RESPONSE_INVALID');
    }
    try {
      const response = plainRecord(decoded);
      if (response.jsonrpc !== '2.0' || response.id !== id) throw new TypeError();
      const keys = enumerableDataKeys(response);
      if (keys.length !== 3) throw new TypeError();
      if (keys.includes('result') && !keys.includes('error')) return response.result;
      if (!keys.includes('error') || keys.includes('result')) throw new TypeError();
      const rpcFailure = plainRecord(response.error);
      knownKeys(rpcFailure, ['code', 'message', 'data'], ['code', 'message']);
      if (!Number.isSafeInteger(rpcFailure.code)
        || typeof rpcFailure.message !== 'string'
        || Buffer.byteLength(rpcFailure.message, 'utf8') > 1_024) {
        throw new TypeError();
      }
      if (rpcFailure.data !== undefined) {
        boundedJson(rpcFailure.data, 0, { nodes: 0 });
      }
      if (rpcFailure.code === 429) throw this.fail('RPC_RATE_LIMITED');
      throw this.fail('RPC_UNAVAILABLE');
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw this.fail('RPC_RESPONSE_INVALID');
    }
  }

  private async withDeadline<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    callerSignal: AbortSignal,
  ): Promise<Value> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        deadline.abort();
        reject(this.fail('RPC_TIMEOUT'));
      }, this.#config.timeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = (): void => {
        deadline.abort();
        reject(this.fail('OPERATION_ABORTED'));
      };
      callerSignal.addEventListener('abort', abortListener, { once: true });
    });
    const operationPromise = operation(deadline.signal);
    void operationPromise.catch(() => undefined);
    try {
      return await Promise.race([operationPromise, timeoutPromise, abortPromise]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener !== undefined) {
        callerSignal.removeEventListener('abort', abortListener);
      }
    }
  }

  private fail(code: LiveRpcErrorCode): LiveRpcError {
    this.#failed = true;
    return rpcError(code);
  }
}

class ResponseTooLargeError extends Error {}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) throw new TypeError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let item = await reader.read();
    while (!item.done) {
      if (!(item.value instanceof Uint8Array)) throw new TypeError();
      total += item.value.byteLength;
      if (total > LIVE_RPC_MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* Preserve the size error. */ }
        throw new ResponseTooLargeError();
      }
      chunks.push(item.value);
      item = await reader.read();
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function cancelResponseBody(response: Response): void {
  if (response.body === null) return;
  try { void response.body.cancel().catch(() => undefined); } catch { /* Best effort. */ }
}

function configFrom(value: unknown): ValidatedConfig {
  const record = exactFrozenRecord(value, CONFIG_KEYS);
  const providerId = boundedText(record.providerId, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(providerId)
    || typeof record.httpRpcUrl !== 'string'
    || record.httpRpcUrl.length === 0
    || Buffer.byteLength(record.httpRpcUrl, 'utf8') > 4_096) {
    throw new TypeError();
  }
  const url = new URL(record.httpRpcUrl);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash.length > 0) {
    throw new TypeError();
  }
  return Object.freeze({
    providerId,
    httpRpcUrl: record.httpRpcUrl,
    expectedGenesisHash: publicKey(record.expectedGenesisHash),
    timeoutMs: boundedInteger(record.timeoutMs, 1, 60_000),
    maxCalls: boundedInteger(record.maxCalls, 1, 16),
  });
}

function signedSimulationRequest(value: unknown): ExecutionSignedSimulationRequestV1 {
  const record = exactFrozenRecord(value, SIGNED_SIMULATION_KEYS);
  if (record.payloadVersion !== 1 || record.commitment !== 'confirmed'
    || record.sigVerify !== true || record.replaceRecentBlockhash !== false
    || typeof record.snapshotSlot !== 'bigint'
    || record.snapshotSlot < 0n || record.snapshotSlot > MAX_SAFE_BIGINT) {
    throw new TypeError();
  }
  const addresses = publicKeyTuple(record.accountAddresses);
  return Object.freeze({
    payloadVersion: 1,
    transactionBase64: canonicalBase64(
      record.transactionBase64, MAX_TRANSACTION_BYTES, false,
    ),
    snapshotSlot: record.snapshotSlot,
    accountAddresses: addresses,
    commitment: 'confirmed',
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
}

function submissionRequest(value: unknown): ExecutionRawSubmissionRequestV1 {
  const record = exactFrozenRecord(value, SUBMISSION_KEYS);
  if (record.payloadVersion !== 1 || record.skipPreflight !== true
    || record.maxRetries !== 0 || record.preflightCommitment !== 'confirmed') {
    throw new TypeError();
  }
  return Object.freeze({
    payloadVersion: 1,
    transactionBase64: canonicalBase64(
      record.transactionBase64, MAX_TRANSACTION_BYTES, false,
    ),
    skipPreflight: true,
    maxRetries: 0,
    preflightCommitment: 'confirmed',
  });
}

function publicKeyTuple(value: unknown): readonly [string, string, string] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) {
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || !['0', '1', '2', 'length'].every((key) => keys.includes(key))) {
    throw new TypeError();
  }
  const addresses = value.map((candidate) => publicKey(candidate));
  if (new Set(addresses).size !== 3) throw new TypeError();
  const [payer, base, quote] = addresses;
  if (payer === undefined || base === undefined || quote === undefined) throw new TypeError();
  return Object.freeze([payer, base, quote]);
}

function contextValue(value: unknown): ContextValue {
  const record = plainRecord(value);
  exactKeys(record, ['context', 'value']);
  const context = plainRecord(record.context);
  knownKeys(context, ['slot', 'apiVersion'], ['slot']);
  if (context.apiVersion !== undefined
    && (typeof context.apiVersion !== 'string'
      || Buffer.byteLength(context.apiVersion, 'utf8') > 64)) {
    throw new TypeError();
  }
  return Object.freeze({
    contextSlot: safeIntegerBigint(context.slot),
    value: record.value,
  });
}

function simulationAccounts(
  value: unknown,
  addresses: readonly [string, string, string],
): SimulationAccounts {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError();
  const payer = accountFrom(value[0]);
  if (payer?.owner !== SYSTEM_PROGRAM || payer.data.byteLength !== 0) {
    throw new TypeError();
  }
  const base = tokenAccountFrom(value[1], addresses[0]);
  const quote = tokenAccountFrom(value[2], addresses[0]);
  return Object.freeze({ payer, base, quote });
}

function accountFrom(value: unknown): ParsedAccount | null {
  if (value === null) return null;
  const record = plainRecord(value);
  exactKeys(record, ACCOUNT_KEYS);
  if (record.executable !== false || !Array.isArray(record.data)
    || record.data.length !== 2 || record.data[1] !== 'base64') {
    throw new TypeError();
  }
  const data = Buffer.from(canonicalBase64(
    record.data[0], MAX_ACCOUNT_DATA_BYTES, true,
  ), 'base64');
  const space = safeIntegerBigint(record.space);
  if (space !== BigInt(data.byteLength)) throw new TypeError();
  void safeIntegerBigint(record.rentEpoch);
  return Object.freeze({
    lamports: safeIntegerBigint(record.lamports),
    owner: publicKey(record.owner),
    executable: false,
    data: Uint8Array.from(data),
  });
}

function tokenAccountFrom(value: unknown, expectedHolder: string): ParsedTokenAccount | null {
  const account = accountFrom(value);
  if (account === null) return null;
  if (!SPL_TOKEN_PROGRAMS.has(account.owner) || account.data.byteLength < 165
    || account.data[108] !== 1) {
    throw new TypeError();
  }
  const mint = new PublicKey(account.data.slice(0, 32)).toBase58();
  const holder = new PublicKey(account.data.slice(32, 64)).toBase58();
  if (holder !== expectedHolder) throw new TypeError();
  const amount = Buffer.from(account.data).readBigUInt64LE(64);
  return Object.freeze({
    ...account,
    tokenProgram: account.owner,
    mint,
    holder,
    amount,
  });
}

function tokenDelta(
  before: ParsedTokenAccount | null,
  after: ParsedTokenAccount | null,
): bigint {
  const identity = before ?? after;
  if (identity === null) throw new TypeError();
  if (before !== null && (before.tokenProgram !== identity.tokenProgram
    || before.mint !== identity.mint || before.holder !== identity.holder)) {
    throw new TypeError();
  }
  if (after !== null && (after.tokenProgram !== identity.tokenProgram
    || after.mint !== identity.mint || after.holder !== identity.holder)) {
    throw new TypeError();
  }
  const delta = (after?.amount ?? 0n) - (before?.amount ?? 0n);
  if (delta < I64_MIN || delta > I64_MAX) throw new TypeError();
  return delta;
}

function simulationFailure(value: unknown): 'PROGRAM_ERROR' | 'BLOCKHASH_NOT_FOUND' | null {
  if (value === null) return null;
  boundedJson(value, 0, { nodes: 0 });
  return value === 'BlockhashNotFound' ? 'BLOCKHASH_NOT_FOUND' : 'PROGRAM_ERROR';
}

function simulationLogs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LOG_LINES) throw new TypeError();
  return Object.freeze(value.map((line) => boundedText(line, MAX_LOG_BYTES)));
}

function validateSupplementarySimulationFields(value: Record<string, unknown>): void {
  if (value.returnData !== undefined && value.returnData !== null) {
    boundedJson(value.returnData, 0, { nodes: 0 });
  }
  if (value.innerInstructions !== undefined && value.innerInstructions !== null) {
    boundedJson(value.innerInstructions, 0, { nodes: 0 });
  }
  if (value.loadedAccountsDataSize !== undefined) {
    void boundedInteger(value.loadedAccountsDataSize, 0, 0xffff_ffff);
  }
  if (value.replacementBlockhash !== undefined && value.replacementBlockhash !== null) {
    throw new TypeError();
  }
}

function canonicalSignature(value: unknown): string {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) {
    throw new TypeError();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!BASE58_ALPHABET.includes(value.charAt(index))) throw new TypeError();
  }
  const decoded = bs58.decode(value);
  if (decoded.byteLength !== 64 || bs58.encode(decoded) !== value) throw new TypeError();
  return value;
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) {
    throw new TypeError();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!BASE58_ALPHABET.includes(value.charAt(index))) throw new TypeError();
  }
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new TypeError();
  return value;
}

function canonicalBase64(
  value: unknown,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)) {
    throw new TypeError();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > maximumBytes || decoded.toString('base64') !== value) {
    throw new TypeError();
  }
  return value;
}

function safeIntegerBigint(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new TypeError();
  }
  return BigInt(value as number);
}

function positiveSafeIntegerBigint(value: unknown): bigint {
  const result = safeIntegerBigint(value);
  if (result === 0n) throw new TypeError();
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum || Object.is(value, -0)) {
    throw new TypeError();
  }
  return value as number;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new TypeError();
  }
  return value;
}

function boundedJson(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) throw new TypeError();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 4_096) throw new TypeError();
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new TypeError();
    for (const item of value) boundedJson(item, depth + 1, state);
    return;
  }
  const record = plainRecord(value);
  const keys = enumerableDataKeys(record);
  if (keys.length > 64) throw new TypeError();
  for (const key of keys) {
    if (Buffer.byteLength(key, 'utf8') > 128) throw new TypeError();
    boundedJson(record[key], depth + 1, state);
  }
}

function exactFrozenRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || !Object.isFrozen(value)) {
    throw new TypeError();
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const record = value as Record<string, unknown>;
  exactKeys(record, expectedKeys);
  return record;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError();
  }
  void enumerableDataKeys(value as Record<string, unknown>);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = enumerableDataKeys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError();
  }
}

function knownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const keys = enumerableDataKeys(record);
  if (keys.some((key) => !allowed.includes(key))
    || required.some((key) => !keys.includes(key))) {
    throw new TypeError();
  }
}

function enumerableDataKeys(record: Record<string, unknown>): string[] {
  const keys = Reflect.ownKeys(record);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    result.push(key);
  }
  return result;
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    return [length, bytes];
  }));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rpcError(code: LiveRpcErrorCode): LiveRpcError {
  const error = new LiveRpcError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}

function isInternalError(value: unknown): value is LiveRpcError {
  return value instanceof LiveRpcError && INTERNAL_ERRORS.has(value);
}

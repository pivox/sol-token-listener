import { isProxy } from 'node:util/types';
import type {
  ExecutionAccountSnapshot,
  ExecutionGenesisEvidence,
  ExecutionInnerInstruction,
  ExecutionInnerInstructionGroup,
  ExecutionLatestBlockhash,
  ExecutionMarketGateway,
  ExecutionMessageFee,
  ExecutionProviderUsage,
  ExecutionRpcAccount,
  ExecutionSimulationFailureKind,
  ExecutionUnsignedSimulationRequest,
  ExecutionUnsignedSimulationResult,
} from '../ports/execution-market-gateway.js';

export type ExecutionProviderSessionErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_ABORTED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_TIMEOUT'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_INVALID'
  | 'GENESIS_MISMATCH';

export class ExecutionProviderSessionError extends Error {
  public constructor(
    public readonly code: ExecutionProviderSessionErrorCode,
    public readonly genesisEvidence: ExecutionGenesisEvidence | null = null,
  ) {
    super('Execution provider session operation failed.');
    this.name = 'ExecutionProviderSessionError';
  }
}

export interface ProviderAffineSessionConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly maxSnapshotSlotLag: number;
}

const CONFIG_KEYS = Object.freeze([
  'providerId', 'httpRpcUrl', 'expectedGenesisHash', 'timeoutMs', 'maxCalls',
  'maxSnapshotSlotLag',
] as const);
const SIMULATION_REQUEST_KEYS = Object.freeze([
  'transactionBase64', 'snapshotSlot', 'accountAddresses',
] as const);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DATE_MAX_TIMEOUT_MS = 60_000;
const INT32_MAX = 2_147_483_647;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX_AS_NUMBER = Number((1n << 64n) - 1n);
const MAX_ACCOUNT_COUNT = 100;
const MAX_ACCOUNT_DATA_BYTES = 1_048_576;
const MAX_RPC_RESPONSE_BYTES = 16_777_216;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_LOG_LINES = 256;
const MAX_LOG_BYTES = 1_024;
const MAX_INNER_GROUPS = 64;
const MAX_INNER_INSTRUCTIONS = 256;
const MAX_INSTRUCTION_ACCOUNTS = 64;
const MAX_INSTRUCTION_DATA_LENGTH = 2_048;
const MAX_RETURN_DATA_BYTES = 1_048_576;
const INTERNAL_ERRORS = new WeakSet<ExecutionProviderSessionError>();

interface ValidatedConfig {
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly maxSnapshotSlotLag: number;
}

interface RpcContextValue {
  readonly contextSlot: bigint;
  readonly value: unknown;
}

export class ProviderAffineSession implements ExecutionMarketGateway {
  public readonly providerId: string;
  private readonly config: ValidatedConfig;
  private readonly fetchImplementation: typeof fetch;
  private callsUsed = 0;
  private genesisEvidence: ExecutionGenesisEvidence | null = null;
  private genesisReserved = false;
  private failed = false;
  private snapshotSlot: bigint | null = null;
  private snapshotReserved = false;
  private blockhashContextSlot: bigint | null = null;
  private blockhashReserved = false;
  private feeContextSlot: bigint | null = null;
  private feeReserved = false;
  private simulationCompleted = false;
  private simulationReserved = false;
  private readonly issuedSnapshots = new WeakSet();

  public constructor(
    configValue: ProviderAffineSessionConfig,
    fetchImplementation: typeof fetch = fetch,
  ) {
    try {
      this.config = configInput(configValue);
      if (typeof fetchImplementation !== 'function') throw inputError();
      this.fetchImplementation = fetchImplementation;
      this.providerId = this.config.providerId;
    } catch { throw inputError(); }
  }

  public async verifyGenesis(signal: AbortSignal): Promise<ExecutionGenesisEvidence> {
    validateSignal(signal);
    if (this.failed) throw inputError();
    if (this.genesisEvidence !== null) return this.genesisEvidence;
    if (this.genesisReserved) throw inputError();
    this.genesisReserved = true;
    const observedValue = await this.dispatch('getGenesisHash', Object.freeze([]), signal);
    let observedGenesisHash: string;
    try { observedGenesisHash = publicKey(observedValue); } catch { this.failInvalidResponse(); }
    const evidence = Object.freeze({
      providerId: this.providerId,
      expectedGenesisHash: this.config.expectedGenesisHash,
      observedGenesisHash,
    });
    if (observedGenesisHash !== this.config.expectedGenesisHash) {
      this.failed = true;
      throw sessionError('GENESIS_MISMATCH', evidence);
    }
    this.genesisEvidence = evidence;
    return evidence;
  }

  public ownsAccountSnapshot(snapshot: ExecutionAccountSnapshot): boolean {
    return this.issuedSnapshots.has(snapshot);
  }

  public async readAccountSnapshot(
    addressesValue: readonly string[],
    signal: AbortSignal,
  ): Promise<ExecutionAccountSnapshot> {
    const addresses = addressList(addressesValue, false);
    this.requireReady(signal);
    if (this.snapshotReserved || this.snapshotSlot !== null) throw inputError();
    this.snapshotReserved = true;
    const raw = await this.dispatch('getMultipleAccounts', Object.freeze([
      addresses,
      Object.freeze({ encoding: 'base64', commitment: 'confirmed' }),
    ]), signal);
    try {
      const contextual = contextValue(raw);
      if (!Array.isArray(contextual.value) || contextual.value.length !== addresses.length) {
        throw new Error();
      }
      const accounts = contextual.value.map((value, index) => {
        const address = addresses[index];
        if (address === undefined) throw new Error();
        return value === null ? null : accountFrom(value, address);
      });
      const result = Object.freeze({
        providerId: this.providerId,
        slot: contextual.contextSlot,
        addresses,
        accounts: Object.freeze(accounts),
      });
      this.issuedSnapshots.add(result);
      this.snapshotSlot = contextual.contextSlot;
      return result;
    } catch { return this.failInvalidResponse(); }
  }

  public async getLatestBlockhash(
    snapshotSlotValue: bigint,
    signal: AbortSignal,
  ): Promise<ExecutionLatestBlockhash> {
    const snapshotSlot = requestSlot(snapshotSlotValue);
    this.requireReady(signal);
    this.requireExactSnapshot(snapshotSlot);
    if (this.blockhashReserved || this.blockhashContextSlot !== null || this.feeContextSlot !== null
      || this.simulationCompleted) throw inputError();
    this.blockhashReserved = true;
    const raw = await this.dispatch('getLatestBlockhash', Object.freeze([Object.freeze({
      commitment: 'confirmed', minContextSlot: Number(snapshotSlot),
    })]), signal);
    try {
      const contextual = contextValue(raw);
      if (contextual.contextSlot < snapshotSlot
        || contextual.contextSlot - snapshotSlot > BigInt(this.config.maxSnapshotSlotLag)) {
        throw new Error();
      }
      const value = plainRecord(contextual.value);
      exactKeys(value, ['blockhash', 'lastValidBlockHeight']);
      const result = Object.freeze({
        providerId: this.providerId,
        contextSlot: contextual.contextSlot,
        blockhash: publicKey(value.blockhash),
        lastValidBlockHeight: safeIntegerBigint(value.lastValidBlockHeight, false),
      });
      this.blockhashContextSlot = contextual.contextSlot;
      return result;
    } catch { return this.failInvalidResponse(); }
  }

  public async getFeeForMessage(
    messageBase64Value: string,
    snapshotSlotValue: bigint,
    signal: AbortSignal,
  ): Promise<ExecutionMessageFee> {
    const messageBase64 = base64(messageBase64Value, MAX_TRANSACTION_BYTES, false);
    const snapshotSlot = requestSlot(snapshotSlotValue);
    this.requireReady(signal);
    this.requireExactSnapshot(snapshotSlot);
    if (this.blockhashContextSlot === null || this.feeReserved || this.feeContextSlot !== null
      || this.simulationCompleted) throw inputError();
    this.feeReserved = true;
    const raw = await this.dispatch('getFeeForMessage', Object.freeze([
      messageBase64,
      Object.freeze({ commitment: 'confirmed', minContextSlot: Number(snapshotSlot) }),
    ]), signal);
    try {
      const contextual = contextValue(raw);
      if (contextual.contextSlot < snapshotSlot) throw new Error();
      const feeLamports = contextual.value === null
        ? null : safeIntegerBigint(contextual.value, false);
      const result = Object.freeze({
        providerId: this.providerId,
        contextSlot: contextual.contextSlot,
        feeLamports,
      });
      this.feeContextSlot = contextual.contextSlot;
      return result;
    } catch { return this.failInvalidResponse(); }
  }

  public async simulateUnsignedTransaction(
    requestValue: ExecutionUnsignedSimulationRequest,
    signal: AbortSignal,
  ): Promise<ExecutionUnsignedSimulationResult> {
    const request = simulationRequest(requestValue);
    this.requireReady(signal);
    this.requireExactSnapshot(request.snapshotSlot);
    if (this.blockhashContextSlot === null || this.feeContextSlot === null
      || this.simulationReserved
      || this.simulationCompleted) throw inputError();
    this.simulationReserved = true;
    const raw = await this.dispatch('simulateTransaction', Object.freeze([
      request.transactionBase64,
      Object.freeze({
        encoding: 'base64', commitment: 'confirmed', sigVerify: false,
        replaceRecentBlockhash: false, minContextSlot: Number(request.snapshotSlot),
        innerInstructions: true,
        accounts: Object.freeze({
          encoding: 'base64', addresses: request.accountAddresses,
        }),
      }),
    ]), signal);
    try {
      const contextual = contextValue(raw);
      if (contextual.contextSlot < this.blockhashContextSlot) throw new Error();
      const value = plainRecord(contextual.value);
      knownKeys(value, ['err', 'logs', 'unitsConsumed', 'accounts', 'returnData',
        'innerInstructions', 'loadedAccountsDataSize', 'replacementBlockhash'], ['err', 'logs']);
      validateReturnData(value.returnData);
      validateSimulationSupplementaryFields(value);
      const result = Object.freeze({
        providerId: this.providerId,
        contextSlot: contextual.contextSlot,
        failureKind: simulationFailure(value.err),
        logs: logsFrom(value.logs),
        unitsConsumed: value.unitsConsumed === undefined
          ? null : nullablePositiveSafeIntegerBigint(value.unitsConsumed),
        accounts: value.accounts === undefined
          ? null : simulationAccounts(value.accounts, request.accountAddresses),
        innerInstructions: value.innerInstructions === undefined
          ? null : innerInstructionGroups(value.innerInstructions),
      });
      this.simulationCompleted = true;
      return result;
    } catch { return this.failInvalidResponse(); }
  }

  public usage(): ExecutionProviderUsage {
    return Object.freeze({
      providerId: this.providerId,
      rpcCallsUsed: this.callsUsed,
      rpcCallsLimit: this.config.maxCalls,
    });
  }

  private requireReady(signal: AbortSignal): void {
    validateSignal(signal);
    if (signal.aborted) throw sessionError('OPERATION_ABORTED');
    if (this.failed || this.genesisEvidence === null) throw inputError();
  }

  private requireExactSnapshot(snapshotSlot: bigint): void {
    if (this.snapshotSlot === null || snapshotSlot !== this.snapshotSlot) throw inputError();
  }

  private async dispatch(
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    validateSignal(signal);
    if (signal.aborted) throw sessionError('OPERATION_ABORTED');
    if (this.failed || this.callsUsed >= this.config.maxCalls) throw inputError();
    this.callsUsed += 1;
    const id = this.callsUsed;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    let response: Readonly<{ readonly status: number; readonly text: string }>;
    try {
      response = await withDeadline(
        async (deadlineSignal) => {
          const fetched = await this.fetchImplementation(this.config.httpRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: deadlineSignal,
          });
          if (!(fetched instanceof Response)) throw sessionError('RPC_RESPONSE_INVALID');
          if (fetched.status === 429 || fetched.status < 200 || fetched.status >= 300) {
            cancelResponseBody(fetched);
            return Object.freeze({ status: fetched.status, text: '' });
          }
          const contentLength = fetched.headers.get('content-length');
          if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(contentLength)
            || BigInt(contentLength) > BigInt(MAX_RPC_RESPONSE_BYTES))) {
            cancelResponseBody(fetched);
            throw sessionError('RPC_RESPONSE_INVALID');
          }
          return Object.freeze({
            status: fetched.status,
            text: await readBoundedResponse(fetched, deadlineSignal),
          });
        },
        signal,
        this.config.timeoutMs,
      );
    } catch (error) {
      this.failed = true;
      if (isInternalError(error)) throw error;
      throw sessionError('RPC_UNAVAILABLE');
    }
    if (response.status === 429) {
      this.failed = true;
      throw sessionError('RPC_RATE_LIMITED');
    }
    if (response.status < 200 || response.status >= 300) {
      this.failed = true;
      throw sessionError('RPC_UNAVAILABLE');
    }
    if (Buffer.byteLength(response.text, 'utf8') > MAX_RPC_RESPONSE_BYTES) {
      return this.failInvalidResponse();
    }
    let decoded: unknown;
    try { decoded = JSON.parse(response.text) as unknown; } catch { return this.failInvalidResponse(); }
    try {
      const envelope = plainRecord(decoded);
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id) throw new Error();
      const keys = Reflect.ownKeys(envelope);
      if (keys.length !== 3) throw new Error();
      if (keys.includes('error') && !keys.includes('result')) {
        const rpcError = plainRecord(envelope.error);
        const code = rpcError.code;
        if (code === 429) {
          this.failed = true;
          throw sessionError('RPC_RATE_LIMITED');
        }
        if (code === -32_005) {
          this.failed = true;
          throw sessionError('RPC_UNAVAILABLE');
        }
        throw new Error();
      }
      if (!keys.includes('result') || keys.includes('error')) throw new Error();
      return envelope.result;
    } catch (error) {
      if (isInternalError(error)) throw error;
      return this.failInvalidResponse();
    }
  }

  private failInvalidResponse(): never {
    this.failed = true;
    throw sessionError('RPC_RESPONSE_INVALID');
  }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let item = await reader.read();
    while (!item.done) {
      if (!(item.value instanceof Uint8Array)) throw sessionError('RPC_RESPONSE_INVALID');
      total += item.value.byteLength;
      if (total > MAX_RPC_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* preserve the normalized size error */ }
        throw sessionError('RPC_RESPONSE_INVALID');
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
  try { return new TextDecoder('utf-8', { fatal: true }).decode(combined); } catch {
    throw sessionError('RPC_RESPONSE_INVALID');
  }
}

function cancelResponseBody(response: Response): void {
  if (response.body === null) return;
  try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
}

async function withDeadline<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Value> {
  if (signal.aborted) throw sessionError('OPERATION_ABORTED');
  const deadline = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      deadline.abort();
      reject(sessionError('RPC_TIMEOUT'));
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = (): void => {
      deadline.abort();
      reject(sessionError('OPERATION_ABORTED'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try { return await Promise.race([operation(deadline.signal), timeoutPromise, abortPromise]); } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

function configInput(value: unknown): ValidatedConfig {
  const record = exactFrozenRecord(value, CONFIG_KEYS);
  const providerId = boundedText(record.providerId, 256);
  if (typeof record.httpRpcUrl !== 'string'
    || Buffer.byteLength(record.httpRpcUrl, 'utf8') > 4_096) throw inputError();
  try {
    const url = new URL(record.httpRpcUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
  } catch { throw inputError(); }
  return Object.freeze({
    providerId,
    httpRpcUrl: record.httpRpcUrl,
    expectedGenesisHash: publicKey(record.expectedGenesisHash),
    timeoutMs: boundedInteger(record.timeoutMs, 1, DATE_MAX_TIMEOUT_MS),
    maxCalls: boundedInteger(record.maxCalls, 1, INT32_MAX),
    maxSnapshotSlotLag: boundedInteger(record.maxSnapshotSlotLag, 0, Number.MAX_SAFE_INTEGER),
  });
}

function simulationRequest(value: unknown): ExecutionUnsignedSimulationRequest {
  const record = exactFrozenRecord(value, SIMULATION_REQUEST_KEYS);
  return Object.freeze({
    transactionBase64: base64(record.transactionBase64, MAX_TRANSACTION_BYTES, false),
    snapshotSlot: requestSlot(record.snapshotSlot),
    accountAddresses: addressList(record.accountAddresses, true),
  });
}

function addressList(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_ACCOUNT_COUNT || (!allowEmpty && value.length === 0)) throw inputError();
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_unused, index) => String(index));
  expectedKeys.push('length');
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string'
    || !expectedKeys.includes(key))) throw inputError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || lengthDescriptor.enumerable || lengthDescriptor.value !== value.length) throw inputError();
  const addresses: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw inputError();
    }
    addresses.push(publicKey(descriptor.value));
  }
  if (new Set(addresses).size !== addresses.length) throw inputError();
  return Object.freeze(addresses);
}

function contextValue(value: unknown): RpcContextValue {
  const record = plainRecord(value);
  exactKeys(record, ['context', 'value']);
  const context = plainRecord(record.context);
  const keys = Reflect.ownKeys(context);
  if (!keys.includes('slot') || keys.some((key) => key !== 'slot' && key !== 'apiVersion')) {
    throw new Error();
  }
  if (context.apiVersion !== undefined && typeof context.apiVersion !== 'string') throw new Error();
  return Object.freeze({
    contextSlot: safeIntegerBigint(context.slot, false),
    value: record.value,
  });
}

function accountFrom(value: unknown, address: string): ExecutionRpcAccount {
  const record = plainRecord(value);
  knownKeys(record, ['lamports', 'owner', 'executable', 'rentEpoch', 'space', 'data'],
    ['lamports', 'owner', 'executable', 'space', 'data']);
  if (typeof record.executable !== 'boolean' || !Array.isArray(record.data)
    || record.data.length !== 2 || record.data[1] !== 'base64') throw new Error();
  const dataBase64 = base64(record.data[0], MAX_ACCOUNT_DATA_BYTES, true);
  const space = record.space === null ? null : safeIntegerBigint(record.space, false);
  if (space !== null && space !== BigInt(Buffer.from(dataBase64, 'base64').byteLength)) {
    throw new Error();
  }
  return Object.freeze({
    address,
    lamports: safeIntegerBigint(record.lamports, false),
    owner: publicKey(record.owner),
    executable: record.executable,
    rentEpoch: rentEpochFrom(record.rentEpoch),
    space,
    dataBase64,
  });
}

function rentEpochFrom(value: unknown): bigint | null {
  if (value === undefined || value === null || value === U64_MAX_AS_NUMBER) return null;
  return safeIntegerBigint(value, false);
}

function simulationAccounts(
  value: unknown,
  addresses: readonly string[],
): readonly (ExecutionRpcAccount | null)[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== addresses.length) throw new Error();
  return Object.freeze(value.map((item, index) => {
    const address = addresses[index];
    if (address === undefined) throw new Error();
    return item === null ? null : accountFrom(item, address);
  }));
}

function simulationFailure(value: unknown): ExecutionSimulationFailureKind | null {
  if (value === null) return null;
  boundedJson(value, 0, { nodes: 0 });
  return value === 'BlockhashNotFound' ? 'BLOCKHASH_NOT_FOUND' : 'PROGRAM_ERROR';
}

function logsFrom(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_LOG_LINES) throw new Error();
  return Object.freeze(value.map((item) => boundedText(item, MAX_LOG_BYTES)));
}

function innerInstructionGroups(value: unknown): readonly ExecutionInnerInstructionGroup[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_INNER_GROUPS) throw new Error();
  let instructionCount = 0;
  return Object.freeze(value.map((groupValue) => {
    const group = plainRecord(groupValue);
    exactKeys(group, ['index', 'instructions']);
    if (!Array.isArray(group.instructions)) throw new Error();
    instructionCount += group.instructions.length;
    if (instructionCount > MAX_INNER_INSTRUCTIONS) throw new Error();
    const instructions = group.instructions.map((instructionValue) => {
      const instruction = plainRecord(instructionValue);
      const stackHeight = optionalStackHeight(instruction.stackHeight);
      if (Reflect.ownKeys(instruction).includes('parsed')) {
        knownKeys(instruction, ['program', 'programId', 'parsed', 'stackHeight'],
          ['program', 'programId', 'parsed']);
        void boundedText(instruction.program, 128);
        boundedJson(instruction.parsed, 0, { nodes: 0 });
        return Object.freeze({
          kind: 'PARSED',
          programId: publicKey(instruction.programId),
          accounts: null,
          data: null,
          stackHeight,
        } satisfies ExecutionInnerInstruction);
      }
      knownKeys(instruction, ['programId', 'accounts', 'data', 'stackHeight'],
        ['programId', 'accounts', 'data']);
      if (!Array.isArray(instruction.accounts)
        || instruction.accounts.length > MAX_INSTRUCTION_ACCOUNTS) throw new Error();
      return Object.freeze({
        kind: 'PARTIALLY_DECODED',
        programId: publicKey(instruction.programId),
        accounts: Object.freeze(instruction.accounts.map((address) => publicKey(address))),
        data: base58Text(instruction.data, MAX_INSTRUCTION_DATA_LENGTH),
        stackHeight,
      } satisfies ExecutionInnerInstruction);
    });
    return Object.freeze({
      index: boundedInteger(group.index, 0, 255),
      instructions: Object.freeze(instructions),
    });
  }));
}

function optionalStackHeight(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return boundedInteger(value, 1, 255);
}

function validateReturnData(value: unknown): void {
  if (value === undefined || value === null) return;
  const record = plainRecord(value);
  exactKeys(record, ['programId', 'data']);
  void publicKey(record.programId);
  if (!Array.isArray(record.data) || record.data.length !== 2 || record.data[1] !== 'base64') {
    throw new Error();
  }
  void base64(record.data[0], MAX_RETURN_DATA_BYTES, true);
}

function validateSimulationSupplementaryFields(value: Record<string, unknown>): void {
  if (value.loadedAccountsDataSize !== undefined) {
    void boundedInteger(value.loadedAccountsDataSize, 0, 0xffff_ffff);
  }
  if (value.replacementBlockhash === undefined || value.replacementBlockhash === null) return;
  const replacementBlockhash = plainRecord(value.replacementBlockhash);
  exactKeys(replacementBlockhash, ['blockhash', 'lastValidBlockHeight']);
  void publicKey(replacementBlockhash.blockhash);
  void safeIntegerBigint(replacementBlockhash.lastValidBlockHeight, false);
  throw new Error();
}

function boundedJson(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes += 1;
  if (depth > 8 || state.nodes > 256) throw new Error();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { void boundedText(value, 1_024); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error();
    for (const item of value) boundedJson(item, depth + 1, state);
    return;
  }
  const record = plainRecord(value);
  const keys = Reflect.ownKeys(record);
  if (keys.length > 64) throw new Error();
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error();
    void boundedText(key, 128);
    boundedJson(record[key], depth + 1, state);
  }
}

function exactFrozenRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || !Object.isFrozen(value)) throw inputError();
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw inputError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length) throw inputError();
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    if (!keys.includes(key)) throw inputError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw inputError();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new Error();
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error();
      }
      Object.defineProperty(output, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return output;
  } catch { throw new Error(); }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = safeRecordKeys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new Error();
  }
}

function knownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const keys = safeRecordKeys(record);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))) throw new Error();
}

function safeRecordKeys(record: Record<string, unknown>): readonly string[] {
  const keys = Reflect.ownKeys(record);
  const output: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error();
    }
    output.push(key);
  }
  return output;
}

function requestSlot(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_SAFE_BIGINT) throw inputError();
  return value;
}

function safeIntegerBigint(value: unknown, positive: boolean): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)
    || Object.is(value, -0)) throw new Error();
  return BigInt(value as number);
}

function nullablePositiveSafeIntegerBigint(value: unknown): bigint | null {
  return value === null ? null : safeIntegerBigint(value, true);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum
    || Object.is(value, -0)) throw inputError();
  return value as number;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw new Error();
  return value;
}

function base64(value: unknown, maximumBytes: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw inputError();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > maximumBytes || decoded.toString('base64') !== value) throw inputError();
  return value;
}

function publicKey(value: unknown): string {
  const text = base58Text(value, 44);
  if (decodeBase58Length(text) !== 32) throw inputError();
  return text;
}

function base58Text(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw inputError();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!BASE58_ALPHABET.includes(value.charAt(index))) throw inputError();
  }
  return value;
}

function decodeBase58Length(value: string): number {
  const bytes: number[] = [0];
  for (let index = 0; index < value.length; index += 1) {
    const digit = BASE58_ALPHABET.indexOf(value.charAt(index));
    let carry = digit;
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
      const next = (bytes[byteIndex] ?? 0) * 58 + carry;
      bytes[byteIndex] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value.charAt(leadingZeros) === '1') leadingZeros += 1;
  return leadingZeros + (bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length);
}

function validateSignal(value: unknown): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) throw inputError();
}

function sessionError(
  code: ExecutionProviderSessionErrorCode,
  genesisEvidence: ExecutionGenesisEvidence | null = null,
): ExecutionProviderSessionError {
  const error = new ExecutionProviderSessionError(code, genesisEvidence);
  INTERNAL_ERRORS.add(error);
  return error;
}

function inputError(): ExecutionProviderSessionError {
  return sessionError('INVALID_INPUT');
}

function isInternalError(value: unknown): value is ExecutionProviderSessionError {
  return typeof value === 'object' && value !== null
    && INTERNAL_ERRORS.has(value as ExecutionProviderSessionError);
}

export function isExecutionProviderSessionError(value: unknown): value is ExecutionProviderSessionError {
  return isInternalError(value);
}

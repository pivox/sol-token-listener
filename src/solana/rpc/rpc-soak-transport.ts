import { PublicKey, type Commitment } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import {
  RpcSoakTransportError,
  type RpcSoakObservation,
  type RpcSoakSubscription,
  type RpcSoakTransport,
} from './rpc-soak.js';

export interface RpcSoakFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type RpcSoakFetch = (
  input: string,
  init: RequestInit,
) => Promise<RpcSoakFetchResponse>;

export interface RpcSoakLogsConnection {
  onLogs(
    program: PublicKey,
    callback: (logs: unknown, context: { readonly slot: number }) => void,
    commitment: 'processed',
  ): unknown;
  removeOnLogsListener(id: number): Promise<void>;
}

export interface SolanaRpcSoakTransportOptions {
  readonly httpRpcUrl: string;
  readonly commitment: Commitment;
  readonly connection: RpcSoakLogsConnection;
  readonly fetch?: RpcSoakFetch;
}

export class RpcSoakWebsocketError extends Error {
  public constructor(public readonly stage: 'subscribe' | 'cleanup') {
    super('RPC soak WebSocket operation failed.');
    this.name = 'RpcSoakWebsocketError';
    Object.freeze(this);
  }
}

const programs = Object.freeze([
  Object.freeze({ family: 'pumpfun' as const, address: PUMP_PROGRAM_ID }),
  Object.freeze({ family: 'pumpswap' as const, address: PUMPSWAP_PROGRAM_ID }),
]);

export class SolanaRpcSoakTransport implements RpcSoakTransport {
  private readonly httpRpcUrl: string;
  private readonly commitment: Commitment;
  private readonly connection: RpcSoakLogsConnection;
  private readonly fetch: RpcSoakFetch;

  public constructor(options: SolanaRpcSoakTransportOptions) {
    if (typeof options.httpRpcUrl !== 'string' || options.httpRpcUrl.trim() === '') {
      throw new TypeError('RPC soak HTTP configuration is invalid.');
    }
    this.httpRpcUrl = options.httpRpcUrl;
    this.commitment = options.commitment;
    this.connection = options.connection;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async sampleHttpSlot(): Promise<bigint> {
    let response: RpcSoakFetchResponse;
    try {
      response = await this.fetch(this.httpRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: this.commitment }],
        }),
      });
    } catch {
      throw new RpcSoakTransportError('RPC_REQUEST_FAILED');
    }
    if (response.status === 429) throw new RpcSoakTransportError('RPC_RATE_LIMITED');
    if (!response.ok) throw new RpcSoakTransportError('RPC_REQUEST_FAILED');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RpcSoakTransportError('RPC_RESPONSE_INVALID');
    }
    const jsonrpc = ownData(payload, 'jsonrpc');
    const id = ownData(payload, 'id');
    const result = ownData(payload, 'result');
    if (jsonrpc !== '2.0'
      || id !== 1
      || typeof result !== 'number'
      || !Number.isSafeInteger(result)
      || result < 0
      || Object.is(result, -0)) {
      throw new RpcSoakTransportError('RPC_RESPONSE_INVALID');
    }
    return BigInt(result);
  }

  public async subscribe(
    observe: (value: RpcSoakObservation) => void,
  ): Promise<RpcSoakSubscription> {
    const installed: number[] = [];
    try {
      for (const program of programs) {
        const id = this.connection.onLogs(
          new PublicKey(program.address),
          (_logs, context) => {
            const slot = canonicalSlot(context);
            if (slot !== null) observe(Object.freeze({ program: program.family, slot }));
          },
          'processed',
        );
        if (!validListenerId(id) || installed.includes(id)) {
          throw new RpcSoakWebsocketError('subscribe');
        }
        installed.push(id);
      }
    } catch {
      await removeEvery(this.connection, installed).catch(() => undefined);
      throw new RpcSoakWebsocketError('subscribe');
    }

    let closePromise: Promise<void> | null = null;
    return Object.freeze({
      close: (): Promise<void> => {
        closePromise ??= removeEvery(this.connection, installed);
        return closePromise;
      },
    });
  }
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
      ? descriptor.value as unknown
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalSlot(context: unknown): bigint | null {
  const value = ownData(context, 'slot');
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
    ? BigInt(value)
    : null;
}

function validListenerId(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

async function removeEvery(connection: RpcSoakLogsConnection, ids: readonly number[]): Promise<void> {
  const results = await Promise.allSettled(ids.map(async (id) => {
    await connection.removeOnLogsListener(id);
  }));
  if (results.some((result) => result.status === 'rejected')) {
    throw new RpcSoakWebsocketError('cleanup');
  }
}

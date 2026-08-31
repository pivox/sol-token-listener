import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  AccountLayout,
  AccountState,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../../src/launchpads/pumpfun/official-sdk.js';
import { PUMP_PROGRAM_ID } from '../../src/launchpads/pumpfun/constants.js';

export const EXECUTOR_INTEGRATION_GENESIS = PublicKey.default.toBase58();
export const EXECUTOR_INTEGRATION_PAYER = deterministicKey(10);
export const EXECUTOR_INTEGRATION_MINT = deterministicKey(20);

const BLOCKHASH = deterministicKey(200);
const DISCOVERY_SLOT = 122;
const SNAPSHOT_SLOT = 123;
const RPC_PATH = '/rpc/private-rpc-marker';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

interface RpcAccountValue {
  readonly lamports: number;
  readonly owner: string;
  readonly executable: boolean;
  readonly rentEpoch: null;
  readonly space: number;
  readonly data: readonly [string, 'base64'];
}

export interface ScriptedPumpFunRpc {
  readonly url: string;
  readonly privateMarker: string;
  readonly methods: readonly string[];
  readonly requestErrors: readonly string[];
  readonly simulatedTransactionWasUnsigned: () => boolean;
  readonly close: () => Promise<void>;
}

export async function startScriptedPumpFunBuyRpc(): Promise<ScriptedPumpFunRpc> {
  const fixture = pumpFunFixture();
  const methods: string[] = [];
  const requestErrors: string[] = [];
  let unsigned = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => {
      try {
        if (request.method !== 'POST' || request.url !== RPC_PATH) throw new Error('invalid-route');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const rpc = rpcRequest(body);
        methods.push(rpc.method);
        const result = dispatch(rpc, fixture, (transactionBase64) => {
          const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
          unsigned = transaction.signatures.length === 1
            && transaction.signatures[0]?.every((byte) => byte === 0) === true;
        });
        respond(response, Object.freeze({ jsonrpc: '2.0', id: rpc.id, result }));
      } catch (error) {
        requestErrors.push(error instanceof Error ? error.message : 'unknown-request-error');
        response.statusCode = 500;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('scripted-rpc-address-unavailable');
  }
  const url = `http://127.0.0.1:${address.port}${RPC_PATH}`;
  return Object.freeze({
    url,
    privateMarker: RPC_PATH.slice(1),
    methods,
    requestErrors,
    simulatedTransactionWasUnsigned: () => unsigned,
    close: async () => closeServer(server),
  });
}

function dispatch(
  request: JsonRpcRequest,
  fixture: PumpFunFixture,
  inspectTransaction: (transactionBase64: string) => void,
): unknown {
  switch (request.method) {
    case 'getGenesisHash':
      return EXECUTOR_INTEGRATION_GENESIS;
    case 'getMultipleAccounts': {
      const addresses = stringArray(request.params[0]);
      const discovery = addresses.length === 2;
      return Object.freeze({
        context: Object.freeze({ slot: discovery ? DISCOVERY_SLOT : SNAPSHOT_SLOT }),
        value: Object.freeze(addresses.map((address) => fixture.accounts.get(address) ?? null)),
      });
    }
    case 'getLatestBlockhash':
      return Object.freeze({
        context: Object.freeze({ slot: SNAPSHOT_SLOT + 1 }),
        value: Object.freeze({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
      });
    case 'getFeeForMessage':
      return Object.freeze({
        context: Object.freeze({ slot: SNAPSHOT_SLOT + 1 }), value: 5_000,
      });
    case 'simulateTransaction': {
      const transactionBase64 = request.params[0];
      if (typeof transactionBase64 !== 'string') throw new Error('invalid-transaction');
      inspectTransaction(transactionBase64);
      return Object.freeze({
        context: Object.freeze({ slot: SNAPSHOT_SLOT + 2 }),
        value: Object.freeze({
          err: null,
          logs: Object.freeze(['Program log: success']),
          unitsConsumed: 25_000,
          accounts: fixture.simulatedAccounts,
          innerInstructions: Object.freeze([]),
        }),
      });
    }
    default:
      throw new Error(`unexpected-method:${request.method}`);
  }
}

interface PumpFunFixture {
  readonly accounts: ReadonlyMap<string, RpcAccountValue>;
  readonly simulatedAccounts: readonly (RpcAccountValue | null)[];
}

function pumpFunFixture(): PumpFunFixture {
  const mint = new PublicKey(EXECUTOR_INTEGRATION_MINT);
  const curveAddress = bondingCurvePda(mint).toBase58();
  const zero = PublicKey.default;
  const global: Global = {
    initialized: true,
    authority: zero,
    feeRecipient: new PublicKey(deterministicKey(100)),
    initialVirtualTokenReserves: new BN('1000000000'),
    initialVirtualSolReserves: new BN('100000000'),
    initialRealTokenReserves: new BN('800000000'),
    tokenTotalSupply: new BN('1000000000'),
    feeBasisPoints: new BN(100),
    withdrawAuthority: zero,
    enableMigrate: true,
    poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(50),
    feeRecipients: publicKeys(101, 7),
    setCreatorAuthority: zero,
    adminSetCreatorAuthority: zero,
    createV2Enabled: true,
    whitelistPda: zero,
    reservedFeeRecipient: new PublicKey(deterministicKey(110)),
    reservedFeeRecipients: publicKeys(111, 7),
    mayhemModeEnabled: false,
    isCashbackEnabled: true,
    buybackFeeRecipients: publicKeys(120, 8),
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('100000000'),
    whitelistedQuoteMints: [NATIVE_MINT],
  };
  const feeConfig = {
    bump: 1,
    admin: zero,
    flatFees: {
      lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50),
    },
    feeTiers: [{
      marketCapLamportsThreshold: new BN(0),
      fees: {
        lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50),
      },
    }],
    stableFeeTiers: [],
  } as FeeConfig & { readonly bump: number; readonly stableFeeTiers: readonly unknown[] };
  const curve: BondingCurve = {
    virtualTokenReserves: new BN('1000000000'),
    virtualQuoteReserves: new BN('100000000'),
    realTokenReserves: new BN('800000000'),
    realQuoteReserves: new BN('50000000'),
    tokenTotalSupply: new BN('1000000000'),
    complete: false,
    creator: new PublicKey(deterministicKey(30)),
    isMayhemMode: false,
    isCashbackCoin: true,
    quoteMint: NATIVE_MINT,
  };
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: zero,
    supply: 1_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: zero,
  }, mintData);
  const accounts = new Map<string, RpcAccountValue>([
    [GLOBAL_PDA.toBase58(), account(PUMP_PROGRAM_ID, encodePumpAccount('global', global), 1)],
    [PUMP_FEE_CONFIG_PDA.toBase58(), account(
      PUMP_FEE_PROGRAM_ID.toBase58(), encodePumpAccount('feeConfig', feeConfig), 1,
    )],
    [EXECUTOR_INTEGRATION_MINT, account(TOKEN_PROGRAM_ID.toBase58(), mintData, 1)],
    [curveAddress, account(PUMP_PROGRAM_ID, encodePumpAccount('bondingCurve', curve), 1)],
    [EXECUTOR_INTEGRATION_PAYER, account(PublicKey.default.toBase58(), Buffer.alloc(0), 10_000_000)],
  ]);
  const simulatedAccounts = Object.freeze([
    account(PublicKey.default.toBase58(), Buffer.alloc(0), 6_955_720),
    tokenAccount(EXECUTOR_INTEGRATION_MINT, EXECUTOR_INTEGRATION_PAYER, 100_000_000n, 2_039_280),
    null,
  ]);
  return Object.freeze({ accounts, simulatedAccounts });
}

function account(owner: string, data: Uint8Array, lamports: number): RpcAccountValue {
  return Object.freeze({
    lamports,
    owner,
    executable: false,
    rentEpoch: null,
    space: data.byteLength,
    data: Object.freeze([Buffer.from(data).toString('base64'), 'base64'] as const),
  });
}

function tokenAccount(
  mint: string,
  owner: string,
  amountRaw: bigint,
  lamports: number,
): RpcAccountValue {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount: amountRaw,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: AccountState.Initialized,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data);
  return account(TOKEN_PROGRAM_ID.toBase58(), data, lamports);
}

interface PumpAccountLayoutEntry {
  readonly discriminator: readonly number[];
  readonly layout: { encode(value: unknown, destination: Buffer): number };
}

function encodePumpAccount(name: string, value: unknown): Buffer {
  const sdk = PUMP_SDK as unknown as {
    readonly offlinePumpProgram: {
      readonly coder: {
        readonly accounts: {
          readonly accountLayouts: ReadonlyMap<string, PumpAccountLayoutEntry>;
        };
      };
    };
  };
  const entry = sdk.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  if (entry === undefined) throw new Error('unknown-pump-account-layout');
  const destination = Buffer.alloc(4_096);
  const length = entry.layout.encode(value, destination);
  return Buffer.concat([Buffer.from(entry.discriminator), destination.subarray(0, length)]);
}

function rpcRequest(value: unknown): JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid-rpc-request');
  }
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== '2.0' || typeof request.id !== 'number'
    || !Number.isSafeInteger(request.id) || typeof request.method !== 'string'
    || !Array.isArray(request.params)) throw new Error('invalid-rpc-request');
  return request as unknown as JsonRpcRequest;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('invalid-address-list');
  }
  return value as string[];
}

function respond(response: ServerResponse, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error); });
  });
}

function publicKeys(seed: number, length: number): PublicKey[] {
  return Array.from(
    { length }, (_unused, index) => new PublicKey(deterministicKey(seed + index)),
  );
}

function deterministicKey(seed: number): string {
  return new PublicKey(Uint8Array.from(
    { length: 32 }, (_unused, index) => (seed + index) % 256,
  )).toBase58();
}

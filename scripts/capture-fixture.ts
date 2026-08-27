import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import { decodePumpSwapTransaction } from '../src/markets/pumpswap/transaction-decoder.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { TransactionFetcher } from '../src/solana/rpc/transaction-fetcher.js';
import { SolanaTransactionLocator } from '../src/solana/rpc/transaction-locator.js';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';

export type CaptureFamily = 'pumpfun' | 'pumpswap';

export interface CaptureArguments {
  readonly family: CaptureFamily;
  readonly signature: string;
  readonly transactionIndex: number;
  readonly outputName: string;
}

export interface SerializedMainnetFixture {
  readonly schemaVersion: 'solana-mainnet-fixture.v1';
  readonly family: CaptureFamily;
  readonly sanitization: Readonly<{
    contract: 'normalized-public-chain.v1';
    anonymized: false;
  }>;
  readonly provenance: Readonly<{
    source: 'solana-mainnet';
    signature: string;
    slot: string;
    transactionIndex: number;
    capturedAt: string;
  }>;
  readonly transaction: Readonly<Record<string, unknown>>;
}

export function parseCaptureArguments(args: readonly string[]): CaptureArguments {
  const [family, signature, rawTransactionIndex, outputName, extra] = args;
  if ((family !== 'pumpfun' && family !== 'pumpswap')
    || signature === undefined
    || rawTransactionIndex === undefined
    || outputName === undefined
    || extra !== undefined
    || !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/u.test(signature)
    || !/^(?:0|[1-9]\d*)$/u.test(rawTransactionIndex)
    || !/^[a-z0-9][a-z0-9-]*\.json$/u.test(outputName)) {
    throw new TypeError('Fixture capture arguments are invalid.');
  }
  const transactionIndex = Number(rawTransactionIndex);
  if (!Number.isSafeInteger(transactionIndex)) {
    throw new TypeError('Fixture capture arguments are invalid.');
  }
  return Object.freeze({ family, signature, transactionIndex, outputName });
}

export function resolveCaptureRpcUrl(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const value = environment.SOLANA_HTTP_RPC_URL;
  if (value === undefined || value.trim() === '') {
    throw new TypeError('Fixture capture RPC configuration is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Fixture capture RPC configuration is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Fixture capture RPC configuration is invalid.');
  }
  return value;
}

export function serializeMainnetFixture(
  family: CaptureFamily,
  transaction: NormalizedTransaction,
  capturedAt: string,
): SerializedMainnetFixture {
  const captureDate = new Date(capturedAt);
  if (transaction.transactionIndex === null
    || transaction.confirmationStatus !== 'FINALIZED'
    || transaction.error !== null
    || Number.isNaN(captureDate.getTime())
    || captureDate.toISOString() !== capturedAt) {
    throw new TypeError('Fixture capture transaction is invalid.');
  }
  return Object.freeze({
    schemaVersion: 'solana-mainnet-fixture.v1',
    family,
    sanitization: Object.freeze({
      contract: 'normalized-public-chain.v1',
      anonymized: false,
    }),
    provenance: Object.freeze({
      source: 'solana-mainnet',
      signature: transaction.signature,
      slot: transaction.slot.toString(),
      transactionIndex: transaction.transactionIndex,
      capturedAt,
    }),
    transaction: serializeTransaction(transaction),
  });
}

function serializeTransaction(transaction: NormalizedTransaction): Readonly<Record<string, unknown>> {
  return Object.freeze({
    signature: transaction.signature,
    slot: transaction.slot.toString(),
    transactionIndex: transaction.transactionIndex,
    confirmationStatus: transaction.confirmationStatus,
    version: transaction.version,
    blockTimeMs: transaction.blockTimeMs,
    instructions: Object.freeze(transaction.instructions.map(serializeInstruction)),
    preTokenBalances: Object.freeze(transaction.preTokenBalances.map(serializeTokenBalance)),
    postTokenBalances: Object.freeze(transaction.postTokenBalances.map(serializeTokenBalance)),
    feeLamports: transaction.feeLamports.toString(),
    computeUnits: transaction.computeUnits?.toString() ?? null,
    error: null,
  });
}

function serializeInstruction(instruction: NormalizedInstruction): Readonly<Record<string, unknown>> {
  return Object.freeze({
    programId: instruction.programId,
    accounts: Object.freeze([...instruction.accounts]),
    dataHex: Buffer.from(instruction.data).toString('hex'),
    instructionIndex: instruction.instructionIndex,
    innerInstructionIndex: instruction.innerInstructionIndex,
    parentInstructionIndex: instruction.parentInstructionIndex,
    stackHeight: instruction.stackHeight,
  });
}

function serializeTokenBalance(balance: NormalizedTokenBalance): Readonly<Record<string, unknown>> {
  return Object.freeze({
    accountIndex: balance.accountIndex,
    account: balance.account,
    mint: balance.mint,
    owner: balance.owner,
    tokenProgram: balance.tokenProgram,
    amountRaw: balance.amountRaw.toString(),
    decimals: balance.decimals,
  });
}

function webSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function validateEvidence(family: CaptureFamily, transaction: NormalizedTransaction): void {
  if (family === 'pumpfun') {
    const decoded = decodePumpTransaction(transaction);
    if (decoded.creations.length + decoded.trades.length + decoded.migrations.length === 0) {
      throw new TypeError('Fixture capture contains no Pump.fun evidence.');
    }
    return;
  }
  const decoded = decodePumpSwapTransaction(transaction);
  if (decoded.issues.length > 0 || decoded.poolCreations.length + decoded.trades.length === 0) {
    throw new TypeError('Fixture capture contains no valid PumpSwap evidence.');
  }
}

async function main(): Promise<void> {
  const args = parseCaptureArguments(process.argv.slice(2));
  const httpRpcUrl = resolveCaptureRpcUrl(process.env);
  const output = new URL(
    `../tests/fixtures/${args.family}/${args.outputName}`,
    import.meta.url,
  );
  const outputPath = fileURLToPath(output);
  if (existsSync(outputPath)) throw new TypeError('Fixture output already exists.');

  const client = new SolanaRpcClient({
    httpRpcUrl,
    httpRpcFallbackUrls: Object.freeze([]),
    wsRpcUrl: webSocketUrl(httpRpcUrl),
    commitment: 'finalized',
    finality: 'finalized',
  });
  const candidate = await new TransactionFetcher(client).fetch(
    args.signature,
    'FINALIZED',
    null,
  );
  if (candidate?.signature !== args.signature
    || candidate.confirmationStatus !== 'FINALIZED') {
    throw new TypeError('Fixture transaction could not be finalized.');
  }
  const transaction = await new SolanaTransactionLocator(client).locate(Object.freeze({
    signature: args.signature,
    slot: candidate.slot,
    confirmationStatus: 'FINALIZED',
  }));
  if (transaction.signature !== args.signature
    || transaction.transactionIndex !== args.transactionIndex
    || transaction.confirmationStatus !== 'FINALIZED') {
    throw new TypeError('Fixture transaction could not be finalized.');
  }
  validateEvidence(args.family, transaction);
  const fixture = serializeMainnetFixture(args.family, transaction, new Date().toISOString());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`Mainnet fixture captured: ${args.family}/${args.outputName}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    process.stderr.write('{"event":"fixture.capture.failed","errorCode":"FIXTURE_CAPTURE_FAILED"}\n');
    process.exitCode = 1;
  });
}

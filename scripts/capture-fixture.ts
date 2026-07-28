import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { TransactionFetcher } from '../src/solana/rpc/transaction-fetcher.js';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';

const [kind, signature, rawTransactionIndex, outputName] = process.argv.slice(2);
if (kind !== 'pumpfun' || signature === undefined || rawTransactionIndex === undefined || outputName === undefined) {
  throw new Error('Usage: npm run fixture:capture -- pumpfun <signature> <transactionIndex> <output-name>');
}
if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/u.test(signature)) {
  throw new Error('Signature Solana invalide.');
}
if (!/^\d+$/u.test(rawTransactionIndex)) throw new Error('transactionIndex invalide.');
const transactionIndex = Number(rawTransactionIndex);
if (!Number.isSafeInteger(transactionIndex)) throw new Error('transactionIndex hors limites.');
if (!/^[a-z0-9][a-z0-9-]*\.json$/u.test(outputName)) {
  throw new Error('Nom de sortie invalide.');
}
const httpRpcUrl = process.env.SOLANA_RPC_HTTP_URL;
if (httpRpcUrl === undefined || httpRpcUrl.trim() === '') {
  throw new Error('SOLANA_RPC_HTTP_URL est requis.');
}

const output = new URL(`../tests/fixtures/pumpfun/${outputName}`, import.meta.url);
const outputPath = fileURLToPath(output);
if (existsSync(outputPath)) throw new Error(`La fixture existe déjà: ${outputName}.`);

const client = new SolanaRpcClient({
  httpRpcUrl,
  wsRpcUrl: webSocketUrl(httpRpcUrl),
  commitment: 'confirmed',
  finality: 'finalized',
});
const transaction = await new TransactionFetcher(client).fetch(
  signature,
  'CONFIRMED',
  transactionIndex,
);
if (transaction === null) throw new Error('Transaction introuvable au niveau confirmed.');
if (transaction.signature !== signature || transaction.transactionIndex !== transactionIndex) {
  throw new Error('Transaction normalisée incohérente avec la demande.');
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(output, `${JSON.stringify({
  provenance: {
    source: 'solana-mainnet',
    signature,
    slot: transaction.slot.toString(),
    transactionIndex,
    capturedAt: new Date().toISOString(),
  },
  transaction: serializeTransaction(transaction),
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(`Capture Pump.fun assainie: ${outputName}\n`);

function webSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function serializeTransaction(transaction: NormalizedTransaction): object {
  return {
    signature: transaction.signature,
    slot: transaction.slot.toString(),
    transactionIndex: transaction.transactionIndex,
    confirmationStatus: transaction.confirmationStatus,
    version: transaction.version,
    blockTimeMs: transaction.blockTimeMs,
    instructions: transaction.instructions.map(serializeInstruction),
    preTokenBalances: transaction.preTokenBalances.map(serializeTokenBalance),
    postTokenBalances: transaction.postTokenBalances.map(serializeTokenBalance),
    feeLamports: transaction.feeLamports.toString(),
    computeUnits: transaction.computeUnits?.toString() ?? null,
    error: transaction.error,
  };
}

function serializeInstruction(instruction: NormalizedInstruction): object {
  return {
    programId: instruction.programId,
    accounts: instruction.accounts,
    dataHex: Buffer.from(instruction.data).toString('hex'),
    instructionIndex: instruction.instructionIndex,
    innerInstructionIndex: instruction.innerInstructionIndex,
    parentInstructionIndex: instruction.parentInstructionIndex,
    stackHeight: instruction.stackHeight,
  };
}

function serializeTokenBalance(balance: NormalizedTokenBalance): object {
  return {
    accountIndex: balance.accountIndex,
    account: balance.account,
    mint: balance.mint,
    owner: balance.owner,
    tokenProgram: balance.tokenProgram,
    amountRaw: balance.amountRaw.toString(),
    decimals: balance.decimals,
  };
}

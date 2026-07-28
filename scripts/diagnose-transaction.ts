import { loadConfig } from '../src/config/env.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { TransactionFetcher } from '../src/solana/rpc/transaction-fetcher.js';
import { stringifyJson } from '../src/utils/json.js';

const signature = process.argv[2];
if (signature === undefined) throw new Error('Usage: npm run tx:diagnose -- <signature>');

const fetcher = new TransactionFetcher(new SolanaRpcClient(loadConfig()));
const transaction = await fetcher.fetch(signature, 'FINALIZED');
process.stdout.write(`${stringifyJson({ event: 'transaction.diagnosed', transaction })}\n`);

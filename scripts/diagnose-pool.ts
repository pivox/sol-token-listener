import { loadConfig } from '../src/config/env.js';
import { readPoolState } from '../src/dex/raydium-cpmm/pool-decoder.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { stringifyJson } from '../src/utils/json.js';

const poolAddress = process.argv[2];
if (poolAddress === undefined) throw new Error('Usage: npm run pool:diagnose -- <pool-address>');

const config = loadConfig();
const rpc = new SolanaRpcClient(config);
const result = await readPoolState(rpc.http, poolAddress, config.raydiumCpmmProgramId);
process.stdout.write(`${stringifyJson({ event: 'raydium.pool_diagnosed', ...result })}\n`);

import { loadConfig } from '../src/config/env.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';

const rpc = new SolanaRpcClient(loadConfig());
const health = await rpc.checkHealth();
process.stdout.write(`${JSON.stringify({
  event: 'rpc.checked',
  version: health.version,
  httpSlot: health.httpSlot.toString(),
  finalizedSlot: health.finalizedSlot.toString(),
})}\n`);

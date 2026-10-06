import { pathToFileURL } from 'node:url';
import { runNetworkPreflight } from '../live/network-preflight.js';

export async function main(environment: Readonly<Record<string, string | undefined>>): Promise<number> {
  const endpoint = environment.LIVE_RPC_URL;
  const expectedGenesisHash = environment.LIVE_EXPECTED_GENESIS_HASH;
  if (endpoint === undefined || expectedGenesisHash === undefined) {
    process.stderr.write('Live RPC preflight blocked: LIVE_RPC_URL and LIVE_EXPECTED_GENESIS_HASH are required.\n');
    return 2;
  }
  try {
    const report = await runNetworkPreflight(endpoint, expectedGenesisHash);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid preflight configuration.';
    process.stderr.write(`Live RPC preflight blocked: ${message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.env).then((code) => { process.exitCode = code; });
}

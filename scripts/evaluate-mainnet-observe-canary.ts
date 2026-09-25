import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMainnetObserveCanary } from './lib/mainnet-observe-canary-verdict.js';

export const MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES = 1_048_576;
const FIXED_ERROR = 'MAINNET_OBSERVE_CANARY_EVALUATION_FAILED\n';

export interface MainnetObserveCanaryCommandDependencies {
  readonly readInput: (path: string, maximumBytes: number) => Promise<string>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

const defaultDependencies: MainnetObserveCanaryCommandDependencies = Object.freeze({
  readInput: readBoundedRegularFile,
  writeStdout(value: string) { process.stdout.write(value); },
  writeStderr(value: string) { process.stderr.write(value); },
});

export async function runMainnetObserveCanaryCommand(
  args: readonly string[],
  dependencies: MainnetObserveCanaryCommandDependencies = defaultDependencies,
): Promise<0 | 1 | 2> {
  if (args.length !== 1 || args[0] === undefined || args[0].length === 0) {
    dependencies.writeStderr(FIXED_ERROR);
    return 1;
  }
  try {
    const input = await dependencies.readInput(args[0], MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES);
    if (Buffer.byteLength(input, 'utf8') > MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES) throw new Error();
    const parsed: unknown = JSON.parse(input);
    const result = evaluateMainnetObserveCanary(parsed);
    dependencies.writeStdout(`${JSON.stringify(result)}\n`);
    return result.overallVerdict === 'PASS' ? 0 : 2;
  } catch {
    dependencies.writeStderr(FIXED_ERROR);
    return 1;
  }
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<string> {
  const pathStat = await lstat(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maximumBytes) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 0 || fileStat.size > maximumBytes) throw new Error();
    const expectedBytes = fileStat.size;
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) throw new Error();
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exitCode = await runMainnetObserveCanaryCommand(process.argv.slice(2));
}

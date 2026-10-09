import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  SecretDistributionError,
  distributeSecrets,
  type DistributionFileSystem,
} from '../../src/deploy/secret-distribution.js';
import { isStackMode } from '../../src/deploy/stack.js';

export interface DistributeSecretsCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const NODE_FILE_SYSTEM: DistributionFileSystem = Object.freeze({
  exists: (path: string) => existsSync(path),
  makeDirectory: (path: string, mode: number) => { mkdirSync(path, { recursive: true, mode }); },
  copy: (source: string, target: string) => { copyFileSync(source, target); },
  chown: (path: string, uid: number, gid: number) => { chownSync(path, uid, gid); },
  chmod: (path: string, mode: number) => { chmodSync(path, mode); },
});

/** Run by `sol-entrypoint` as root. Exit codes: 0, 64 (usage), 77 (not root), 78 (missing secret). */
export function runDistributeSecretsCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: DistributeSecretsCliIo,
  options: Readonly<{ uid: number | undefined; fs: DistributionFileSystem }> = {
    uid: process.getuid?.(),
    fs: NODE_FILE_SYSTEM,
  },
): number {
  const [mode, ...rest] = argv;
  if (mode === undefined || rest.length > 0 || !isStackMode(mode)) {
    io.stderr('usage: distribute-secrets observe|live\n');
    return 64;
  }
  if (options.uid !== 0) {
    io.stderr('sol-entrypoint: only root distributes the secrets\n');
    return 77;
  }
  try {
    const files = distributeSecrets({
      mode,
      secretsDirectory: environment.SOL_SECRETS_DIR ?? '/root/secrets',
      runDirectory: environment.SOL_RUN_DIR ?? '/run/sol',
      fs: options.fs,
    });
    io.stdout(`${JSON.stringify({ service: 'sol-entrypoint', event: 'secrets.distributed', mode, files })}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof SecretDistributionError ? error.message : 'secret distribution failed';
    io.stderr(`sol-entrypoint: ${reason}\n`);
    return 78;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runDistributeSecretsCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHeliusProviderEvidenceConfig } from './config.js';
import { HeliusAdminUsageClient } from './helius-admin-client.js';
import {
  createHeliusProviderEvidenceService,
  type HeliusProviderEvidenceService,
} from './service.js';

const MAX_PROTECTED_FILE_BYTES = 8_192;

export async function readProtectedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const userId = process.getuid?.();
    const permissions = stat.mode & 0o777;
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROTECTED_FILE_BYTES
      || (userId !== undefined && stat.uid !== userId)
      || (permissions !== 0o400 && permissions !== 0o600)) throw new TypeError();
    const value = await handle.readFile('utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_PROTECTED_FILE_BYTES) throw new TypeError();
    return value;
  } finally {
    await handle.close();
  }
}

export async function writeAtomicEvidence(path: string, value: string): Promise<void> {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 131_072
    || value.includes('\0')) throw new TypeError();
  const userId = process.getuid?.();
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()
      || (userId !== undefined && existing.uid !== userId)) throw new TypeError();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporaryPath = join(dirname(path), `.provider-evidence-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    created = true;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(value, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function runHeliusProviderEvidenceCommand(
  service: HeliusProviderEvidenceService,
  signal: AbortSignal,
): Promise<string> {
  return JSON.stringify(await service.collect(signal));
}

export async function assertExternalEvidencePaths(
  applicationRoot: string,
  paths: readonly string[],
): Promise<void> {
  const canonicalRoot = await realpath(applicationRoot);
  for (const path of paths) {
    const canonicalParent = await realpath(dirname(path));
    const candidate = join(canonicalParent, basename(path));
    const relation = relative(canonicalRoot, candidate);
    if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
      && !isAbsolute(relation))) throw new TypeError();
  }
}

export async function main(): Promise<void> {
  const applicationRoot = await findApplicationRoot(fileURLToPath(import.meta.url));
  const config = parseHeliusProviderEvidenceConfig(process.env, applicationRoot);
  await assertExternalEvidencePaths(applicationRoot, [
    config.apiKeyPath, config.privateKeyPath, config.outputPath,
  ]);
  const abort = new AbortController();
  const stop = (): void => { abort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const service = createHeliusProviderEvidenceService({
      config,
      client: new HeliusAdminUsageClient(config.timeoutMs),
      readProtectedFile,
      writeEvidence: writeAtomicEvidence,
      now: Date.now,
    });
    process.stdout.write(`${await runHeliusProviderEvidenceCommand(service, abort.signal)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function findApplicationRoot(modulePath: string): Promise<string> {
  let candidate = dirname(modulePath);
  for (;;) {
    try {
      if ((await lstat(join(candidate, 'package.json'))).isFile()) return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw new TypeError();
    candidate = parent;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'ENOENT';
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('HELIUS_PROVIDER_EVIDENCE_FAILED\n');
    process.exitCode = 1;
  });
}

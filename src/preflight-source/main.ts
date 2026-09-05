import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { lstat, link, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringifyJson } from '../utils/json.js';
import { parseExecutionPreflightSourceConfig } from './config.js';
import {
  openExecutionPreflightSourceDatabase,
} from './database.js';
import type { ExecutionPreflightDraftSourceV1 } from '../domain/execution-preflight-draft.js';
import type { ExecutionPreflightSourceRequestV1 } from './repository.js';
import { createExecutionPreflightSourceExport } from './service.js';

export async function writeAtomicPreflightSource(
  outputPath: string,
  content: string,
  synchronize: (path: string) => Promise<void> = syncDirectory,
): Promise<void> {
  if (!isAbsolute(outputPath) || outputPath.includes('\0') || content.length === 0
    || Buffer.byteLength(content, 'utf8') > 1_048_576) throw new TypeError();
  const parent = dirname(outputPath);
  const temporary = join(parent, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let linked = false;
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporary, outputPath);
    linked = true;
    await unlink(temporary);
    await synchronize(parent);
    published = true;
  } finally {
    if (!published) {
      if (linked) await unlink(outputPath).catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export async function assertExternalPreflightSourcePath(
  applicationRoot: string,
  outputPath: string,
): Promise<void> {
  const root = await realpath(applicationRoot);
  const parent = await realpath(dirname(outputPath));
  const candidate = join(parent, basename(outputPath));
  const relation = relative(root, candidate);
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation))) throw new TypeError();
}

export async function runExecutionPreflightSourceCommand(
  database: Readonly<{
    repository: Readonly<{
      export: (request: ExecutionPreflightSourceRequestV1) =>
      Promise<ExecutionPreflightDraftSourceV1>;
    }>;
    evict: () => void;
    close: () => Promise<void>;
  }>,
  request: ExecutionPreflightSourceRequestV1,
  outputPath: string,
  publish: (path: string, content: string) => Promise<void> = writeAtomicPreflightSource,
  assertReadyToPublish: () => void = () => undefined,
): Promise<string> {
  let source;
  try {
    source = await database.repository.export(request);
  } finally {
    try { database.evict(); } finally { await database.close(); }
  }
  assertReadyToPublish();
  const exported = createExecutionPreflightSourceExport(source);
  await publish(outputPath, exported.sourceJson);
  return canonicalStringifyJson(exported.manifest);
}

export async function main(): Promise<void> {
  const applicationRoot = await findApplicationRoot(fileURLToPath(import.meta.url));
  const config = parseExecutionPreflightSourceConfig(process.env, applicationRoot);
  await assertExternalPreflightSourcePath(applicationRoot, config.outputPath);
  const idleState = { failed: false };
  const database = openExecutionPreflightSourceDatabase({ databaseUrl: config.databaseUrl,
    statementTimeoutMs: 10_000, onIdleError: () => { idleState.failed = true; } });
  const manifest = await runExecutionPreflightSourceCommand(database,
    { generationId: config.generationId, targetIntentId: config.targetIntentId,
      simulationArtifactId: config.simulationArtifactId }, config.outputPath,
    writeAtomicPreflightSource, () => { if (idleState.failed) throw new TypeError(); });
  process.stdout.write(`${manifest}\n`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function findApplicationRoot(modulePath: string): Promise<string> {
  let candidate = dirname(modulePath);
  for (;;) {
    try { if ((await lstat(join(candidate, 'package.json'))).isFile()) return candidate; }
    catch (error) { if (!isMissing(error)) throw error; }
    const parent = dirname(candidate);
    if (parent === candidate) throw new TypeError();
    candidate = parent;
  }
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('EXECUTION_PREFLIGHT_SOURCE_FAILED\n');
    process.exitCode = 1;
  });
}

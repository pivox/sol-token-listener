import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringifyJson } from '../utils/json.js';
import { parseExecutionPreflightDraftConfig } from './config.js';
import { assembleExecutionPreflightDraft } from './service.js';

export async function readProtectedDraftInput(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const uid = process.getuid?.();
    const mode = stat.mode & 0o777;
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes
      || (uid !== undefined && stat.uid !== uid) || (mode !== 0o400 && mode !== 0o600)) {
      throw new TypeError();
    }
    const content = await handle.readFile('utf8');
    if (content.length === 0 || content.includes('\0')
      || Buffer.byteLength(content, 'utf8') > maximumBytes) throw new TypeError();
    return content;
  } finally { await handle.close(); }
}

export async function writeAtomicDraft(
  outputPath: string,
  content: string,
  synchronize: (path: string) => Promise<void> = syncDirectory,
): Promise<void> {
  if (!isAbsolute(outputPath) || outputPath.includes('\0') || content.length === 0
    || Buffer.byteLength(content, 'utf8') > 1_048_576) throw new TypeError();
  const parent = dirname(outputPath);
  const temporary = join(parent, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let published = false;
  let linked = false;
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

export async function assertExternalDraftPaths(
  applicationRoot: string,
  inputPaths: readonly string[],
  outputPath: string,
): Promise<void> {
  const root = await realpath(applicationRoot);
  for (const input of inputPaths) assertOutside(root, await realpath(input));
  const parent = await realpath(dirname(outputPath));
  assertOutside(root, join(parent, basename(outputPath)));
}

export async function main(): Promise<void> {
  const applicationRoot = await findApplicationRoot(fileURLToPath(import.meta.url));
  const config = parseExecutionPreflightDraftConfig(process.env, applicationRoot);
  await assertExternalDraftPaths(applicationRoot,
    [config.sourcePath, config.gateCatalogPath], config.outputPath);
  const [source, catalog] = await Promise.all([
    readProtectedDraftInput(config.sourcePath, 1_048_576),
    readProtectedDraftInput(config.gateCatalogPath, 1_048_576),
  ]);
  const result = assembleExecutionPreflightDraft(source, catalog);
  await writeAtomicDraft(config.outputPath, result.draftJson);
  process.stdout.write(`${canonicalStringifyJson(result.manifest)}\n`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
function assertOutside(parent: string, candidate: string): void {
  const relation = relative(parent, candidate);
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation))) throw new TypeError();
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
    process.stderr.write('EXECUTION_PREFLIGHT_DRAFT_FAILED\n');
    process.exitCode = 1;
  });
}

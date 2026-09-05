import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringifyJson } from '../utils/json.js';
import { parseExecutionPreflightBundleConfig } from './config.js';
import { createExecutionPreflightBundlePackage } from './service.js';

interface AtomicBundleFiles {
  readonly qualificationEnvelope: string;
  readonly canaryEnvelope: string;
  readonly manifestJson: string;
}

export async function readPreflightProtectedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const userId = process.getuid?.();
    const permissions = stat.mode & 0o777;
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes
      || (userId !== undefined && stat.uid !== userId)
      || (permissions !== 0o400 && permissions !== 0o600)) throw new TypeError();
    const content = await handle.readFile('utf8');
    if (content.length === 0 || Buffer.byteLength(content, 'utf8') > maximumBytes
      || content.includes('\0')) throw new TypeError();
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeAtomicPreflightBundle(
  outputDirectory: string,
  files: AtomicBundleFiles,
  synchronize: (path: string) => Promise<void> = syncDirectory,
): Promise<void> {
  validateOutput(outputDirectory, files);
  await assertMissing(outputDirectory);
  const parent = dirname(outputDirectory);
  const temporaryDirectory = await mkdtemp(join(parent, `.preflight-bundle-${randomUUID()}-`));
  let published = false;
  let renamed = false;
  try {
    await import('node:fs/promises').then(({ chmod }) => chmod(temporaryDirectory, 0o700));
    await writeProtected(join(temporaryDirectory, 'qualification.json'), files.qualificationEnvelope);
    await writeProtected(join(temporaryDirectory, 'canary.json'), files.canaryEnvelope);
    await writeProtected(join(temporaryDirectory, 'manifest.json'), files.manifestJson);
    await synchronize(temporaryDirectory);
    await assertMissing(outputDirectory);
    await rename(temporaryDirectory, outputDirectory);
    renamed = true;
    await synchronize(parent);
    published = true;
  } finally {
    if (!published) await rm(renamed ? outputDirectory : temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

export async function assertExternalPreflightBundlePaths(
  applicationRoot: string,
  inputPaths: readonly string[],
  outputDirectory: string,
): Promise<void> {
  const canonicalRoot = await realpath(applicationRoot);
  for (const path of inputPaths) assertOutside(canonicalRoot, await realpath(path));
  const canonicalParent = await realpath(dirname(outputDirectory));
  assertOutside(canonicalRoot, join(canonicalParent, basename(outputDirectory)));
}

export async function main(): Promise<void> {
  const applicationRoot = await findApplicationRoot(fileURLToPath(import.meta.url));
  const config = parseExecutionPreflightBundleConfig(process.env, applicationRoot);
  await assertExternalPreflightBundlePaths(
    applicationRoot,
    [config.draftPath, config.privateKeyPath],
    config.outputDirectory,
  );
  const encodedDraft = await readPreflightProtectedFile(config.draftPath, 1_048_576);
  const privateKey = await readPreflightProtectedFile(config.privateKeyPath, 8_192);
  const packaged = createExecutionPreflightBundlePackage(encodedDraft, privateKey);
  const manifestJson = canonicalStringifyJson(packaged.manifest);
  await writeAtomicPreflightBundle(config.outputDirectory, Object.freeze({
    qualificationEnvelope: packaged.qualificationEnvelope,
    canaryEnvelope: packaged.canaryEnvelope,
    manifestJson,
  }));
  process.stdout.write(`${manifestJson}\n`);
}

function validateOutput(outputDirectory: string, files: AtomicBundleFiles): void {
  if (!isAbsolute(outputDirectory) || outputDirectory.includes('\0')) throw new TypeError();
  const values = [files.qualificationEnvelope, files.canaryEnvelope, files.manifestJson];
  if (values.some((value) => value.length === 0 || value.includes('\0'))
    || Buffer.byteLength(files.qualificationEnvelope, 'utf8') > 131_072
    || Buffer.byteLength(files.canaryEnvelope, 'utf8') > 196_608
    || Buffer.byteLength(files.manifestJson, 'utf8') > 32_768) throw new TypeError();
}

async function writeProtected(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new TypeError();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function assertOutside(parent: string, candidate: string): void {
  const relation = relative(parent, candidate);
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation))) throw new TypeError();
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
    process.stderr.write('EXECUTION_PREFLIGHT_BUNDLE_FAILED\n');
    process.exitCode = 1;
  });
}

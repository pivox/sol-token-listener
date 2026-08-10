import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';

const canonicalProfileName = 'pumpfun-v1-unvalidated.json' as const;
const MAX_PROFILE_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface CopyQualificationProfilesOptions {
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
}

export async function copyQualificationProfiles(
  options: CopyQualificationProfilesOptions,
): Promise<readonly ['pumpfun-v1-unvalidated.json']> {
  const sourceDirectory = safeDirectoryPath(options.sourceDirectory, 'source');
  const targetDirectory = safeDirectoryPath(options.targetDirectory, 'target');
  const sourceBytes = readCanonicalProfile(sourceDirectory);
  validateProfile(sourceBytes);
  prepareTargetDirectory(sourceDirectory, targetDirectory);
  await writeFile(join(targetDirectory, canonicalProfileName), sourceBytes, { flag: 'wx' });
  return Object.freeze([canonicalProfileName]);
}

function safeDirectoryPath(value: string, label: 'source' | 'target'): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new Error(`Unsafe ${label} directory.`);
  }
  const resolved = resolve(value);
  if (resolved === parse(resolved).root) throw new Error(`Unsafe ${label} directory.`);
  return resolved;
}

function readCanonicalProfile(sourceDirectory: string): Buffer {
  assertSafeExistingDirectory(sourceDirectory, 'source');
  const profilePath = join(sourceDirectory, canonicalProfileName);
  const listed = lstatSync(profilePath);
  if (!listed.isFile() || listed.isSymbolicLink()) throw new Error('Qualification profile source must be a regular file.');

  let descriptor: number | null = null;
  try {
    descriptor = openSync(profilePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.dev !== listed.dev || stats.ino !== listed.ino || stats.size > MAX_PROFILE_BYTES) {
      throw new Error('Qualification profile source is unsafe.');
    }
    const contents = Buffer.allocUnsafe(MAX_PROFILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const read = readSync(descriptor, contents, bytesRead, contents.length - bytesRead, null);
      if (read === 0) break;
      bytesRead += read;
    }
    if (bytesRead > MAX_PROFILE_BYTES) throw new Error('Qualification profile source is too large.');
    return Buffer.from(contents.subarray(0, bytesRead));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validateProfile(bytes: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Qualification profile source is invalid.');
  }
  parseQualificationProfile(deepFreeze(parsed), null);
}

function prepareTargetDirectory(sourceDirectory: string, targetDirectory: string): void {
  const sourceRealPath = realpathSync(sourceDirectory);
  if (pathsOverlap(sourceRealPath, targetDirectory)) throw new Error('Source and target directories must not overlap.');

  try {
    const targetStats = lstatSync(targetDirectory);
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) throw new Error('Unsafe target directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(targetDirectory, { recursive: true });
  }
  const targetRealPath = realpathSync(targetDirectory);
  if (pathsOverlap(sourceRealPath, targetRealPath)) throw new Error('Source and target directories must not overlap.');

  rmSync(targetDirectory, { recursive: true, force: true });
  mkdirSync(targetDirectory, { recursive: true });
  assertSafeExistingDirectory(targetDirectory, 'target');
}

function assertSafeExistingDirectory(directory: string, label: 'source' | 'target'): void {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe ${label} directory.`);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftRelative = relative(left, right);
  const rightRelative = relative(right, left);
  return leftRelative === '' || rightRelative === ''
    || (!leftRelative.startsWith(`..${sep}`) && leftRelative !== '..' && !isAbsolute(leftRelative))
    || (!rightRelative.startsWith(`..${sep}`) && rightRelative !== '..' && !isAbsolute(rightRelative));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function main(): Promise<void> {
  const names = await copyQualificationProfiles({
    sourceDirectory: resolve(repositoryRoot, 'config/qualification'),
    targetDirectory: resolve(repositoryRoot, 'dist/config/qualification'),
  });
  process.stdout.write(`Packaged ${names.length} qualification profile.\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}

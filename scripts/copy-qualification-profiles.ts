import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseQualificationProfileJson } from '../src/qualification/qualification-profile.js';

const canonicalProfileName = 'pumpfun-v1-unvalidated.json' as const;
const MAX_PROFILE_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

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
  await replaceTargetDirectory(sourceDirectory, targetDirectory, sourceBytes);
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
  try {
    parseQualificationProfileJson(bytes, null);
  } catch {
    throw new Error('Qualification profile source is invalid.');
  }
}

async function replaceTargetDirectory(sourceDirectory: string, targetDirectory: string, sourceBytes: Buffer): Promise<void> {
  const sourceRealPath = realpathSync(sourceDirectory);
  const canonicalTarget = canonicalTargetDirectory(sourceRealPath, targetDirectory);
  const sourceIdentity = directoryIdentity(sourceDirectory, 'source');
  const targetParent = dirname(canonicalTarget);
  mkdirSync(targetParent, { recursive: true });
  const stableTargetParent = realpathSync(targetParent);
  const stableTargetDirectory = join(stableTargetParent, basename(canonicalTarget));
  assertSafeTargetDirectory(sourceRealPath, stableTargetDirectory);
  const stagingDirectory = mkdtempSync(join(stableTargetParent, '.qualification-profile-stage-'));
  const stagingIdentity = directoryIdentity(stagingDirectory, 'target');
  try {
    await writeFile(join(stagingDirectory, canonicalProfileName), sourceBytes, { flag: 'wx', mode: 0o600 });
    const targetIdentity = ensureTargetDirectory(stableTargetDirectory, sourceDirectory, sourceIdentity);
    const entries = directTargetEntries(stableTargetDirectory);
    for (const entry of entries) {
      assertStableDirectories(stableTargetDirectory, targetIdentity, sourceDirectory, sourceIdentity);
      const entryPath = join(stableTargetDirectory, entry.name);
      if (!sameIdentity(entryIdentity(entryPath), entry.identity)) throw new Error('Target entry changed before replacement.');
      unlinkSync(entryPath);
    }
    assertStableDirectories(stableTargetDirectory, targetIdentity, sourceDirectory, sourceIdentity);
    if (readdirSync(stableTargetDirectory).length !== 0) throw new Error('Target directory changed before replacement.');
    if (!sameIdentity(directoryIdentity(stagingDirectory, 'target'), stagingIdentity)) throw new Error('Staging directory changed before replacement.');
    renameSync(join(stagingDirectory, canonicalProfileName), join(stableTargetDirectory, canonicalProfileName));
  } finally {
    removePrivateStagingDirectory(stagingDirectory, stagingIdentity);
  }
}

function canonicalTargetDirectory(sourceRealPath: string, targetDirectory: string): string {
  const requestedParent = dirname(targetDirectory);
  const targetName = basename(targetDirectory);
  const existingAncestor = nearestExistingAncestor(requestedParent);
  const canonicalParent = join(realpathSync(existingAncestor.directory), ...existingAncestor.descendants);
  const canonicalTarget = join(canonicalParent, targetName);
  assertSafeTargetDirectory(sourceRealPath, canonicalTarget);
  return canonicalTarget;
}

function nearestExistingAncestor(directory: string): { readonly directory: string; readonly descendants: readonly string[] } {
  const descendants: string[] = [];
  let current = directory;
  for (;;) {
    try {
      if (!statSync(current).isDirectory()) throw new Error('Unsafe target directory.');
      return Object.freeze({ directory: current, descendants: Object.freeze(descendants) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error('Unsafe target directory.');
      descendants.unshift(basename(current));
      current = parent;
    }
  }
}

function assertSafeTargetDirectory(sourceRealPath: string, targetDirectory: string): void {
  const currentWorkingDirectory = resolve(process.cwd());
  if (isSameOrAncestor(targetDirectory, currentWorkingDirectory)
    || isSameOrAncestor(targetDirectory, repositoryRoot)
    || pathsOverlap(sourceRealPath, targetDirectory)) {
    throw new Error('Unsafe target directory.');
  }
}

function existingDirectoryIdentity(directory: string): DirectoryIdentity | null {
  try {
    return directoryIdentity(directory, 'target');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensureTargetDirectory(
  directory: string,
  sourceDirectory: string,
  sourceIdentity: DirectoryIdentity,
): DirectoryIdentity {
  const existing = existingDirectoryIdentity(directory);
  if (existing !== null) return existing;
  if (!sameIdentity(directoryIdentity(sourceDirectory, 'source'), sourceIdentity)) {
    throw new Error('Source directory changed before replacement.');
  }
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return directoryIdentity(directory, 'target');
}

interface TargetEntry {
  readonly name: string;
  readonly identity: EntryIdentity;
}

interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

function directTargetEntries(directory: string): readonly TargetEntry[] {
  return Object.freeze(readdirSync(directory).sort((left, right) => left.localeCompare(right)).map((name) => {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error('Target directory contains unsafe entries.');
    return Object.freeze({ name, identity: Object.freeze({ device: stats.dev, inode: stats.ino }) });
  }));
}

function entryIdentity(path: string): EntryIdentity {
  const stats = lstatSync(path);
  if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error('Target directory contains unsafe entries.');
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function assertStableDirectories(
  targetDirectory: string,
  targetIdentity: DirectoryIdentity,
  sourceDirectory: string,
  sourceIdentity: DirectoryIdentity,
): void {
  if (!sameIdentity(directoryIdentity(targetDirectory, 'target'), targetIdentity)
    || !sameIdentity(directoryIdentity(sourceDirectory, 'source'), sourceIdentity)) {
    throw new Error('Source or target directory changed during replacement.');
  }
}

function assertSafeExistingDirectory(directory: string, label: 'source' | 'target'): void {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe ${label} directory.`);
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

function directoryIdentity(directory: string, label: 'source' | 'target'): DirectoryIdentity {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe ${label} directory.`);
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function removePrivateStagingDirectory(directory: string, expected: DirectoryIdentity): void {
  try {
    if (!sameIdentity(directoryIdentity(directory, 'target'), expected)) return;
    const profilePath = join(directory, canonicalProfileName);
    try {
      const profile = lstatSync(profilePath);
      if (profile.isSymbolicLink() || !profile.isFile()) return;
      unlinkSync(profilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    if (sameIdentity(directoryIdentity(directory, 'target'), expected)) rmdirSync(directory);
  } catch { /* A failed private staging cleanup is retained rather than broadened. */ }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftRelative = relative(left, right);
  const rightRelative = relative(right, left);
  return leftRelative === '' || rightRelative === ''
    || (!leftRelative.startsWith(`..${sep}`) && leftRelative !== '..' && !isAbsolute(leftRelative))
    || (!rightRelative.startsWith(`..${sep}`) && rightRelative !== '..' && !isAbsolute(rightRelative));
}

function isSameOrAncestor(ancestor: string, descendant: string): boolean {
  const path = relative(ancestor, descendant);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
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

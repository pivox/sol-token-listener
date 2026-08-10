import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';

const canonicalProfileName = 'pumpfun-v1-unvalidated.json' as const;
const MAX_PROFILE_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const MAX_PROFILE_JSON_NODES = 4_096;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Qualification profile source is invalid.');
  }
  parseQualificationProfile(deepFreeze(parsed), null);
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
  let stagingMoved = false;
  try {
    await writeFile(join(stagingDirectory, canonicalProfileName), sourceBytes, { flag: 'wx', mode: 0o600 });
    const targetIdentity = existingDirectoryIdentity(stableTargetDirectory);
    if (targetIdentity === null) {
      if (!sameIdentity(directoryIdentity(stagingDirectory, 'target'), stagingIdentity)) throw new Error('Staging directory changed before replacement.');
      renameSync(stagingDirectory, stableTargetDirectory);
      stagingMoved = true;
      return;
    }

    const quarantineDirectory = mkdtempSync(join(targetParent, '.qualification-profile-quarantine-'));
    rmdirSync(quarantineDirectory);
    if (!sameIdentity(directoryIdentity(stableTargetDirectory, 'target'), targetIdentity)) throw new Error('Target directory changed before replacement.');
    renameSync(stableTargetDirectory, quarantineDirectory);
    const quarantinedIdentity = directoryIdentity(quarantineDirectory, 'target');
    if (!sameIdentity(quarantinedIdentity, targetIdentity)) {
      restoreDirectory(quarantineDirectory, stableTargetDirectory);
      throw new Error('Target directory changed during replacement.');
    }
    if (!sameIdentity(directoryIdentity(sourceDirectory, 'source'), sourceIdentity)) {
      restoreSourceDirectory(quarantineDirectory, sourceDirectory, sourceIdentity);
      throw new Error('Source directory changed during replacement.');
    }
    if (!sameIdentity(directoryIdentity(stagingDirectory, 'target'), stagingIdentity)) throw new Error('Staging directory changed before replacement.');
    renameSync(stagingDirectory, stableTargetDirectory);
    stagingMoved = true;
  } finally {
    if (!stagingMoved) removePrivateStagingDirectory(stagingDirectory, stagingIdentity);
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

function restoreDirectory(from: string, to: string): void {
  try { renameSync(from, to); } catch { /* Preserve the unique quarantine if rollback is no longer safe. */ }
}

function restoreSourceDirectory(quarantineDirectory: string, sourceDirectory: string, sourceIdentity: DirectoryIdentity): void {
  try {
    if (sameIdentity(directoryIdentity(quarantineDirectory, 'target'), sourceIdentity)) renameSync(quarantineDirectory, sourceDirectory);
  } catch { /* Preserve the unique quarantine if the source cannot be restored safely. */ }
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

function deepFreeze<T>(value: T): T {
  try {
    const pending: { readonly value: object; readonly freeze: boolean }[] = [];
    const seen = new Set<object>();
    if (value !== null && typeof value === 'object') pending.push({ value, freeze: false });
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current.freeze) {
        Object.freeze(current.value);
        continue;
      }
      if (seen.has(current.value)) continue;
      if (seen.size >= MAX_PROFILE_JSON_NODES) throw new Error('Qualification profile source is invalid.');
      seen.add(current.value);
      pending.push({ value: current.value, freeze: true });
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current.value))) {
        const child: unknown = 'value' in descriptor ? descriptor.value : undefined;
        if (child !== null && typeof child === 'object') {
          pending.push({ value: child, freeze: false });
        }
      }
    }
  } catch {
    throw new Error('Qualification profile source is invalid.');
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

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const canonicalMigrationName = /^\d+_[a-z0-9_-]+\.sql$/u;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface CopyMigrationArtifactsOptions {
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
}

export async function copyMigrationArtifacts(
  options: CopyMigrationArtifactsOptions,
): Promise<readonly string[]> {
  const names = (await readdir(options.sourceDirectory))
    .filter((name) => canonicalMigrationName.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error('No canonical migration SQL files found.');

  await rm(options.targetDirectory, { recursive: true, force: true });
  await mkdir(options.targetDirectory, { recursive: true });
  for (const name of names) {
    await copyFile(join(options.sourceDirectory, name), join(options.targetDirectory, name));
  }
  return Object.freeze(names);
}

async function main(): Promise<void> {
  const names = await copyMigrationArtifacts({
    sourceDirectory: resolve(repositoryRoot, 'migrations'),
    targetDirectory: resolve(repositoryRoot, 'dist/migrations'),
  });
  process.stdout.write(`Packaged ${names.length} PostgreSQL migrations.\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}

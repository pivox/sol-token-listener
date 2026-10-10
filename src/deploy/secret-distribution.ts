import {
  REQUIRED_ROLES,
  ROLES,
  ROLE_NAMES,
  STACK_USERS,
  STACK_USER_NAMES,
  roleSecretFiles,
  type SecretSource,
  type StackMode,
  type StackUser,
} from './stack.js';

export interface SecretGrant {
  readonly user: StackUser;
  readonly source: SecretSource;
  readonly file: string;
  /** A program supervisord starts in this mode reads it: its absence stops the container. */
  readonly required: boolean;
}

export class SecretDistributionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecretDistributionError';
  }
}

/** Which secret file each Unix user receives in a mode (spec 7.2). */
export function secretGrants(mode: StackMode): readonly SecretGrant[] {
  const required = new Set<string>(REQUIRED_ROLES[mode]);
  const grants = new Map<string, SecretGrant>();
  for (const name of ROLE_NAMES) {
    const role = ROLES[name];
    for (const secret of roleSecretFiles(role)) {
      const key = `${role.user}/${secret.file}`;
      grants.set(key, Object.freeze({
        user: role.user,
        source: secret.source,
        file: secret.file,
        required: required.has(name) || grants.get(key)?.required === true,
      }));
    }
  }
  return Object.freeze([...grants.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, grant]) => grant));
}

export interface DistributionFileSystem {
  readonly exists: (path: string) => boolean;
  readonly makeDirectory: (path: string, mode: number) => void;
  readonly copy: (source: string, target: string) => void;
  readonly chown: (path: string, uid: number, gid: number) => void;
  readonly chmod: (path: string, mode: number) => void;
}

/**
 * Copies every present secret into `<runDirectory>/<user>/`: directory 0700 and file 0400, both
 * owned by the user. Every required file is checked first, so a missing one changes nothing.
 */
export function distributeSecrets(input: Readonly<{
  mode: StackMode;
  secretsDirectory: string;
  runDirectory: string;
  fs: DistributionFileSystem;
}>): number {
  const grants = secretGrants(input.mode);
  const source = (grant: SecretGrant): string =>
    `${input.secretsDirectory}/${grant.source}/${grant.file}`;
  const missing = [...new Set(grants
    .filter((grant) => grant.required && !input.fs.exists(source(grant)))
    .map((grant) => `${grant.source}/${grant.file}`))].sort();
  if (missing.length > 0) {
    throw new SecretDistributionError(
      `missing required secret files for ${input.mode}: ${missing.join(', ')}`,
    );
  }
  for (const user of STACK_USER_NAMES) {
    const directory = `${input.runDirectory}/${user}`;
    input.fs.makeDirectory(directory, 0o700);
    input.fs.chown(directory, STACK_USERS[user], STACK_USERS[user]);
    input.fs.chmod(directory, 0o700);
  }
  let copied = 0;
  for (const grant of grants) {
    if (!input.fs.exists(source(grant))) continue;
    const target = `${input.runDirectory}/${grant.user}/${grant.file}`;
    input.fs.copy(source(grant), target);
    input.fs.chown(target, STACK_USERS[grant.user], STACK_USERS[grant.user]);
    input.fs.chmod(target, 0o400);
    copied += 1;
  }
  return copied;
}

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  RoleEnvironmentError,
  buildRoleEnvironment,
  renderShellExports,
} from '../../src/deploy/role-environment.js';
import { ROLES, isRoleName, isStackMode } from '../../src/deploy/stack.js';

export interface RoleEnvCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Prints the `export` lines `sol-run` evaluates before it execs a process of the stack.
 * Exit codes: 0, 64 (usage), 78 (EX_CONFIG: missing or invalid configuration or secret).
 */
export function runRoleEnvCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: RoleEnvCliIo,
): number {
  const [role, ...rest] = argv;
  if (role === undefined || rest.length > 0 || !isRoleName(role)) {
    io.stderr('usage: role-env <role>\n');
    return 64;
  }
  try {
    const mode = environment.SOL_STACK_MODE ?? 'observe';
    if (!isStackMode(mode)) throw new RoleEnvironmentError('SOL_STACK_MODE must be observe or live');
    const definition = ROLES[role];
    const configDirectory = environment.SOL_CONFIG_DIR ?? '/etc/sol/config';
    const runDirectory = environment.SOL_RUN_DIR ?? '/run/sol';
    const overridePath = `${runDirectory}/overrides/${definition.configFile}`;
    io.stdout(renderShellExports(buildRoleEnvironment({
      role,
      mode,
      databaseName: environment.POSTGRES_DB ?? 'sol_token_listener',
      configText: readRequired(`${configDirectory}/${definition.configFile}`),
      overrideText: existsSync(overridePath) ? readRequired(overridePath) : null,
      runDirectory,
      readSecret: readRequired,
      secretExists: (path) => existsSync(path),
    })));
    return 0;
  } catch (error) {
    const reason = error instanceof RoleEnvironmentError ? error.message : 'cannot build the environment';
    io.stderr(`sol-run ${role}: ${reason}\n`);
    return 78;
  }
}

function readRequired(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new RoleEnvironmentError(`missing file ${path}`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runRoleEnvCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}

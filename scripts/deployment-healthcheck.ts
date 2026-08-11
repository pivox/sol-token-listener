import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  DeploymentHealthcheckError,
  checkDeploymentHealth,
  type DeploymentHealthcheckCode,
} from '../src/operations/deployment-healthcheck.js';

/**
 * Process exit contract for the deployment health probe:
 * - 0: the health envelope is accepted; the command stays silent.
 * - 1: a runtime probe failure; one stable, redacted JSON line is emitted.
 * - 2: invalid arguments or API_PORT; one stable, redacted JSON line is emitted.
 */
export const DEPLOYMENT_HEALTHCHECK_EXIT_CODES = Object.freeze({
  HEALTHY: 0,
  PROBE_FAILED: 1,
  API_PORT_INVALID: 2,
  CONFIGURATION_INVALID: 2,
} as const);

export interface DeploymentHealthcheckCliOptions {
  readonly arguments?: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly check: (
    url: string,
    options: Readonly<{ requireOk: boolean }>,
  ) => Promise<void>;
}

export function deploymentHealthcheckUrl(environment: NodeJS.ProcessEnv): string {
  let raw: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, 'API_PORT');
    if (descriptor !== undefined && !('value' in descriptor)) throw new TypeError('invalid');
    raw = descriptor?.value;
  } catch {
    throw new DeploymentHealthcheckError('HEALTHCHECK_PORT_INVALID');
  }
  const port = raw === undefined || raw === '' ? 3_000 : parsePort(raw);
  return `http://127.0.0.1:${port}/api/v1/health`;
}

export async function runDeploymentHealthcheckCli(options: DeploymentHealthcheckCliOptions): Promise<number> {
  let requireOk: boolean;
  try {
    requireOk = requireOkFromArguments(options.arguments ?? []);
  } catch (error: unknown) {
    writeResult(options.write, codeOf(error, 'HEALTHCHECK_ARGUMENTS_INVALID'));
    return DEPLOYMENT_HEALTHCHECK_EXIT_CODES.CONFIGURATION_INVALID;
  }
  let url: string;
  try {
    url = deploymentHealthcheckUrl(options.environment);
  } catch (error: unknown) {
    writeResult(options.write, codeOf(error, 'HEALTHCHECK_PORT_INVALID'));
    return DEPLOYMENT_HEALTHCHECK_EXIT_CODES.API_PORT_INVALID;
  }
  try {
    await options.check(url, Object.freeze({ requireOk }));
    return DEPLOYMENT_HEALTHCHECK_EXIT_CODES.HEALTHY;
  } catch (error: unknown) {
    writeResult(options.write, codeOf(error, 'HEALTHCHECK_REQUEST_FAILED'));
    return DEPLOYMENT_HEALTHCHECK_EXIT_CODES.PROBE_FAILED;
  }
}

function requireOkFromArguments(args: readonly string[]): boolean {
  try {
    if (args.length === 0) return false;
    if (args.length === 1 && args[0] === '--require-ok') return true;
  } catch {
    // Hostile argv-like values map to the same stable public error.
  }
  throw new DeploymentHealthcheckError('HEALTHCHECK_ARGUMENTS_INVALID');
}

function parsePort(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new DeploymentHealthcheckError('HEALTHCHECK_PORT_INVALID');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new DeploymentHealthcheckError('HEALTHCHECK_PORT_INVALID');
  }
  return port;
}

function codeOf(error: unknown, fallback: DeploymentHealthcheckCode): DeploymentHealthcheckCode {
  return error instanceof DeploymentHealthcheckError ? error.code : fallback;
}

function writeResult(write: (line: string) => void, code: DeploymentHealthcheckCode): void {
  write(`${JSON.stringify({ event: 'deployment.healthcheck', code })}\n`);
}

async function main(): Promise<void> {
  process.exitCode = await runDeploymentHealthcheckCli({
    arguments: process.argv.slice(2),
    environment: process.env,
    write: (line) => { process.stderr.write(line); },
    check: async (url, options) => checkDeploymentHealth(url, {
      fetch: globalThis.fetch,
      requireOk: options.requireOk,
    }),
  });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}

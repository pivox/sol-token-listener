import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  DeploymentHealthcheckError,
  checkDeploymentHealth,
  type DeploymentHealthcheckCode,
} from '../src/operations/deployment-healthcheck.js';

export interface DeploymentHealthcheckCliOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly check: (url: string) => Promise<void>;
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
  let url: string;
  try {
    url = deploymentHealthcheckUrl(options.environment);
  } catch (error: unknown) {
    writeResult(options.write, codeOf(error, 'HEALTHCHECK_PORT_INVALID'));
    return 2;
  }
  try {
    await options.check(url);
    return 0;
  } catch (error: unknown) {
    writeResult(options.write, codeOf(error, 'HEALTHCHECK_REQUEST_FAILED'));
    return 1;
  }
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
    environment: process.env,
    write: (line) => { process.stderr.write(line); },
    check: async (url) => checkDeploymentHealth(url, { fetch: globalThis.fetch }),
  });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}

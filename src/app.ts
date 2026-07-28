import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/env.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const startup = {
    component: 'sol-token-listener',
    event: 'listener.starting',
    executionMode: config.executionMode,
    cluster: config.cluster,
    paperQuoteMintAllowlist: config.paperQuoteMintAllowlist,
    qualificationRuleSetStatus: config.qualificationRuleSetStatus,
  };

  process.stdout.write(`${JSON.stringify(startup)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({
      component: 'sol-token-listener',
      event: 'listener.start_failed',
      error: message,
    })}\n`);
    process.exitCode = 1;
  });
}

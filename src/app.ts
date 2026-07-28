import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/env.js';
import { createQualificationEngine } from './qualification/qualification-engine.js';
import { closeDatabase, migrateDatabase } from './storage/database.js';
import { logger } from './utils/logger.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const qualificationEngine = createQualificationEngine(config);
  if (config.autoMigrate) {
    const appliedMigrations = await migrateDatabase();
    logger.info({ appliedMigrations }, 'Migrations PostgreSQL appliquées.');
  }
  logger.info({
    event: 'listener.foundation_ready',
    executionMode: config.executionMode,
    cluster: config.cluster,
    paperQuoteMintAllowlist: config.paperQuoteMintAllowlist,
    qualificationRuleSetStatus: config.qualificationRuleSetStatus,
    qualificationMinimumScore: qualificationEngine.minimumTotalScore,
    pumpFunListenerActive: false,
    transactionSubmissionEnabled: false,
  }, 'Socle d’observation prêt; l’adaptateur Pump.fun sera activé dans une PR ultérieure.');
  await closeDatabase();
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.fatal({
      event: 'listener.start_failed',
      error: message,
    }, 'Initialisation du socle impossible.');
    process.exitCode = 1;
    return closeDatabase();
  });
}

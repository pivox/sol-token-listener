import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import { PRODUCTION_API_PIPELINE_STATE, reportEntrypointFailure, runApplication, waitForShutdownSignal } from '../src/app.js';
import type { ApiEventStreamRepository } from '../src/ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from '../src/ports/api-projection-repository.js';
import { PostgresApiProjectionRepository, type Queryable } from '../src/storage/api-projection.repository.js';

const FORBIDDEN_IMPORTS = [
  'execution/wallet',
  'execution/transaction-confirmer',
  'execution/trade-executor',
  'dex/raydium-cpmm/transaction-builder',
] as const;

void test('le bootstrap V1 ne dépend d’aucun composant de signature ou envoi', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  for (const forbidden of FORBIDDEN_IMPORTS) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
  }
});

const config = parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
});

void test('le bootstrap désactivé ne crée ni serveur ni connexion et ferme proprement', async () => {
  const calls: string[] = [];
  await runApplication({
    loadConfig: () => ({ ...config, apiEnabled: false }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: () => { throw new Error('must not open database'); },
    migrateDatabase: async () => [],
    createProjectionRepository: () => { throw new Error('must not construct repository'); },
    createEventStreamRepository: () => { throw new Error('must not construct repository'); },
    createApiServer: () => { throw new Error('must not create server'); },
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => 'SIGTERM',
    logInfo: () => { calls.push('log'); },
  });
  assert.deepEqual(calls, ['log', 'database.close']);
});

void test('le bootstrap API partage le pool puis ferme le serveur avant la base', async () => {
  const calls: string[] = [];
  const pool = {};
  const server = {
    async listen() { calls.push('server.listen'); return { host: '127.0.0.1', port: 32123 }; },
    async close() { calls.push('server.close'); },
  };
  await runApplication({
    loadConfig: () => ({ ...config, apiEnabled: true, autoMigrate: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: (url) => { calls.push(`pool:${url === config.databaseUrl}`); return pool; },
    migrateDatabase: async (receivedPool) => { assert.equal(receivedPool, pool); calls.push('migrate'); return []; },
    createProjectionRepository: (receivedPool, pipeline) => {
      assert.equal(receivedPool, pool);
      assert.deepEqual(pipeline, PRODUCTION_API_PIPELINE_STATE);
      calls.push('projections');
      return {} as ApiProjectionRepository;
    },
    createEventStreamRepository: (receivedPool) => { assert.equal(receivedPool, pool); calls.push('stream'); return {} as ApiEventStreamRepository; },
    createApiServer: (options) => { assert.equal(options.projections, options.projections); calls.push('server.create'); return server; },
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => { calls.push('signal.wait'); return 'SIGTERM'; },
    logInfo: () => { calls.push('log'); },
  });
  assert.deepEqual(calls, [
    'log', 'pool:true', 'migrate', 'log', 'projections', 'stream', 'server.create',
    'server.listen', 'log', 'signal.wait', 'server.close', 'database.close',
  ]);
});

void test('le bootstrap désactivé conserve la migration automatique sans créer de serveur', async () => {
  const calls: string[] = [];
  const pool = {};
  await runApplication({
    loadConfig: () => ({ ...config, apiEnabled: false, autoMigrate: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: (url) => { calls.push(`pool:${url === config.databaseUrl}`); return pool; },
    migrateDatabase: async (receivedPool) => { assert.equal(receivedPool, pool); calls.push('migrate'); return ['migration']; },
    createProjectionRepository: () => { throw new Error('must not construct repository'); },
    createEventStreamRepository: () => { throw new Error('must not construct repository'); },
    createApiServer: () => { throw new Error('must not create server'); },
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => { throw new Error('must not wait'); },
    logInfo: () => { calls.push('log'); },
  });
  assert.deepEqual(calls, ['log', 'pool:true', 'migrate', 'log', 'database.close']);
});

void test('un échec de migration désactivée ferme la base et reste visible', async () => {
  const migrationFailure = new Error('migration failure');
  const calls: string[] = [];
  await assert.rejects(runApplication({
    loadConfig: () => ({ ...config, apiEnabled: false, autoMigrate: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: () => { calls.push('pool'); return {}; },
    migrateDatabase: async () => { calls.push('migrate'); throw migrationFailure; },
    createProjectionRepository: () => { throw new Error('must not construct repository'); },
    createEventStreamRepository: () => { throw new Error('must not construct repository'); },
    createApiServer: () => { throw new Error('must not create server'); },
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => { throw new Error('must not wait'); },
    logInfo: () => { calls.push('log'); },
  }), (error: unknown) => error === migrationFailure);
  assert.deepEqual(calls, ['log', 'pool', 'migrate', 'database.close']);
});

void test('l’état de production expose HTTP sans prétendre que les listeners tournent', () => {
  assert.deepEqual(PRODUCTION_API_PIPELINE_STATE, {
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'IDLE',
  });
});

void test('la santé de production publie HTTP disponible et les pipelines réellement inactifs', async () => {
  const database: Queryable = {
    async query(text) {
      return { rows: text.includes('SELECT 1 AS available') ? [{ available: 1 }] : [] };
    },
  };
  const health = await new PostgresApiProjectionRepository(
    database,
    () => new Date('2026-07-29T00:00:00.000Z'),
    PRODUCTION_API_PIPELINE_STATE,
  ).getHealth();
  assert.deepEqual(health.http, { status: 'AVAILABLE' });
  assert.deepEqual(health.pipeline, { pumpfun: 'STOPPED', pumpswap: 'IDLE' });
  assert.equal(health.status, 'DEGRADED');
});

void test('le bootstrap nettoie le serveur puis la base après un échec de démarrage', async () => {
  const calls: string[] = [];
  const server = { async listen() { calls.push('server.listen'); throw new Error('bind failure'); }, async close() { calls.push('server.close'); } };
  await assert.rejects(runApplication({
    loadConfig: () => ({ ...config, apiEnabled: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: () => { calls.push('pool'); return {}; },
    migrateDatabase: async () => [],
    createProjectionRepository: () => ({}) as ApiProjectionRepository,
    createEventStreamRepository: () => ({}) as ApiEventStreamRepository,
    createApiServer: () => server,
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => 'SIGTERM',
    logInfo: () => { calls.push('log'); },
  }));
  assert.deepEqual(calls, ['log', 'pool', 'server.listen', 'server.close', 'database.close']);
});

void test('le bootstrap ferme la base même si la fermeture du serveur échoue', async () => {
  const calls: string[] = [];
  const server = {
    async listen() { calls.push('server.listen'); return { host: '127.0.0.1', port: 32123 }; },
    async close() { calls.push('server.close'); throw new Error('server close failure'); },
  };
  await assert.rejects(runApplication({
    loadConfig: () => ({ ...config, apiEnabled: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: () => { calls.push('pool'); return {}; },
    migrateDatabase: async () => [],
    createProjectionRepository: () => ({}) as ApiProjectionRepository,
    createEventStreamRepository: () => ({}) as ApiEventStreamRepository,
    createApiServer: () => server,
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => 'SIGTERM',
    logInfo: () => { calls.push('log'); },
  }), /server close failure/u);
  assert.deepEqual(calls, ['log', 'pool', 'server.listen', 'log', 'server.close', 'database.close']);
});

void test('le bootstrap conserve les erreurs primaire et de nettoyage dans leur ordre', async () => {
  const serverFailure = new Error('server shutdown failure');
  const databaseFailure = new Error('database cleanup failure');
  const server = {
    async listen() { return { host: '127.0.0.1', port: 32123 }; },
    async close() { throw serverFailure; },
  };
  await assert.rejects(runApplication({
    loadConfig: () => ({ ...config, apiEnabled: true }),
    createQualificationEngine: () => ({ minimumTotalScore: 60 }),
    getDatabasePool: () => ({}),
    migrateDatabase: async () => [],
    createProjectionRepository: () => ({}) as ApiProjectionRepository,
    createEventStreamRepository: () => ({}) as ApiEventStreamRepository,
    createApiServer: () => server,
    closeDatabase: async () => { throw databaseFailure; },
    waitForShutdownSignal: async () => 'SIGTERM',
    logInfo: () => undefined,
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [serverFailure, databaseFailure]);
    return true;
  });
});

void test('le handler terminal redacted fixe le code d’échec sans quitter le processus', () => {
  const runtime: { exitCode: number | string | undefined } = { exitCode: undefined };
  const logs: object[] = [];
  reportEntrypointFailure(new Error('credential-like-detail'), runtime, (context) => { logs.push(context); });
  assert.equal(runtime.exitCode, 1);
  assert.deepEqual(logs, [{ event: 'listener.start_failed', errorName: 'Error' }]);
});

void test('le waiter de signal retire les deux écouteurs après le premier signal', async () => {
  const signals = new EventEmitter();
  const waiting = waitForShutdownSignal(signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGINT');
  assert.equal(await waiting, 'SIGINT');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

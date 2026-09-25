import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const nodeImage =
  'node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
const nginxImage =
  'nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49';
const postgresImage =
  'postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3';

async function readArtifact(path: string): Promise<string> {
  return (await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n');
}

function stage(source: string, name: string): string {
  const stages = [...source.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)];
  const index = stages.findIndex((match) => match[1]?.toLowerCase() === name.toLowerCase());
  assert.notEqual(index, -1, `missing Docker stage ${name}`);

  const current = stages[index];
  assert.ok(current?.index !== undefined);
  const next = stages[index + 1];
  return source.slice(current.index, next?.index ?? source.length);
}

function composeService(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing Compose service ${name}`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/^ {2}[a-z][a-z-]*:\s*$/m);
  return source.slice(start, next === -1 ? source.length : start + marker.length + next);
}

void test('Dockerfile pins reviewed images and builds exact workspace artifacts', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const fromLines = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim)].map(
    ([, image, name]) => [image, name],
  );

  assert.deepEqual(fromLines, [
    [nodeImage, 'dependencies'],
    ['dependencies', 'build'],
    [nodeImage, 'production-dependencies'],
    [nodeImage, 'backend'],
    [nginxImage, 'frontend'],
  ]);
  assert.doesNotMatch(dockerfile, /^COPY\s+(?:--\S+\s+)*\.(?:\s|$)/gim);

  const dependencies = stage(dockerfile, 'dependencies');
  assert.match(dependencies, /^COPY\s+package\.json\s+package-lock\.json\s+\.\/$/m);
  assert.match(dependencies, /^COPY\s+frontend\/package\.json\s+frontend\/package\.json$/m);
  assert.match(dependencies, /^RUN\s+npm ci --include-workspace-root --workspaces$/m);

  const build = stage(dockerfile, 'build');
  assert.ok(
    build.includes("RUN find frontend/src -type f \\( -name '*.test.ts' -o -name '*.test.tsx' \\) -delete\n"),
  );
  assert.match(build, /^RUN\s+npm run build$/m);
  assert.match(build, /^RUN\s+rm -rf dist\/tests$/m);
  assert.match(build, /^COPY\s+src\s+\.\/src$/m);
  assert.match(build, /^COPY\s+scripts\s+\.\/scripts$/m);
  assert.match(build, /^COPY\s+migrations\s+\.\/migrations$/m);
  assert.match(build, /^COPY\s+config\s+\.\/config$/m);
  assert.match(
    build,
    /^COPY\s+frontend\/vite-read-only-api-proxy\.ts\s+frontend\/vite-read-only-api-proxy\.ts$/m,
  );

  const productionDependencies = stage(dockerfile, 'production-dependencies');
  assert.match(
    productionDependencies,
    /^RUN\s+npm ci --omit=dev --ignore-scripts --workspaces=false\s+&&\s+npm cache clean --force$/m,
  );
});

void test('backend image contains only compiled application artifacts and production dependencies', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const backend = stage(dockerfile, 'backend');
  const copies = backend.match(/^COPY\s+.+$/gm) ?? [];

  assert.deepEqual(copies, [
    'COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules',
    'COPY --from=build --chown=node:node /app/dist ./dist',
    'COPY --chown=node:node package.json package-lock.json ./',
  ]);
  assert.doesNotMatch(backend, /tests?|fixtures?|\.env|\.git|\.worktrees|npm-cache/i);
  assert.match(backend, /^ENV\s+NODE_ENV=production$/m);
  assert.match(backend, /^USER\s+node$/m);
  assert.match(backend, /^EXPOSE\s+3000$/m);
  assert.match(backend, /^CMD\s+\["node",\s*"dist\/src\/app\.js"\]$/m);
});

void test('frontend image contains only built static assets and the reviewed unprivileged config', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const frontend = stage(dockerfile, 'frontend');
  const copies = frontend.match(/^COPY\s+.+$/gm) ?? [];
  const users = [...frontend.matchAll(/^USER\s+(\S+)$/gm)].map((match) => match[1]);

  assert.deepEqual(copies, [
    'COPY --from=build /app/frontend/dist /usr/share/nginx/html',
    'COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf',
  ]);
  assert.match(
    frontend,
    /^RUN\s+find \/usr\/share\/nginx\/html -mindepth 1 -maxdepth 1 -delete$/m,
  );
  assert.deepEqual(users, ['root', 'nginx']);
  assert.match(frontend, /^EXPOSE\s+8080$/m);
  assert.doesNotMatch(frontend, /(?:^|\/)src(?:\/|\s)|tests?|fixtures?|\.env|\.git|\.worktrees/i);
});

void test('.dockerignore removes secrets, repositories, generated output, fixtures, and caches', async () => {
  const rules = (await readArtifact('.dockerignore'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const required of [
    '.env*',
    '.git',
    '.gitignore',
    '.worktrees',
    '**/node_modules',
    '**/dist',
    '**/coverage',
    '**/*.log',
    '**/logs',
    '**/fixtures',
    '**/reports',
    'tests',
    'frontend/tests',
    '**/.cache',
    '**/.npm',
  ]) {
    assert.ok(rules.includes(required), `missing .dockerignore rule: ${required}`);
  }
  assert.equal(rules.some((rule) => rule.startsWith('!.env')), false);
});

void test('Nginx serves the SPA with bounded caching and proxies only the read-only V1 API', async () => {
  const nginx = await readArtifact('deploy/nginx.conf');

  assert.match(nginx, /listen\s+8080;/);
  assert.match(nginx, /autoindex\s+off;/);
  assert.match(nginx, /resolver\s+127\.0\.0\.11\s+ipv6=off\s+valid=1s;/);
  assert.match(nginx, /resolver_timeout\s+5s;/);
  assert.match(nginx, /set\s+\$app_upstream\s+app:3000;/);
  assert.match(
    nginx,
    /location\s+=\s+\/config\.json\s*\{[^}]*Cache-Control\s+"no-store"[^}]*try_files\s+\$uri\s+=404;/s,
  );
  assert.match(
    nginx,
    /location\s+=\s+\/index\.html\s*\{[^}]*Cache-Control\s+"no-store"[^}]*try_files\s+\$uri\s+=404;/s,
  );
  assert.match(
    nginx,
    /location\s+\^~\s+\/assets\/\s*\{[^}]*Cache-Control\s+"public, max-age=31536000, immutable"[^}]*try_files\s+\$uri\s+=404;/s,
  );
  assert.match(nginx, /location\s+\/\s*\{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/s);

  assert.match(nginx, /location\s+=\s+\/api\/v1\/events\s*\{/);
  assert.match(nginx, /location\s+\^~\s+\/api\/v1\/\s*\{/);
  assert.match(nginx, /location\s+=\s+\/api\/v1\s*\{/);
  assert.equal((nginx.match(/proxy_pass\s+http:\/\/\$app_upstream\$request_uri;/g) ?? []).length, 3);
  assert.doesNotMatch(nginx, /proxy_pass\s+http:\/\/app:3000/);
  assert.equal((nginx.match(/proxy_set_header\s+Host\s+\$host;/g) ?? []).length, 3);
  assert.equal((nginx.match(/limit_except\s+GET\s+OPTIONS/g) ?? []).length, 3);
  assert.match(
    nginx,
    /location\s+=\s+\/api\/v1\/events\s*\{[\s\S]*?proxy_buffering\s+off;[\s\S]*?proxy_cache\s+off;[\s\S]*?proxy_read_timeout\s+1h;/,
  );

  assert.doesNotMatch(nginx, /Access-Control-Allow-Credentials/i);
  assert.doesNotMatch(nginx, /websocket|proxy_set_header\s+Upgrade|\/live(?:\W|$)/i);
});

void test('Compose defines an observe-only, five-service deployment without exposed database or backend', async () => {
  const compose = await readArtifact('deploy/compose.yaml');
  const smokeOverride = await readArtifact('deploy/compose.smoke.yaml');

  assert.match(compose, /^name: sol-token-listener$/m);
  assert.match(compose, /^services:\s*$/m);
  const networksOffset = compose.indexOf('\nnetworks:');
  assert.notEqual(networksOffset, -1, 'missing networks section');
  const services = compose.slice(0, networksOffset);
  const serviceNames = [...services.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  assert.deepEqual(serviceNames, ['postgres', 'migrate', 'app', 'retention', 'frontend']);
  assert.match(compose, new RegExp(`^    image: ${postgresImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(composeService(compose, 'app'), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'migrate'), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'retention'), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'frontend'), /^ {4}image: \$\{FRONTEND_IMAGE:\?FRONTEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'app'), /^ {4}build:\s*$/m);
  assert.match(composeService(compose, 'frontend'), /^ {4}build:\s*$/m);
  assert.doesNotMatch(composeService(compose, 'migrate'), /^ {4}build:\s*$/m);
  assert.doesNotMatch(composeService(compose, 'retention'), /^ {4}build:\s*$/m);
  assert.match(compose, /^ {4}ports:\s*\["127\.0\.0\.1:\$\{FRONTEND_PORT:-8080\}:8080"\]\s*$/m);
  assert.equal((compose.match(/^ {4}ports:/gm) ?? []).length, 1);
  assert.match(compose, /^x-database-environment: &database-environment$/m);
  assert.match(compose, /^ {2}DATABASE_URL: postgresql:/m);
  assert.match(compose, /^ {2}POSTGRES_AUTO_MIGRATE: "false"$/m);

  const migrate = composeService(compose, 'migrate');
  assert.match(migrate, /^ {4}environment: \*database-environment$/m);
  assert.doesNotMatch(migrate, /SOLANA_|EXECUTION_MODE|PAPER_STRATEGY|API_|DATA_RETENTION|RETENTION_PURGE/);

  const retention = composeService(compose, 'retention');
  assert.match(retention, /^ {4}environment:\s*\n {6}<<: \*database-environment$/m);
  assert.match(retention, /^ {6}DATA_RETENTION_HOURS: "4"$/m);
  assert.match(retention, /^ {6}RETENTION_PURGE_INTERVAL_MS: \$\{RETENTION_PURGE_INTERVAL_MS:-900000\}$/m);
  assert.doesNotMatch(retention, /SOLANA_|EXECUTION_MODE|PAPER_STRATEGY|API_/);

  const app = composeService(compose, 'app');
  assert.match(app, /^ {4}environment:\s*\n {6}<<: \*database-environment$/m);
  assert.match(
    app,
    /^ {6}SOLANA_HTTP_RPC_URL: \$\{SOLANA_HTTP_RPC_URL:\?SOLANA_HTTP_RPC_URL is required\}\n {6}SOLANA_HTTP_RPC_FALLBACK_URLS: \$\{SOLANA_HTTP_RPC_FALLBACK_URLS:-\}$/m,
  );
  assert.match(
    app,
    /^ {6}SOLANA_WS_RPC_URL: \$\{SOLANA_WS_RPC_URL:\?SOLANA_WS_RPC_URL is required\}\n {6}SOLANA_WS_RPC_FALLBACK_URLS: \$\{SOLANA_WS_RPC_FALLBACK_URLS:-\}$/m,
  );
  assert.match(
    app,
    /^ {6}SOLANA_EXPECTED_GENESIS_HASH: \$\{SOLANA_EXPECTED_GENESIS_HASH:-\}$/m,
  );
  assert.match(app, /^ {6}EXECUTION_MODE: observe$/m);
  assert.match(app, /^ {6}PAPER_STRATEGY_ENABLED: "false"$/m);
  assert.match(app, /^ {6}API_ENABLED: "true"$/m);
  assert.match(app, /^ {6}DATA_RETENTION_HOURS: "4"$/m);
  assert.match(app, /^ {6}API_HOST: 0\.0\.0\.0$/m);
  assert.match(app, /^ {6}API_PORT: "3000"$/m);
  assert.match(app, /^ {6}LISTENER_ENABLED: \$\{LISTENER_ENABLED:-true\}$/m);
  assert.match(compose, /^ {4}init: true$/m);
  assert.match(compose, /^ {4}stop_grace_period: 40s$/m);
  assert.match(
    composeService(compose, 'app'),
    /^ {6}test: \["CMD", "node", "dist\/scripts\/deployment-healthcheck\.js", "--require-ok"\]$/m,
  );
  assert.doesNotMatch(composeService(compose, 'app'), /deployment-healthcheck\.js"\s*\]/);
  assert.equal(smokeOverride, [
    'services:',
    '  app:',
    '    environment:',
    '      LISTENER_ENABLED: "false"',
    '    healthcheck:',
    '      test: ["CMD", "node", "dist/scripts/deployment-healthcheck.js"]',
    '',
  ].join('\n'));
  assert.match(compose, /^ {4}command: \["node", "dist\/scripts\/migrate\.js"\]$/m);
  assert.match(compose, /^ {4}command: \["node", "dist\/scripts\/purge-retained-data\.js"\]$/m);
  assert.equal((compose.match(/depends_on:\s*\n {6}migrate:\s*\n {8}condition: service_completed_successfully/g) ?? []).length, 2);
  assert.match(compose, /depends_on:\s*\n {6}postgres:\s*\n {8}condition: service_healthy/);
  assert.match(compose, /depends_on:\s*\n {6}app:\s*\n {8}condition: service_healthy/);
  assert.match(composeService(compose, 'postgres'), /^ {4}networks: \[internal\]$/m);
  assert.match(composeService(compose, 'migrate'), /^ {4}networks: \[internal\]$/m);
  assert.match(composeService(compose, 'app'), /^ {4}networks: \[internal, application\]$/m);
  assert.match(composeService(compose, 'retention'), /^ {4}networks: \[internal\]$/m);
  assert.match(composeService(compose, 'frontend'), /^ {4}networks: \[application\]$/m);
  assert.match(compose, /^ {4}volumes: \["postgres-data:\/var\/lib\/postgresql\/data"\]$/m);
  assert.match(compose, /^networks:\s*\n {2}internal:\s*\n {4}internal: true\s*\n {2}application:$/m);
  assert.match(compose, /^volumes:\s*\n {2}postgres-data:$/m);
  assert.doesNotMatch(compose, /privileged:|network_mode: host|docker\.sock|PRIVATE_KEY|SECRET_KEY|WALLET/i);
  assert.doesNotMatch(compose, /EXECUTION_MODE:\s*\$\{|POSTGRES_AUTO_MIGRATE:\s*\$\{/);
  for (const imageLine of compose.match(/^ {4}image: .+$/gm) ?? []) {
    assert.match(imageLine, /(?:@sha256:[0-9a-f]{64}|\$\{(?:BACKEND|FRONTEND)_IMAGE:\?)/u);
  }
});

void test('Compose forwards catch-up policy, block hydration and ingestion scope with safe defaults', async () => {
  const [compose, environment, localEnvironment] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/env.example'),
    readArtifact('.env.example'),
  ]);
  const app = composeService(compose, 'app');
  const settings = Object.freeze([
    ['LISTENER_WORKER_COUNT', '1'],
    ['LISTENER_CATCH_UP_POLICY', 'live-edge'],
    ['LISTENER_CATCH_UP_MAX_PAGES', '20'],
    ['LISTENER_CATCH_UP_PAGE_SIZE', '100'],
    ['LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED', 'false'],
    ['LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED', 'false'],
    ['LISTENER_BLOCK_HYDRATION_ENABLED', 'false'],
    ['LISTENER_BLOCK_HYDRATION_MAX_ENTRIES', '64'],
    ['LISTENER_BLOCK_HYDRATION_MAX_BYTES', '67108864'],
    ['LISTENER_BLOCK_HYDRATION_MAX_ENTRY_BYTES', '8388608'],
    ['LISTENER_BLOCK_HYDRATION_CONFIRMED_TTL_MS', '10000'],
    ['LISTENER_BLOCK_HYDRATION_FINALIZED_TTL_MS', '60000'],
    ['LISTENER_BLOCK_HYDRATION_FETCH_INTERVAL_MS', '250'],
  ] as const);

  for (const [name, fallback] of settings) {
    assert.match(
      app,
      new RegExp(`^ {6}${name}: "\\$\\{${name}:-${fallback}\\}"$`, 'mu'),
    );
    assert.match(environment, new RegExp(`^${name}=${fallback}$`, 'mu'));
    assert.equal((compose.match(new RegExp(`^ {6}${name}:`, 'gmu')) ?? []).length, 1);
  }
  assert.match(
    app,
    /^ {6}LISTENER_INGESTION_SCOPE: "\$\{LISTENER_INGESTION_SCOPE:-launchpad-and-market\}"$/mu,
  );
  assert.match(environment, /^LISTENER_INGESTION_SCOPE=launchpad-and-market$/mu);
  assert.match(environment, /^LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false$/mu);
  assert.match(environment, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.match(localEnvironment, /^LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false$/mu);
  assert.match(localEnvironment, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.equal((compose.match(/^ {6}LISTENER_INGESTION_SCOPE:/gmu) ?? []).length, 1);
  assert.doesNotMatch(environment, /PRIVATE_KEY|SECRET_KEY|WALLET/iu);
});

void test('Compose resolves catch-up scan limit defaults and overrides only for app', (context) => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 });
  if (docker.error !== undefined || docker.status !== 0) {
    context.skip('Docker Compose unavailable: resolved configuration contract skipped');
    return;
  }
  for (const configured of [
    Object.freeze({ workerCount: undefined, maxPages: undefined, pageSize: undefined, expectedWorkerCount: '1', expectedMaxPages: '20', expectedPageSize: '100' }),
    Object.freeze({ workerCount: '2', maxPages: '37', pageSize: '777', expectedWorkerCount: '2', expectedMaxPages: '37', expectedPageSize: '777' }),
  ]) {
    const result = spawnSync('docker', [
      'compose', '--env-file', '/dev/null', '-f', 'deploy/compose.yaml', 'config', '--format', 'json',
    ], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        POSTGRES_DB: 'compose_contract', POSTGRES_USER: 'compose_contract',
        POSTGRES_PASSWORD: 'contract-only', POSTGRES_PASSWORD_URI_ENCODED: 'contract-only',
        BACKEND_IMAGE: 'registry.invalid/backend:test', FRONTEND_IMAGE: 'registry.invalid/frontend:test',
        SOLANA_HTTP_RPC_URL: 'https://rpc.invalid', SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
        ...(configured.workerCount === undefined ? {} : { LISTENER_WORKER_COUNT: configured.workerCount }),
        ...(configured.maxPages === undefined ? {} : { LISTENER_CATCH_UP_MAX_PAGES: configured.maxPages }),
        ...(configured.pageSize === undefined ? {} : { LISTENER_CATCH_UP_PAGE_SIZE: configured.pageSize }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout) as {
      readonly services: Readonly<Record<string, { readonly environment?: Readonly<Record<string, string>> }>>;
    };
    assert.equal(resolved.services.app?.environment?.LISTENER_WORKER_COUNT, configured.expectedWorkerCount);
    assert.equal(resolved.services.app?.environment?.LISTENER_CATCH_UP_MAX_PAGES, configured.expectedMaxPages);
    assert.equal(resolved.services.app?.environment?.LISTENER_CATCH_UP_PAGE_SIZE, configured.expectedPageSize);
    for (const service of ['postgres', 'migrate', 'retention', 'frontend']) {
      assert.equal(resolved.services[service]?.environment?.LISTENER_WORKER_COUNT, undefined);
      assert.equal(resolved.services[service]?.environment?.LISTENER_CATCH_UP_MAX_PAGES, undefined);
      assert.equal(resolved.services[service]?.environment?.LISTENER_CATCH_UP_PAGE_SIZE, undefined);
    }
  }
});

void test('Compose catch-up admission resolves default-off and explicit activation without other service exposure', (context) => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 });
  if (docker.error !== undefined || docker.status !== 0) {
    context.skip('Docker Compose unavailable: resolved configuration contract skipped');
    return;
  }
  const name = 'LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED';
  for (const configured of [undefined, 'false', 'true']) {
    const result = spawnSync('docker', [
      'compose', '--env-file', '/dev/null', '-f', 'deploy/compose.yaml', 'config', '--format', 'json',
    ], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        POSTGRES_DB: 'compose_contract', POSTGRES_USER: 'compose_contract',
        POSTGRES_PASSWORD: 'contract-only', POSTGRES_PASSWORD_URI_ENCODED: 'contract-only',
        BACKEND_IMAGE: 'registry.invalid/backend:test', FRONTEND_IMAGE: 'registry.invalid/frontend:test',
        SOLANA_HTTP_RPC_URL: 'https://rpc.invalid', SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
        ...(configured === undefined ? {} : { [name]: configured }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout) as {
      readonly services: Readonly<Record<string, { readonly environment?: Readonly<Record<string, string>> }>>;
    };
    assert.equal(resolved.services.app?.environment?.[name], configured ?? 'false');
    assert.equal(resolved.services.app?.environment?.EXECUTION_MODE, 'observe');
    for (const service of ['postgres', 'migrate', 'retention', 'frontend']) {
      assert.equal(resolved.services[service]?.environment?.[name], undefined);
    }
  }
});

void test('block hydration canary proves active routing and bounded serialized admission', async () => {
  const runbook = await readArtifact('docs/operations/block-hydration-canary.md');
  assert.match(runbook, /T0, T\+5 min et T\+15 min/iu);
  assert.match(runbook, /heartbeat\.blockHydration\.enabled=true/iu);
  assert.match(runbook, /LISTENER_INGESTION_SCOPE=launchpad-only/iu);
  assert.match(runbook, /pipeline\.pumpswap=IDLE/iu);
  assert.match(runbook, /à chaque relevé/iu);
  assert.match(runbook, /queuedFetches <= 1/u);
  assert.match(runbook, /inFlightFetches <= 1/u);
  assert.match(runbook, /delta `fetches` strictement positif/iu);
  assert.match(runbook, /trafic insuffisant[\s\S]*INCONCLUSIVE/iu);
  assert.match(runbook, /Toute autre valeur entraîne\s+`FAIL`/iu);
});

void test('RPC HTTP canary evidence has a complete redacted snapshot verdict contract', async (context) => {
  const runbook = await readArtifact('docs/operations/block-hydration-canary.md');

  for (const sample of ['T0', 'T+5', 'T+15', 'final']) {
    assert.match(runbook, new RegExp(sample.replace('+', '\\+'), 'u'));
  }
  assert.match(runbook, /delta [`']?attempts[`']?[^.]{0,120}strictement positif/iu);
  assert.match(runbook, /delta [`']?HTTP\s*429[`']?[^.]{0,120}(?:exactement|égal à) zéro/iu);
  assert.match(runbook, /(?:même|identique)[^.]{0,100}startedAt/iu);
  assert.match(runbook, /membership[^.]{0,100}(?:stable|identique)/iu);
  assert.match(runbook, /configured[^.]{0,100}(?:stable|identique)/iu);
  assert.match(runbook, /overflow(?:ed)?[^.]{0,100}(?:false|rejet|inconclusive)/iu);

  for (const outcome of [
    'restart', 'final[^.]{0,40}(?:manquant|absent)', 'trafic[^.]{0,40}zéro',
    'métrique[^.]{0,40}(?:absente|malformée)', 'overflow',
  ]) assert.match(runbook, new RegExp(`${outcome}[\\s\\S]{0,180}INCONCLUSIVE`, 'iu'));
  assert.match(runbook, /delta[^.]{0,120}HTTP\s*429[^.]{0,120}(?:>\s*0|positif)[\s\S]{0,100}FAIL/iu);
  assert.match(runbook, /changement de membership[^.]{0,120}INCONCLUSIVE/iu);
  assert.match(runbook, /429[^.]{0,160}(?:observé|prouvé)[^.]{0,160}FAIL/iu);

  assert.match(runbook, /jq[^\n]*startedAt[^\n]*rpcHttpEvidence/iu);
  assert.match(runbook, /(?:providerId|configured|attempts|http429Responses)/iu);
  assert.match(runbook, /artefact séparé[^.]{0,120}preuve HTTP RPC/iu);
  assert.match(runbook, /autres gates[^.]{0,180}(?:snapshots|artefacts)/iu);
  assert.doesNotMatch(runbook, /uniquement la projection[^.]{0,120}autres champs sont exclus/iu);
  assert.doesNotMatch(runbook, /jq[^\n]*(?:\burl\b|\bkey\b|\bsignature\b|\bmint\b|\bbody\b)/iu);

  const jqVersion = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (jqVersion.error !== undefined || jqVersion.status !== 0) {
    context.skip('jq unavailable: executable filter cases skipped');
    return;
  }
  const filterMatch = /\n\s*jQ?\s+'([^']+)'\s+health\.json/iu.exec(runbook);
  assert.ok(filterMatch?.[1], 'missing executable jq evidence filter');
  const filter = filterMatch[1];
  const runJq = (input: unknown) => spawnSync('jq', ['-c', filter], {
    encoding: 'utf8', input: JSON.stringify(input),
  });
  const startedAt = '2026-09-20T10:00:00.000Z';
  const valid = {
    apiVersion: 'v1',
    meta: { generatedAt: startedAt, nextCursor: null },
    data: {
      heartbeat: {
        startedAt,
        rpcHttpEvidence: {
          version: 1,
          overflowed: false,
          providers: [
            { providerId: 'primary', configured: true, attempts: 3, http429Responses: 0 },
            { providerId: 'fallback-1', configured: false, attempts: 0, http429Responses: 0 },
            { providerId: 'fallback-2', configured: false, attempts: 0, http429Responses: 0 },
            { providerId: 'fallback-3', configured: false, attempts: 0, http429Responses: 0 },
          ],
        },
      },
      SECRET: 'must-not-leak',
    },
  };
  const expectedEvidence = {
    version: 1,
    overflowed: false,
    providers: valid.data.heartbeat.rpcHttpEvidence.providers,
  };
  for (const [input, expected] of [
    [valid, { startedAt, rpcHttpEvidence: expectedEvidence }],
    [{ apiVersion: 'v1', meta: { generatedAt: startedAt, nextCursor: null }, data: {} }, { startedAt: null, rpcHttpEvidence: null }],
    [{ apiVersion: 'v1', meta: { generatedAt: startedAt, nextCursor: null }, data: { heartbeat: { startedAt, rpcHttpEvidence: null } } }, { startedAt, rpcHttpEvidence: null }],
    [{ apiVersion: 'v1', meta: { generatedAt: startedAt, nextCursor: null }, data: { heartbeat: { startedAt, rpcHttpEvidence: { version: 1, malformed: true } } } }, { startedAt, rpcHttpEvidence: null }],
    [{ apiVersion: 'v1', meta: { generatedAt: startedAt, nextCursor: null }, data: { heartbeat: { startedAt, rpcHttpEvidence: { version: 1, overflowed: false, providers: [
      { providerId: 'primary', configured: false, attempts: 1, http429Responses: 0 },
      ...valid.data.heartbeat.rpcHttpEvidence.providers.slice(1),
    ] } } } }, { startedAt, rpcHttpEvidence: null }],
  ] as const) {
    const result = runJq(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.doesNotMatch(result.stdout, /SECRET|\burl\b|\bkey\b|\bsignature\b|\bmint\b|\bbody\b/iu);
  }

});

void test('RPC HTTP canary scope separates #142 from the #143 latency gate', async () => {
  const design = await readArtifact('docs/superpowers/specs/2026-09-19-rpc-http-canary-evidence-design.md');
  assert.match(design, /#142[^.]{0,180}(?:only|uniquement|seulement)[^.]{0,180}HTTP.?429/iu);
  assert.match(design, /#143[^.]{0,180}(?:still|required|nécessaire)[^.]{0,180}(?:latency|latence|p95)/iu);
});

void test('RPC HTTP canary archives the persisted STOPPED heartbeat after the app API closes', async (context) => {
  const runbook = await readArtifact('docs/operations/block-hydration-canary.md');
  const composePrefix = 'docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener';
  const stopAt = runbook.indexOf(`${composePrefix} stop --timeout 40 app`);
  const persistedReadAt = runbook.indexOf("runtime_state = 'STOPPED'");

  assert.ok(stopAt >= 0, 'the runbook must stop only the app with its bounded grace period');
  assert.ok(persistedReadAt > stopAt, 'the final snapshot must read PostgreSQL after app shutdown');
  assert.match(runbook, /set -euo pipefail[\s\S]{0,120}DEPLOY_ENV:\?/u);
  assert.match(runbook, /service_key = 'transaction-listener'/u);
  assert.match(runbook, /payload\s*->\s*'rpcHttpEvidence'/u);
  assert.match(runbook, /started_at/u);
  assert.ok(runbook.includes(`${composePrefix} exec -T postgres`));
  assert.match(runbook, /jq -e[^\n]*select\([^\n]*startedAt[^\n]*rpcHttpEvidence/iu);
  assert.doesNotMatch(runbook, /docker compose (?:down|stop|exec)/u);

  if (spawnSync('jq', ['--version']).status !== 0) {
    context.diagnostic('jq unavailable: executable final-snapshot cases skipped');
    return;
  }
  const finalBlock = [...runbook.matchAll(/^[ \t]*```bash\n([\s\S]*?)\n[ \t]*```$/gmu)]
    .map((match) => (match[1] ?? '').split('\n').map((line) => line.replace(/^ {3}/u, '')).join('\n'))
    .find((block) => block.includes('final_source="$(mktemp)"'));
  assert.ok(finalBlock, 'missing executable final-snapshot block');

  const directory = await mkdtemp(join(tmpdir(), 'sol-token-listener-final-heartbeat-'));
  try {
    await writeFile(join(directory, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" stop "*) test "\${FAKE_DOCKER_MODE:-success}" != stop-fail ;;
  *" exec "*)
    cat >/dev/null
    test "\${FAKE_DOCKER_MODE:-success}" != exec-fail
    printf '%s' "\${FAKE_DOCKER_OUTPUT:-}"
    ;;
  *) exit 64 ;;
esac
`, { encoding: 'utf8', mode: 0o700 });
    await writeFile(join(directory, 'sleep'), `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
test "$1" = 45
`, { encoding: 'utf8', mode: 0o700 });
    const provider = (providerId: string, configured = false) => ({
      providerId, configured, attempts: configured ? 3 : 0, http429Responses: 0,
    });
    const firstProcessingCanary = {
      version: 1, thresholdMs: 45_000, cohortCapacity: 50_000,
      cohortStartedAtMs: 1_795_000_000_000, cohortEndsAtMs: 1_795_000_900_000,
      sampledAtMs: 1_795_000_945_001, overflowed: false, eligibleCount: 1,
      completedCount: 1, underThresholdCount: 1, atOrAboveThresholdCount: 0,
      pendingCount: 0, rightCensoredCount: 0, tailCensoredCount: 0,
      terminalCount: 0, unavailableCount: 0, invalidDurationCount: 0,
      p95Ms: 44_999, verdict: 'PASS',
    };
    const validSource = `${JSON.stringify({ data: { heartbeat: {
      startedAt: '2026-09-20T10:00:00.000Z',
      rpcHttpEvidence: {
        version: 1, overflowed: false, providers: [
          provider('primary', true), provider('fallback-1'),
          provider('fallback-2'), provider('fallback-3'),
        ],
      },
      firstProcessingCanary,
    } } })}\n`;
    await writeFile(join(directory, 'T+15.firstProcessingCanary'), JSON.stringify({
      startedAt: '2026-09-20T10:00:00.000Z',
      firstProcessingCanary: {
        ...firstProcessingCanary,
        sampledAtMs: firstProcessingCanary.cohortEndsAtMs,
        verdict: 'INCONCLUSIVE',
      },
    }), 'utf8');
    const run = (mode: string, output: string) => spawnSync('bash', ['-c', finalBlock], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        DEPLOY_ENV: '/external/operator.env',
        FAKE_DOCKER_MODE: mode,
        FAKE_DOCKER_OUTPUT: output,
      },
    });

    const success = run('success', validSource);
    assert.equal(success.status, 0, success.stderr);
    const projected = JSON.parse(await readFile(join(directory, 'final'), 'utf8')) as {
      readonly startedAt?: unknown;
      readonly rpcHttpEvidence?: unknown;
    };
    assert.equal(projected.startedAt, '2026-09-20T10:00:00.000Z');
    assert.ok(projected.rpcHttpEvidence !== null);

    for (const [mode, output] of [
      ['stop-fail', validSource],
      ['exec-fail', validSource],
      ['success', ''],
      ['success', `${validSource}${validSource}`],
      ['success', 'not-json\n'],
    ] as const) {
      const result = run(mode, output);
      assert.notEqual(result.status, 0, `${mode}:${JSON.stringify(output)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('first-processing canary runbook fails closed across the fixed cohort and final heartbeat', async (context) => {
  const [runbook, architecture, overview] = await Promise.all([
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('docs/architecture/pumpfun-v1.md'),
    readArtifact('docs/system-overview.html'),
  ]);
  const all = `${runbook}\n${architecture}\n${overview}`;
  const stopCommand = 'docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 app';
  const sleepAt = runbook.indexOf('sleep 45');
  const stopAt = runbook.indexOf(stopCommand);

  for (const sample of ['T0', 'T+5', 'T+15', 'final']) {
    assert.match(runbook, new RegExp(`${sample.replace('+', '\\+')}[^\\n]{0,160}firstProcessingCanary`, 'iu'));
  }
  assert.match(runbook, /jq\s+'def integer:[\s\S]{0,6000}startedAt[\s\S]{0,1000}firstProcessingCanary/iu);
  for (const field of [
    'version', 'thresholdMs', 'cohortCapacity', 'cohortStartedAtMs', 'cohortEndsAtMs',
    'sampledAtMs', 'overflowed', 'eligibleCount', 'completedCount', 'underThresholdCount',
    'atOrAboveThresholdCount', 'pendingCount', 'rightCensoredCount', 'tailCensoredCount',
    'terminalCount', 'unavailableCount', 'invalidDurationCount', 'p95Ms', 'verdict',
  ]) assert.match(runbook, new RegExp(field, 'u'));
  assert.match(runbook, /(?:même|identique)[^.]{0,160}startedAt[^.]{0,160}cohortStartedAtMs/iu);
  assert.match(runbook, /cohorte[^.]{0,180}(?:se ferme|fermée)[^.]{0,80}T\+15/iu);
  assert.match(runbook, /aucune nouvelle ligne[^.]{0,180}(?:admise|incluse)[^.]{0,100}(?:drain|cohorte)/iu);
  assert.ok(sleepAt >= 0, 'the runbook must wait 45 seconds for the latency drain');
  assert.ok(stopAt > sleepAt, 'the 45-second drain must happen before bounded app shutdown');
  assert.match(runbook, /STOPPED[^.]{0,180}(?:plus récent|postérieur)[^.]{0,100}T\+15/iu);
  assert.match(runbook, /STOPPED[^.]{0,180}(?:même|identique)[^.]{0,100}cohorte/iu);
  assert.match(runbook, /runtime_state = 'STOPPED'/u);
  assert.match(runbook, /payload\s*->\s*'firstProcessingCanary'/u);

  assert.match(runbook, /44\s?999\s*ms[^.]{0,160}PASS/iu);
  assert.match(runbook, /45\s?000\s*ms[^.]{0,160}FAIL/iu);
  for (const condition of [
    'right-censored', 'tail-censored', 'cohorte vide', 'overflow', 'restart',
    'final[^.]{0,50}(?:manquant|absent)', '(?:preuve|métrique)[^.]{0,50}(?:absente|malformée)',
  ]) assert.match(runbook, new RegExp(`${condition}[\\s\\S]{0,220}INCONCLUSIVE`, 'iu'));
  assert.match(runbook, /durée invalide[^.]{0,180}FAIL/iu);
  assert.match(runbook, /FAIL[^.]{0,180}(?:prioritaire|précède)[^.]{0,120}INCONCLUSIVE/iu);
  assert.match(all, /(?:quatre|4) heures[^.]{0,220}(?:premier instant|purge)[^.]{0,220}INCONCLUSIVE/iu);
  assert.match(all, /first_detected_at[^.]{0,240}(?:quatre|4) heures[^.]{0,240}(?:purge|suppression)/iu);
  assert.match(runbook, /14400000/u);
  assert.match(runbook, /HTTP\s*429[^.]{0,180}(?:indépendant|distinct)[^.]{0,180}(?:first-processing|latence)/iu);
  assert.match(runbook, /(?:autres gates|backlog)[^.]{0,240}(?:indépendants|indépendantes|distincts|distinctes)/iu);
  assert.match(all, /observe-only[^.]{0,240}(?:aucun|aucune)[^.]{0,120}wallet[^.]{0,120}(?:sign|soumission|submit)/iu);

  const jqVersion = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (jqVersion.error !== undefined || jqVersion.status !== 0) {
    context.skip('jq unavailable: executable first-processing filter cases skipped');
    return;
  }
  const filterMatch = /\n\s*jq\s+'(def integer:[\s\S]*?)'\s+health\.json\s*>\s*first-processing/iu.exec(runbook);
  assert.ok(filterMatch?.[1], 'missing executable fixed-field first-processing jq filter');
  const filter = filterMatch[1];
  const startedAt = '2026-09-20T10:00:00.000Z';
  const evidence = {
    version: 1, thresholdMs: 45_000, cohortCapacity: 50_000,
    cohortStartedAtMs: 1_795_000_000_000, cohortEndsAtMs: 1_795_000_900_000,
    sampledAtMs: 1_795_000_945_000, overflowed: false, eligibleCount: 1,
    completedCount: 1, underThresholdCount: 1, atOrAboveThresholdCount: 0,
    pendingCount: 0, rightCensoredCount: 0, tailCensoredCount: 0,
    terminalCount: 0, unavailableCount: 0, invalidDurationCount: 0,
    p95Ms: 44_999, verdict: 'PASS',
  };
  const runJq = (firstProcessingCanary: unknown) => spawnSync('jq', ['-c', filter], {
    encoding: 'utf8',
    input: JSON.stringify({ data: { heartbeat: { startedAt, firstProcessingCanary }, secret: 'must-not-leak' } }),
  });
  const valid = runJq(evidence);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { startedAt, firstProcessingCanary: evidence });
  assert.doesNotMatch(valid.stdout, /secret|signature|mint|wallet/iu);
  const retainedTooLong = runJq({
    ...evidence,
    sampledAtMs: evidence.cohortStartedAtMs + 14_400_000,
    verdict: 'INCONCLUSIVE',
  });
  assert.equal(retainedTooLong.status, 0, retainedTooLong.stderr);
  assert.equal(JSON.parse(retainedTooLong.stdout).firstProcessingCanary.verdict, 'INCONCLUSIVE');

  for (const malformed of [
    undefined,
    { ...evidence, overflowed: true, verdict: 'PASS' },
    { ...evidence, pendingCount: 1, rightCensoredCount: 1, verdict: 'PASS' },
    { ...evidence, eligibleCount: 50_001, completedCount: 50_001, underThresholdCount: 50_001 },
    { ...evidence, overflowed: true, verdict: 'INCONCLUSIVE' },
    {
      ...evidence,
      eligibleCount: 20,
      completedCount: 20,
      underThresholdCount: 19,
      atOrAboveThresholdCount: 1,
      p95Ms: 45_000,
      verdict: 'FAIL',
    },
    { ...evidence, signature: 'must-not-leak' },
    { ...evidence, sampledAtMs: evidence.cohortStartedAtMs + 14_400_000, verdict: 'PASS' },
  ]) {
    const result = runJq(malformed);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { startedAt, firstProcessingCanary: null });
  }
});

void test('catch-up admission documentation fixes the restart-only activation and Mainnet gate', async () => {
  const [readme, architecture, api, runbook, design] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('docs/architecture/pumpfun-v1.md'),
    readArtifact('docs/api/v1.md'),
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('docs/superpowers/specs/2026-09-19-production-catch-up-admission-activation-design.md'),
  ]);
  const all = `${readme}\n${architecture}\n${api}\n${runbook}`;

  assert.match(all, /LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false/u);
  for (const setting of [
    'EXECUTION_MODE=observe',
    'LISTENER_ENABLED=true',
    'LISTENER_INGESTION_SCOPE=launchpad-only',
    'LISTENER_CATCH_UP_POLICY=live-edge',
    'LISTENER_BLOCK_HYDRATION_ENABLED=true',
    'LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true',
  ]) assert.match(all, new RegExp(setting, 'u'));
  assert.match(all, /redémarr/iu);
  assert.match(all, /rollback[^.]{0,120}LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false/iu);
  assert.match(all, /provider-affin|affinité fournisseur/iu);
  assert.match(all, /une seule cache|cache unique|global[^.]{0,120}4[^.]{0,40}fetch/iu);
  assert.match(design, /hydration permit[^.]{0,240}before[^.]{0,240}StrictCatchUpCoordinator/iu);
  assert.doesNotMatch(design, /StrictCatchUpCoordinator[^.]{0,120}remains[^.]{0,80}outside[^.]{0,80}hydration permit/iu);
  assert.match(all, /aucun[^.]{0,80}(?:wallet|clé privée|executor|exécuteur|soumission)/iu);
  assert.match(architecture, /pré-E\/S[^.]{0,240}enveloppe canonique base58/iu);
  assert.match(architecture, /getGenesisHash[^.]{0,240}catch-up[^.]{0,240}fail-closed/iu);
  for (const field of [
    'version', 'enabled', 'providerId', 'scanActive', 'workerClaimReady',
    'actionableBacklogBySource', 'actionableBacklogByPriority', 'deferredCount',
    'ignoredCount', 'quarantinedCount',
  ]) assert.match(api, new RegExp(`catchUpAdmission[\\s\\S]{0,2000}${field}`, 'u'));
  assert.match(api, /métrique brute est absente[^.]{0,240}"catchUpAdmission": null/iu);
  assert.match(api, /réponse plus[\s\S]{0,240}ancienne[^.]{0,240}omettre[^.]{0,240}champ optionnel/iu);
  assert.match(api, /providerId[^.]{0,250}null/iu);
  assert.match(api, /providerId[^.]{0,300}scan actif[^.]{0,180}provider promu/iu);
  assert.match(runbook, /Canary Mainnet post-merge[\s\S]{0,100}15 minutes/iu);
  for (const gate of ['zéro HTTP 429', 'backlog', 'RSS', 'p95', 'finalit', 'idempot', 'quatre heures', 'affinit', 'shutdown']) {
    assert.match(runbook, new RegExp(gate, 'iu'));
  }
  assert.match(runbook, /readiness Mainnet[^.]*déclarée avant/iu);
  assert.match(runbook, /métrique brute[^.]{0,240}omise[^.]{0,240}`heartbeat\.catchUpAdmission: null`/iu);
  assert.doesNotMatch(runbook, /heartbeat\.catchUpAdmission\.enabled=false/iu);
  assert.match(runbook, /Rollback B3b admission-only[\s\S]{0,500}LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false[\s\S]{0,500}LISTENER_BLOCK_HYDRATION_ENABLED=true/iu);
  assert.match(runbook, /Rollback complet d'hydratation bloc[\s\S]{0,500}LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false[\s\S]{0,500}LISTENER_BLOCK_HYDRATION_ENABLED=false[\s\S]{0,300}redémarr/iu);
});

void test('decoder quarantine runbook documents bounded observation-only recovery', async () => {
  const [runbook, design, plan] = await Promise.all([
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('docs/superpowers/specs/2026-09-20-pumpfun-decoder-quarantine-design.md'),
    readArtifact('docs/superpowers/plans/2026-09-20-pumpfun-decoder-quarantine.md'),
  ]);
  assert.match(design, /Version: 1\.0\.5/u);
  assert.match(plan, /Version: 1\.0\.6/u);
  assert.match(plan, /docs\/operations\/block-hydration-canary\.md/u);
  assert.doesNotMatch(plan, /docs\/runbooks\/mainnet-observe-dry-run\.md/u);
  assert.match(runbook, /heartbeat\.decoderQuarantine[^.]{0,200}unresolvedCount/iu);
  assert.match(runbook, /npm run inbox:recover-decoder -- --signature=<SIGNATURE> --confirm=<SIGNATURE>/u);
  assert.match(runbook, /SELECT\s+signature[\s\S]{0,1800}chain_transaction_inbox/iu);
  assert.match(runbook, /terminal_at[\s\S]{0,240}signature/iu);
  assert.match(runbook, /local[^.]{0,240}(?:non publié|ne doit pas être publié)/iu);
  for (const code of [
    'DECODER_RECOVERY_SCHEDULED', 'DECODER_RECOVERY_ALREADY_SCHEDULED',
    'DECODER_RECOVERY_NOT_FOUND', 'DECODER_RECOVERY_EXPIRED',
    'DECODER_RECOVERY_NOT_ELIGIBLE',
  ]) assert.match(runbook, new RegExp(code, 'u'));
  assert.match(runbook, /quatre heures[^.]{0,240}mise\s+en\s+quarantaine\s+originale/iu);
  assert.match(runbook, /reçu d.audit[^.]{0,240}purge quatre heures/iu);
  assert.match(runbook, /marqueur booléen monotone[^.]{0,240}expiration du reçu/iu);
  assert.match(runbook, /n'est jamais une autorisation de trade/iu);
  assert.match(runbook, /ni succès du décodage, ni qualification, ni sellabilité, ni profit/iu);
  assert.match(runbook, /aucune transaction brute/iu);
});

void test('block hydration runbook defines the corrected worker-eligible cohort and mandatory replay', async () => {
  const runbook = await readArtifact('docs/operations/block-hydration-canary.md');

  assert.match(runbook, /Version : 1\.2\.8/u);
  assert.match(runbook, /population worker-éligible/iu);
  for (const exclusion of [
    'IGNORED / SOLANA_TRANSACTION_FAILED',
    'IGNORED / NO_SUPPORTED_PUMP_ACTION',
    'DEFERRED / PUMP_TRADE_UNTRACKED',
  ]) assert.match(runbook, new RegExp(exclusion, 'u'));
  assert.match(runbook, /IGNORED[^.]{0,160}provenance[^.]{0,120}exclusivement[^.]{0,80}CATCH_UP/iu);
  assert.match(runbook, /DEFERRED[^.]{0,160}WEBSOCKET[^.]{0,160}sans aucun reçu catch-up/iu);
  assert.match(runbook, /WEBSOCKET, CATCH_UP[^.]{0,200}reçu V1 deferred[^.]{0,120}même mint/iu);
  assert.match(runbook, /Toute autre combinaison de provenance[^.]{0,160}fail-closed/iu);
  assert.match(runbook, /QUARANTINED[^.]{0,240}bloquant/iu);
  assert.match(runbook, /(?:état|combinaison)[^.]{0,120}malformé[^.]{0,240}bloquant/iu);
  for (const independentGate of [
    'backlog', 'finalité', 'oversize', 'rétention', 'HTTP 429',
  ]) {
    assert.match(
      runbook,
      new RegExp(`gates[^.]{0,320}${independentGate}[^.]{0,320}indépendants`, 'iu'),
    );
  }
  assert.match(runbook, /canary Mainnet[^.]{0,240}2026-09-24[^.]{0,240}doit être rejoué/iu);
});

void test('block hydration runbook keeps catch-up refresh continuation bounded and fail-closed', async () => {
  const runbook = await readArtifact('docs/operations/block-hydration-canary.md');

  assert.match(runbook, /Version : 1\.2\.8/u);
  assert.match(runbook, /CATCH_UP_REFRESH_REQUIRED[\s\S]{0,400}exactement un scan supplémentaire/iu);
  assert.match(runbook, /même provider[\s\S]{0,180}même session WebSocket[\s\S]{0,180}même signal d'arrêt/iu);
  assert.match(runbook, /ne promeut jamais[\s\S]{0,180}avant la réussite[\s\S]{0,120}seconde passe/iu);
  assert.match(runbook, /deuxième `CATCH_UP_REFRESH_REQUIRED`[\s\S]{0,400}ferme la session puis applique le jitter/iu);
  assert.match(runbook, /CATCH_UP_PAGE_BUDGET_EXHAUSTED[\s\S]{0,400}ferme la session puis applique le jitter/iu);
  assert.match(runbook, /erreur\s+transitoire ou une fin de session[^.]{0,240}DEGRADED[^.]{0,240}récupération/iu);
  assert.match(runbook, /arrêt ferme les ressources[^.]{0,240}STOPPING[^.]{0,120}STOPPED[^.]{0,180}aucun retry/iu);
  assert.match(runbook, /Tous ces chemins restent fail-closed/iu);
  assert.match(runbook, /ne modifie ni la concurrence RPC[\s\S]{0,240}cadence d'hydratation/iu);
});

void test('finality reconciler diagnostics are composed and documented as a non-PASS signal', async () => {
  const [runbook, factory] = await Promise.all([
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('src/application/production-listener-factory.ts'),
  ]);

  assert.match(runbook, /Version : 1\.2\.8/u);
  assert.match(runbook, /listener\.finality_reconciler_degraded/u);
  assert.match(runbook, /listener\.finality_reconciler_recovered/u);
  for (const reasonCode of [
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_CHANGED',
    'FINALITY_LIST',
    'FINALITY_PASS',
    'FINALITY_HISTORY',
    'FINALITY_ROOT',
    'FINALITY_POLL',
    'FINALITY_BLOCK',
    'FINALITY_REVISION',
    'FINALITY_CLOCK',
    'FINALITY_CONTRADICTION',
    'UNKNOWN',
  ]) assert.match(runbook, new RegExp(reasonCode, 'u'));
  assert.match(runbook, /une fois toutes les douze défaillances/iu);
  assert.match(runbook, /durationMs[^.]{0,240}durée/iu);
  assert.match(runbook, /DEGRADED[^.]{0,240}(?:n'autorise|interdit)[^.]{0,120}PASS/iu);
  assert.match(factory, /createFinalityReconcilerDiagnosticSink\(logger\)/u);
  assert.doesNotMatch(factory, /diagnosticSink[^\n]{0,240}(?:database|repository|wallet|executor)/iu);
});

void test('local frontend development proxies the read-only V1 API to the loopback backend', async () => {
  const vite = await readArtifact('frontend/vite.config.ts');
  const readme = await readArtifact('frontend/README.md');

  assert.match(
    vite,
    /server:\s*\{[\s\S]*?proxy:\s*\{[\s\S]*?'\/api\/v1':\s*\{[\s\S]*?target:\s*'http:\/\/127\.0\.0\.1:3000',[\s\S]*?changeOrigin:\s*false,[\s\S]*?ws:\s*false,/,
  );
  assert.match(vite, /rejectNonReadOnlyApiMethod/);
  assert.match(vite, /server\.middlewares\.use\('\/api\/v1'/);
  assert.match(readme, /proxy[\s\S]{0,160}\/api\/v1[\s\S]{0,160}127\.0\.0\.1:3000/i);
});

void test('cross-origin Playwright uses a generated dist-only runtime config without changing production config', async () => {
  const playwright = await readArtifact('frontend/playwright.config.ts');
  const setup = await readArtifact('frontend/tests/e2e/write-cross-origin-config.mjs');
  const productionConfig = await readArtifact('frontend/public/config.json');

  assert.equal(productionConfig, '{\n  "apiBaseUrl": "/"\n}\n');
  assert.match(setup, /new URL\('\.\.\/\.\.\/dist\/config\.json', import\.meta\.url\)/);
  assert.match(setup, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(setup, /writeFile\([^,]+, serialized, 'utf8'\)/);
  assert.match(
    playwright,
    /command:\s*'npm run build && node tests\/e2e\/write-cross-origin-config\.mjs && npm run preview -- --host 127\.0\.0\.1 --port 4173'/,
  );
});

void test('Compose keeps the raw PostgreSQL password separate from its URI-encoded form', async () => {
  const compose = await readArtifact('deploy/compose.yaml');
  const rawPassword = 'example:@/?#[]';
  const encodedPassword = 'example%3A%40%2F%3F%23%5B%5D';

  assert.match(
    compose,
    /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_USER:\?POSTGRES_USER is required\}:\$\{POSTGRES_PASSWORD_URI_ENCODED:\?POSTGRES_PASSWORD_URI_ENCODED is required\}@postgres:5432\/\$\{POSTGRES_DB:\?POSTGRES_DB is required\}/,
  );
  assert.match(
    composeService(compose, 'postgres'),
    /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?POSTGRES_PASSWORD is required\}/,
  );
  assert.doesNotMatch(compose, /DATABASE_URL:[^\n]*\$\{POSTGRES_PASSWORD:\?/);

  const databaseUrl = `postgresql://listener:${encodedPassword}@postgres:5432/listener`;
  const postgresEnvironment = { POSTGRES_PASSWORD: rawPassword };
  assert.equal(new URL(databaseUrl).password, encodedPassword);
  assert.equal(postgresEnvironment.POSTGRES_PASSWORD, rawPassword);
  assert.notEqual(postgresEnvironment.POSTGRES_PASSWORD, new URL(databaseUrl).password);
});

void test('Compose environment template contains documentation-only required inputs', async () => {
  const environment = await readArtifact('deploy/env.example');

  for (const value of [
    'POSTGRES_DB=sol_token_listener',
    'POSTGRES_USER=sol_token_listener',
    'POSTGRES_PASSWORD=replace-with-a-secret',
    'POSTGRES_PASSWORD_URI_ENCODED=replace-with-a-secret',
    `BACKEND_IMAGE=registry.invalid/sol-token-listener/backend@sha256:${'0'.repeat(64)}`,
    `FRONTEND_IMAGE=registry.invalid/sol-token-listener/frontend@sha256:${'1'.repeat(64)}`,
    'SOLANA_HTTP_RPC_URL=https://rpc-provider.invalid',
    'SOLANA_HTTP_RPC_FALLBACK_URLS=',
    'SOLANA_WS_RPC_URL=wss://rpc-provider.invalid',
    'SOLANA_WS_RPC_FALLBACK_URLS=',
    'SOLANA_EXPECTED_GENESIS_HASH=',
    'FRONTEND_PORT=8080',
    'LISTENER_ENABLED=true',
    'RETENTION_PURGE_INTERVAL_MS=900000',
  ]) {
    assert.ok(environment.includes(value), `missing deploy environment value: ${value}`);
  }
  assert.match(environment, /outside version control/i);
  assert.match(environment, /must be replaced/i);
  assert.match(environment, /POSTGRES_PASSWORD_URI_ENCODED must be the percent-encoding of POSTGRES_PASSWORD/i);
  assert.match(environment, /unreserved example values can be identical/i);
  assert.match(
    environment,
    /^# Optional ordered, comma-separated fallback HTTP RPC URLs \(maximum 3\); use the same scheme and this can remain blank\.\nSOLANA_HTTP_RPC_FALLBACK_URLS=$/m,
  );
  assert.match(
    environment,
    /^# Optional paired WebSocket fallbacks; positions must match the HTTP fallback list and this can remain blank\.\nSOLANA_WS_RPC_FALLBACK_URLS=$/m,
  );
  assert.match(
    environment,
    /canonical 32-byte base58 genesis hash/i,
  );
  assert.doesNotMatch(environment, /PRIVATE_KEY|SECRET_KEY|WALLET/i);
  for (const name of ['BACKEND_IMAGE', 'FRONTEND_IMAGE']) {
    assert.match(environment, new RegExp(`^${name}=registry\\.invalid/[^\\s@]+@sha256:[0-9a-f]{64}$`, 'm'));
  }
});

void test('deployment smoke is bounded, isolated, secret-free, and always cleans its project', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');
  const packageJson = JSON.parse(await readArtifact('package.json')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const ci = await readArtifact('.github/workflows/ci.yml');

  assert.match(smoke, /sol-listener-smoke-\$\{process\.pid\}-\$\{randomBytes\(4\)\.toString\('hex'\)\}/);
  assert.match(smoke, /GLOBAL_TIMEOUT_MS\s*=\s*600_000/);
  assert.match(smoke, /REQUEST_TIMEOUT_MS\s*=\s*10_000/);
  assert.match(smoke, /postgresPassword\s*=\s*randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(smoke, /POSTGRES_PASSWORD:\s*postgresPassword/);
  assert.match(smoke, /POSTGRES_PASSWORD_URI_ENCODED:\s*encodeURIComponent\(postgresPassword\)/);
  assert.match(smoke, /SOLANA_HTTP_RPC_URL:\s*'https:\/\/rpc\.invalid'/);
  assert.match(smoke, /SOLANA_WS_RPC_URL:\s*'wss:\/\/rpc\.invalid'/);
  assert.match(smoke, /LISTENER_ENABLED:\s*'false'/);
  assert.doesNotMatch(smoke, /SOLANA_EXPECTED_GENESIS_HASH/);
  assert.match(smoke, /BACKEND_IMAGE:\s*deploymentImages\.backend/);
  assert.match(smoke, /FRONTEND_IMAGE:\s*deploymentImages\.frontend/);
  assert.match(smoke, /const smokeComposeFile = resolve\(root, 'deploy\/compose\.smoke\.yaml'\)/);
  assert.match(
    smoke,
    /return \['compose', \.\.\.projectArgs, '-f', composeFile, '-f', smokeComposeFile, \.\.\.args\];/,
  );
  assert.match(smoke, /await compose\(\['build', 'app', 'frontend'\]\)/);
  assert.match(smoke, /composeCommand\(\[\s*'exec', '-T', 'postgres', 'psql'/);
  assert.match(smoke, /composeCommand\(\['down', '--volumes', '--remove-orphans', '--rmi', 'local'\]\)/);
  assert.equal((smoke.match(/\['compose'/g) ?? []).length, 1);
  assert.match(smoke, /com\.docker\.compose\.project=/);
  assert.match(smoke, /'016_listener_catch_up_gaps\.sql'/);
  assert.match(smoke, /'017_creation_entry_strategy\.sql'/);
  assert.match(smoke, /'018_paper_mvp_validation\.sql'/);
  assert.match(smoke, /'022_paper_mvp_coverage_indexes\.sql'/);
  assert.match(smoke, /'023_paper_mvp_exact_strategy\.sql'/);
  assert.match(smoke, /'024_paper_mvp_position_coverage\.sql'/);
  assert.match(smoke, /'025_paper_mvp_effective_configuration\.sql'/);
  assert.match(smoke, /'028_paper_finality_replay_evidence\.sql'/);
  assert.match(smoke, /'029_paper_finality_claim_scheduler\.sql'/);
  assert.match(smoke, /'030_listener_websocket_health\.sql'/);
  assert.match(smoke, /'031_execution_intents\.sql'/);
  assert.match(smoke, /'036_execution_live_canary\.sql'/);
  assert.match(smoke, /'paperMvpRuns'/);
  assert.match(smoke, /'paperMvpSamples'/);
  assert.match(smoke, /'listenerCatchUpGaps'/);
  assert.match(smoke, /'listenerStrictCatchUpFailures'/);
  assert.match(smoke, /'listenerStrictCatchUpRuns'/);
  assert.match(smoke, /'046_listener_strict_catch_up_runs\.sql'/);
  assert.match(smoke, /'executionIntentTransitions'/);
  assert.match(smoke, /'executionAttempts'/);
  assert.match(smoke, /'executionIntents'/);
  assert.doesNotMatch(smoke, /Migration history does not contain exactly 14 rows\./);
  assert.doesNotMatch(smoke, /--privileged|network_mode|host networking|docker system prune|private[_ -]?key|\bwallet\b/iu);
  assert.doesNotMatch(smoke, /sol-token-listener-(?:backend|frontend):(?:smoke|latest)/u);

  assert.equal(packageJson.scripts?.['deployment:smoke'], 'node scripts/deployment-smoke.mjs');
  assert.match(ci, /^ {2}deployment-contract:\s*$/m);
  assert.match(ci, /deployment-contract:[\s\S]*?timeout-minutes: 25/);
  assert.match(ci, /deployment-contract:[\s\S]*?node-version: 22\.13\.0/);
  assert.match(ci, /deployment-contract:[\s\S]*?- run: npm ci/);
  assert.match(ci, /deployment-contract:[\s\S]*?- run: npm run deployment:smoke/);
  assert.doesNotMatch(ci, /deployment-contract:[\s\S]*?secrets\./);
});

void test('deployment smoke accepts only one bounded retention aggregate with silent stderr', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');
  const retention = smoke.slice(
    smoke.indexOf('async function assertRetentionOneShot'),
    smoke.indexOf('async function fetchBounded'),
  );

  assert.match(
    retention,
    /const \{ stdout, stderr \} = await compose\(\[\s*'exec', '-T', 'retention'/,
  );
  assert.match(retention, /if \(stderr !== ''\) throw new Error\('Retention emitted unexpected stderr\.'\)/);
  assert.match(retention, /reflectFailureOutput: false/);
  assert.match(retention, /MAX_RETENTION_OUTPUT_BYTES/);
  assert.match(retention, /JSON\.parse\(serialized\)/);
  assert.match(retention, /canonicalRetentionCounters/);
  assert.match(
    smoke,
    /'transactionInboxDecoderRecoveries',\n {2}'transactionInboxRecoveries',/u,
    'deployment smoke must expect the decoder recovery retention counter',
  );
  assert.match(
    smoke,
    /'executionActivationArmaments',\n {2}'executionActivationEvents',\n {2}'executionAttempts',\n {2}'executionControlEvents',\n {2}'executionDryRunAssessments',\n {2}'executionExitAuthorizations',\n {2}'executionIntents',\n {2}'executionIntentsExpiredPreSubmission',\n {2}'executionIntentTransitions',\n {2}'executionLivePositions',\n {2}'executionLiveUnsignedSimulationEvidence',\n {2}'executionOperatorAuthorizations',\n {2}'executionPreflightIntentPairMemberships',\n {2}'executionPreflightIntentPairs',\n {2}'executionPreflightPreparationRuns',\n {2}'executionPreSignatureLocks',\n {2}'executionRiskAdmissionReports',\n {2}'executionRiskFaults',\n {2}'executionRiskProviderOperations',\n {2}'executionRiskProviderSnapshots',\n {2}'executionRiskRateLimitEvents',\n {2}'executionRiskReconciliationEvidence',\n {2}'executionRiskReservations',\n {2}'executionRiskTombstones',\n {2}'executionRiskWalletSnapshots',\n {2}'executionSafetyQualifications',\n {2}'executionSignedSimulationEvidence',\n {2}'executionSignedTransactions',\n {2}'executionSimulationArtifacts',\n {2}'executionSubmissionEvents',/u,
    'deployment smoke must expect every sorted execution retention counter',
  );
  assert.doesNotMatch(retention, /\.split\('\n'\).*\.filter/s);
  assert.doesNotMatch(retention, /new Error\(`[^`]*\$\{(?:stdout|stderr)\}/);
  assert.doesNotMatch(retention, /new Error\([^)]*\+\s*(?:stdout|stderr)/s);
});

void test('deployment smoke proves all project resources are absent after cleanup', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /\['ps', '-a', '--filter', label, '--format', '\{\{\.ID\}\}'\]/);
  assert.match(smoke, /\['network', 'ls', '--filter', label, '--format', '\{\{\.ID\}\}'\]/);
  assert.match(smoke, /\['volume', 'ls', '--filter', label, '--format', '\{\{\.Name\}\}'\]/);
  assert.match(smoke, /\['image', 'ls', '--filter', label, '--format', '\{\{\.ID\}\}'\]/);
  assert.match(smoke, /\['image', 'rm', imageReference\]/);
  assert.match(smoke, /reference=\$\{imageReference\}/);
  assert.match(smoke, /Deployment smoke left an explicit image reference behind\./);
  assert.match(smoke, /cleanupFailures\.push\(error\)/);
  assert.match(
    smoke,
    /new AggregateError\(\[primaryFailure, \.\.\.cleanupFailures\], 'Deployment smoke and cleanup failed\.'\)/,
  );
  assert.match(smoke, /new AggregateError\(cleanupFailures, 'Deployment smoke cleanup failed\.'\)/);
});

void test('deployment smoke handles signals through one bounded cleanup path before reporting status', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');
  const packageJson = JSON.parse(await readArtifact('package.json')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const ci = await readArtifact('.github/workflows/ci.yml');

  assert.match(smoke, /CLEANUP_TIMEOUT_MS\s*=\s*65_000/);
  assert.match(smoke, /SIGNAL_CHILD_TIMEOUT_MS\s*=\s*5_000/);
  assert.match(smoke, /SELF_SIGNAL_TIMEOUT_MS\s*=\s*1_000/);
  assert.match(smoke, /process\.on\('SIGINT'/);
  assert.match(smoke, /process\.on\('SIGTERM'/);
  assert.match(smoke, /process\.off\('SIGINT'/);
  assert.match(smoke, /process\.off\('SIGTERM'/);
  assert.match(smoke, /child\.kill\('SIGTERM'\)/);
  assert.match(smoke, /child\.kill\('SIGKILL'\)/);
  assert.match(smoke, /SIGINT:\s*130/);
  assert.match(smoke, /SIGTERM:\s*143/);
  assert.match(smoke, /--self-sigterm/);
  assert.match(smoke, /--signal-fault-probe/);
  assert.match(smoke, /await runSignalFaultProbe\(invocationMode === 'signal-fault-probe-kill' \? 'SIGKILL' : 'SIGTERM'\)/);
  assert.match(smoke, /await runActiveChildSignalProbe\(selfSignal\)/);
  assert.match(smoke, /'exec', '-T', 'app', 'node', '-e', 'setInterval\(\(\) => undefined, 1_000\)'/);
  assert.match(smoke, /if \(exitCode === 0\) process\.stdout\.write\('Deployment smoke passed\.\\n'\)/);
  assert.equal(packageJson.scripts?.['deployment:smoke:signal'], 'node scripts/deployment-smoke.mjs --signal-fault-probe');
  assert.match(ci, /deployment-contract:[\s\S]*?- run: npm run deployment:smoke:signal/);
});

void test('deployment smoke discovers Docker allocated loopback port after startup', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /FRONTEND_PORT:\s*'0'/);
  assert.match(smoke, /\['port', 'frontend', '8080'\]/);
  assert.match(smoke, /\^127\\\.0\\\.0\\\.1:\(\[1-9\]\[0-9\]\{0,4\}\)\\n\$/);
  assert.doesNotMatch(smoke, /reserveLoopbackPort|createServer/);
});

void test('failed signal fault probes always clean only their explicit child project', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /finally\s*{\s*cleanupDeadlineAt = Date\.now\(\) \+ CLEANUP_TIMEOUT_MS;/);
  assert.match(smoke, /await cleanupFaultProject\(faultName, cleanupFailures\)/);
  assert.match(
    smoke,
    /composeCommand\(\['down', '--volumes', '--remove-orphans', '--rmi', 'local'\], faultName\)/,
  );
  assert.match(smoke, /COMPOSE_PROJECT_NAME:\s*faultName/);
  assert.match(smoke, /--signal-fault-probe-kill/);
  assert.match(smoke, /--self-sigkill/);
  assert.match(smoke, /new AggregateError\(\[primaryFailure, \.\.\.cleanupFailures\]/);
});

void test('top-level deployment errors are categorized, bounded, and never reflect input', () => {
  const secret = `review-secret-${'x'.repeat(4_096)}`;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/deployment-smoke.mjs', import.meta.url)), secret],
    { encoding: 'utf8', timeout: 10_000 },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Deployment smoke failed: Error(arguments).\n');
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 1_024);
  assert.doesNotMatch(result.stderr, /review-secret|deployment-smoke\.mjs:\d+|\bat\s/u);
});

void test('deployment error summaries categorize aggregate causes without raw messages', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /error instanceof AggregateError/);
  assert.match(smoke, /MAX_FAILURE_SUMMARY_BYTES\s*=\s*1_024/);
  assert.match(smoke, /redact\(summary\)/);
  assert.doesNotMatch(smoke, /process\.stderr\.write\([^)]*error\.(?:message|stack)/s);
});

void test('deployment runbook documents the safe production lifecycle and safety boundary', async () => {
  const runbook = await readArtifact('docs/operations/deployment.md');
  const packageJson = JSON.parse(await readArtifact('package.json')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };

  for (const heading of [
    '## Prérequis',
    '## Images immuables',
    '## Secrets externes',
    '## Migration et verrou consultatif',
    '## Démarrage',
    '## Arrêt normal',
    '## Santé et supervision',
    '## Rétention et confidentialité',
    '## Sauvegarde',
    '## Répétition de restauration',
    '## Rollback',
    '## Proxy SSE et TLS externe',
    '## Limite de réplica unique',
    '## Arrêt incident',
    '## Frontière no-live',
  ]) {
    assert.ok(runbook.includes(heading), `missing runbook section: ${heading}`);
  }

  assert.match(runbook, /export DEPLOY_ENV=\/etc\/sol-token-listener\/deploy\.env/);
  assert.match(runbook, /docker compose --env-file "\$DEPLOY_ENV" -f deploy\/compose\.yaml/);
  assert.match(runbook, /deploy\/env\.example[^\n]*jamais[^\n]*secret[^\n]*production/i);
  assert.match(runbook, /pg_advisory_lock/);
  assert.match(
    runbook,
    /verrou[\s\S]{0,240}(?:sérialise|coordonne)[^\n]*migrateurs[\s\S]{0,240}(?:n’arrête|ne stoppe|ne coordonne)[^\n]*(?:app|application|worker)/i,
  );
  assert.match(
    runbook,
    /docker compose --env-file "\$DEPLOY_ENV" -f deploy\/compose\.yaml --project-name sol-token-listener up --detach --wait --wait-timeout 60 --no-build postgres/,
  );
  assert.match(runbook, /exec -T app node dist\/scripts\/deployment-healthcheck\.js/);
  assert.match(runbook, /pull postgres migrate app retention frontend/);
  const escapedPostgresImage = postgresImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const validationPipeline = new RegExp(
    `docker compose --env-file "\\$DEPLOY_ENV" -f deploy/compose\\.yaml --project-name sol-token-listener config --images migrate app retention frontend \\| grep -Fvx '${escapedPostgresImage}' \\| npm run --silent deployment:validate-images`,
    'g',
  );
  assert.equal((runbook.match(validationPipeline) ?? []).length, 2);
  assert.equal(
    packageJson.scripts?.['deployment:validate-images'],
    'node scripts/validate-deployment-images.mjs',
  );
  assert.match(runbook, /up --detach --wait --wait-timeout 60 --no-build postgres/);
  assert.match(runbook, /deployment-healthcheck\.js --require-ok/);
  assert.match(runbook, /up -d --no-build --no-deps frontend/);
  assert.match(runbook, /4 heures/);
  assert.match(runbook, /15 minutes/);
  assert.match(runbook, /DEGRADED[\s\S]{0,120}smoke[\s\S]{0,120}listener[\s\S]{0,120}désactivé/i);
  assert.match(runbook, /production[^\n]*OK/i);
  assert.match(runbook, /down --volumes[\s\S]{0,120}destructif[\s\S]{0,120}jamais[\s\S]{0,120}arrêt normal/i);
  assert.match(runbook, /sans inverser[^\n]*migration/i);
  const startup = runbook.slice(runbook.indexOf('## Démarrage'), runbook.indexOf('## Arrêt normal'));
  const startupStop = 'stop --timeout 40 frontend app retention';
  const startupStopIndex = startup.indexOf(startupStop);
  assert.notEqual(startupStopIndex, -1, 'rollout must stop every application service');
  assert.ok(startupStopIndex > startup.indexOf('sauvegarde'), 'backup must precede downtime');
  assert.ok(startupStopIndex > startup.indexOf('pull postgres migrate app retention frontend'));
  assert.ok(startupStopIndex > startup.indexOf('deployment:validate-images'));
  assert.ok(startupStopIndex < startup.indexOf('run --rm --no-deps migrate'));
  assert.match(startup, /indisponib|downtime/i);
  assert.match(startup, /commande[^\n]*(?:attend|bloque)|(?:attend|bloque)[^\n]*commande/i);

  const rollback = runbook.slice(runbook.indexOf('## Rollback'), runbook.indexOf('## Proxy SSE'));
  const rollbackStopIndex = rollback.indexOf(startupStop);
  assert.notEqual(rollbackStopIndex, -1, 'rollback must stop every application service');
  assert.ok(rollbackStopIndex < rollback.indexOf('BACKEND_IMAGE'));
  assert.ok(rollbackStopIndex < rollback.indexOf('pull app frontend retention'));
  assert.ok(rollbackStopIndex < rollback.indexOf('up -d --wait --wait-timeout 60 --no-build --no-deps app retention'));
  assert.match(rollback, /BACKEND_IMAGE[\s\S]*FRONTEND_IMAGE[\s\S]*références immuables précédentes/iu);
  assert.match(rollback, /repository@sha256:…/u);
  assert.match(rollback, /ne doivent pas être vides|refus(?:e|ent) une\s+valeur vide/iu);
  assert.match(rollback, /pull app frontend retention/);
  assert.match(rollback, /up -d --wait --wait-timeout 60 --no-build --no-deps app retention/);
  assert.match(rollback, /up -d --wait --wait-timeout 60 --no-build --no-deps frontend/);
  assert.ok(
    rollback.indexOf('up -d --wait --wait-timeout 60 --no-build --no-deps app retention')
      < rollback.indexOf('deployment-healthcheck.js --require-ok')
      && rollback.indexOf('deployment-healthcheck.js --require-ok')
        < rollback.indexOf('up -d --wait --wait-timeout 60 --no-build --no-deps frontend'),
    'backend readiness and strict health must precede frontend re-exposure',
  );
  assert.doesNotMatch(
    rollback,
    /stop app\n.*up -d --wait --wait-timeout 60 app\n.*deployment-healthcheck\.js --require-ok/s,
  );
  assert.match(runbook, /restauration[^\n]*répétée/i);
  assert.match(runbook, /EXÉCUTION_MODE=observe|EXECUTION_MODE=observe/);
  assert.match(runbook, /observe|paper/i);
  assert.match(runbook, /aucun[^\n]*(?:wallet|clé privée|ordre réel|transaction live)/i);
  assert.equal((runbook.match(/^health_attempt=0$/gm) ?? []).length, 2);
  assert.equal((runbook.match(/^until docker compose .*deployment-healthcheck\.js --require-ok; do$/gm) ?? []).length, 2);
  assert.equal((runbook.match(/^ {2}if \[ "\$health_attempt" -ge 30 \]; then$/gm) ?? []).length, 2);
  assert.equal((runbook.match(/^ {4}if ! docker compose .* stop --timeout 40 app retention; then$/gm) ?? []).length, 2);
  assert.equal((runbook.match(/^ {6}echo 'Le healthcheck strict a échoué et l’arrêt de sécurité app\/retention a aussi échoué\.' >&2$/gm) ?? []).length, 2);
  assert.equal((runbook.match(
    /^ {4}echo 'Le healthcheck strict n’a pas convergé ; le déploiement est interrompu\.' >&2\n {4}exit 1\n {2}fi$/gm,
  ) ?? []).length, 2);
  assert.equal((runbook.match(/^ {2}sleep 2$/gm) ?? []).length, 2);
  assert.equal((runbook.match(/^set -euo pipefail$/gm) ?? []).length, 2);
});

void test('every deployment runbook shell block is syntactically valid Bash', async () => {
  const runbook = await readArtifact('docs/operations/deployment.md');
  const blocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  assert.ok(blocks.length >= 6);
  for (const block of blocks) {
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: block, timeout: 10_000 });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(syntax.stdout, '');
    assert.equal(syntax.stderr, '');
  }
});

void test('deployment runbook verifies a real SSE heartbeat with a bounded, cleanup-safe curl probe', async () => {
  const runbook = await readArtifact('docs/operations/deployment.md');

  assert.match(runbook, /sse_headers="\$\(mktemp\)"/);
  assert.match(runbook, /sse_body="\$\(mktemp\)"/);
  assert.match(runbook, /trap 'rm -f "\$sse_headers" "\$sse_body"' EXIT/);
  assert.match(runbook, /curl --fail-with-body --silent --show-error --no-buffer --max-time 20/);
  assert.match(runbook, /--dump-header "\$sse_headers"/);
  assert.match(runbook, /--output "\$sse_body"/);
  assert.match(runbook, /if \[ "\$sse_status" -ne 28 \]/);
  assert.match(runbook, /content-type:\[\[:space:\]\]\*text\/event-stream/);
  assert.match(runbook, /grep -Fq ': heartbeat' "\$sse_body"/);
  assert.doesNotMatch(runbook, /curl --no-buffer --max-time 10/);
});

void test('operator documentation activates the safe websocket failover contract', async () => {
  const [readme, api, overview, deployment, rpcQualification] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('docs/api/v1.md'),
    readArtifact('docs/system-overview.html'),
    readArtifact('docs/operations/deployment.md'),
    readArtifact('docs/operations/rpc-qualification.md'),
  ]);
  const documentation = [readme, api, overview, deployment, rpcQualification].join('\n');

  assert.match(readme, /\[Guide de déploiement\]\(docs\/operations\/deployment\.md\)/);
  assert.match(readme, /npm run deployment:smoke/);
  assert.match(readme, /réplica unique|single replica/i);
  assert.match(readme, /observe\/paper|observe et paper/i);
  assert.match(readme, /4\s+heures/);
  assert.match(readme, /TLS externe/i);
  assert.match(readme, /sauvegarde externe/i);
  assert.match(readme, /aucune promesse[^\n]*(?:première position|sellabilité|profit)/i);

  assert.match(overview, /href="operations\/deployment\.md"/);
  assert.match(overview, /npm run deployment:smoke/);
  assert.match(overview, /réplica unique|single replica/i);
  assert.match(overview, /TLS externe/i);
  assert.match(overview, /sauvegarde externe/i);
  assert.match(overview, /aucune promesse[^<]*(?:première position|sellabilité|profit)/i);

  for (const statement of [
    'double ACK',
    '30 secondes',
    'primary',
    'fallback-1',
    '1–60 secondes',
    'UNRECOVERABLE',
    'SOLANA_EXPECTED_GENESIS_HASH',
    'getGenesisHash',
    'observe/paper',
    'SolanaProgramSubscriber',
  ]) assert.ok(documentation.includes(statement), `missing active operational statement: ${statement}`);
  assert.doesNotMatch(documentation, /inactive until #63|inactive.*#63|jusqu[^\n]{0,80}#63/iu);
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml up -d migrate/);
  assert.match(deployment, /DOTENV_CONFIG_PATH=deploy\/\.env npm run rpc:check/);
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml up -d --wait --wait-timeout 60 app frontend retention/);
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml exec -T app[\s\S]*deployment-healthcheck\.js --require-ok/);
  assert.match(deployment, /références immuables précédentes/i);
  assert.match(deployment, /migrations[^.]*forward-only/i);
  assert.ok(
    deployment.indexOf('up -d --wait --wait-timeout 60 app frontend retention')
      < deployment.indexOf('deployment-healthcheck.js --require-ok'),
    'Compose readiness must be awaited before the strict healthcheck',
  );
});

void test('documented RPC preflight uses dotenv explicit-path support', async () => {
  const [packageJson, checkRpc, config] = await Promise.all([
    readArtifact('package.json'),
    readArtifact('scripts/check-rpc.ts'),
    readArtifact('src/config/env.ts'),
  ]);
  const parsed = JSON.parse(packageJson) as { readonly scripts?: Readonly<Record<string, string>> };

  assert.equal(parsed.scripts?.['rpc:check'], 'tsx scripts/check-rpc.ts');
  assert.match(checkRpc, /loadConfig\(\)/);
  assert.match(config, /^import 'dotenv\/config';$/m);

  const directory = await mkdtemp(join(tmpdir(), 'sol-token-listener-dotenv-'));
  const environmentPath = join(directory, '.env');
  try {
    await writeFile(environmentPath, 'TASK8_DOTENV_CONTRACT=loaded\n', 'utf8');
    const result = spawnSync(
      process.execPath,
      ['--import', 'dotenv/config', '--eval', 'process.stdout.write(process.env.TASK8_DOTENV_CONTRACT ?? "")'],
      {
        cwd: fileURLToPath(root),
        encoding: 'utf8',
        env: { ...process.env, DOTENV_CONFIG_PATH: environmentPath },
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'loaded');
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('operator overview renders the durable WebSocket lifecycle without exposing connection material', async () => {
  const overview = await readArtifact('docs/system-overview.html');
  const sectionStart = overview.indexOf('<section id="websocket-health-lifecycle"');
  const sectionEnd = overview.indexOf('</section>', sectionStart);
  assert.notEqual(sectionStart, -1, 'missing durable WebSocket lifecycle section');
  assert.notEqual(sectionEnd, -1, 'durable WebSocket lifecycle section must be bounded');
  const section = overview.slice(sectionStart, sectionEnd);

  assert.match(section, /class="card/);
  assert.match(section, /class="alert/);
  assert.match(section, /class="table-responsive/);
  assert.match(section, /<svg id="diagram-websocket-health"/);
  assert.match(section, /<title id="diagram-websocket-health-title">/);
  assert.match(section, /<desc id="diagram-websocket-health-desc">/);
  for (const phase of [
    'STOPPED', 'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING',
    'RUNNING', 'DEGRADED',
  ]) assert.ok(section.includes(phase), `missing lifecycle phase: ${phase}`);
  assert.match(section, /ACTIVE[^<]*(?:double ACK|deux ACK)/iu);
  assert.match(section, /UNRECOVERABLE/iu);
  assert.match(section, /30 secondes/iu);
  assert.match(section, /quatre heures/iu);
  assert.match(section, /dernière observation[^<]*pas[^<]*frontière[^<]*complétude/iu);
  assert.match(section, /primary[^<]*fallback-1[^<]*fallback-2[^<]*fallback-3/iu);
  assert.doesNotMatch(section, /(?:https?|wss):\/\//iu);
  assert.doesNotMatch(section, /EXECUTION_MODE=live|sendTransaction\s*\(|signTransaction\s*\(|private[_ -]?key/iu);
});

void test('operator overview documents the active runtime order and paper readiness fence', async () => {
  const overview = await readArtifact('docs/system-overview.html');
  const runtimeStart = overview.indexOf('<section id="runtime"');
  const runtimeEnd = overview.indexOf('</section>', runtimeStart);
  assert.notEqual(runtimeStart, -1, 'missing runtime section');
  assert.notEqual(runtimeEnd, -1, 'runtime section must be bounded');
  const runtime = overview.slice(runtimeStart, runtimeEnd);

  assert.match(
    runtime,
    /supervisor[\s\S]*inbox worker[\s\S]*finality reconciler[\s\S]*paper worker[\s\S]*social worker[\s\S]*heartbeat/iu,
  );
  for (const statement of [
    'beginOwner',
    'double ACK',
    'frontière stricte',
    'avant la promotion',
    'DEGRADED_RETRY',
    'supervisor RUNNING',
    'selected provider',
    'finality RUNNING',
    'same promotion epoch',
    'SOLANA_EXPECTED_GENESIS_HASH',
    'LISTENER_ENABLED=true',
    'ne l’écrit jamais dans les logs',
  ]) assert.ok(runtime.includes(statement), `missing active runtime statement: ${statement}`);
  assert.doesNotMatch(runtime, /Health RPC|Baseline HTTP|Souscriptions WebSocket|Catch-up de fermeture de fenêtre/iu);
  assert.doesNotMatch(runtime, /Paper exige une première passe finalité réussie[^.]*worker paper ne démarre pas[^.]*aucun retry initial/iu);
});

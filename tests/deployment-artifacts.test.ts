import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  assert.match(app, /^ {6}SOLANA_HTTP_RPC_URL: \$\{SOLANA_HTTP_RPC_URL:\?SOLANA_HTTP_RPC_URL is required\}$/m);
  assert.match(app, /^ {6}SOLANA_WS_RPC_URL: \$\{SOLANA_WS_RPC_URL:\?SOLANA_WS_RPC_URL is required\}$/m);
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
    'SOLANA_WS_RPC_URL=wss://rpc-provider.invalid',
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
  assert.match(smoke, /GLOBAL_TIMEOUT_MS\s*=\s*180_000/);
  assert.match(smoke, /REQUEST_TIMEOUT_MS\s*=\s*10_000/);
  assert.match(smoke, /postgresPassword\s*=\s*randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(smoke, /POSTGRES_PASSWORD:\s*postgresPassword/);
  assert.match(smoke, /POSTGRES_PASSWORD_URI_ENCODED:\s*encodeURIComponent\(postgresPassword\)/);
  assert.match(smoke, /SOLANA_HTTP_RPC_URL:\s*'https:\/\/rpc\.invalid'/);
  assert.match(smoke, /SOLANA_WS_RPC_URL:\s*'wss:\/\/rpc\.invalid'/);
  assert.match(smoke, /LISTENER_ENABLED:\s*'false'/);
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
  assert.match(smoke, /'listenerCatchUpGaps'/);
  assert.doesNotMatch(smoke, /Migration history does not contain exactly 14 rows\./);
  assert.doesNotMatch(smoke, /--privileged|network_mode|host networking|docker system prune|private[_ -]?key|\bwallet\b/iu);
  assert.doesNotMatch(smoke, /sol-token-listener-(?:backend|frontend):(?:smoke|latest)/u);

  assert.equal(packageJson.scripts?.['deployment:smoke'], 'node scripts/deployment-smoke.mjs');
  assert.match(ci, /^ {2}deployment-contract:\s*$/m);
  assert.match(ci, /deployment-contract:[\s\S]*?timeout-minutes: 15/);
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
  assert.ok(rollbackStopIndex < rollback.indexOf('pull app retention frontend'));
  assert.ok(rollbackStopIndex < rollback.indexOf('up -d --no-build --no-deps app retention'));
  assert.match(rollback, /BACKEND_IMAGE[\s\S]*FRONTEND_IMAGE/);
  assert.match(rollback, /pull app retention frontend/);
  assert.match(rollback, /up -d --no-build --no-deps app retention/);
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

void test('operator documentation links the deployment runbook and smoke command', async () => {
  const readme = await readArtifact('README.md');
  const overview = await readArtifact('docs/system-overview.html');

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
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseRoleConfig } from '../src/deploy/role-environment.js';
import { DATABASE_LOGINS, ROLES, STACK_USERS } from '../src/deploy/stack.js';

const root = new URL('../', import.meta.url);
void test('front readiness probes the local Caddy admin endpoint, never the protected site', async () => {
  const front = composeService(await readArtifact('deploy/compose.yaml'), 'front');
  for (const line of [
    '    healthcheck:',
    '      test: ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]',
    '      interval: 5s', '      timeout: 3s', '      retries: 30', '      start_period: 10s',
  ]) assert.ok(front.includes(line), `Missing front readiness line: ${line}`);
});

const nodeImage =
  'node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
const caddyImage =
  'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
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
    [caddyImage, 'frontend'],
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

void test('backend image ships compiled artifacts, supervisor and one Unix user per process', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const backend = stage(dockerfile, 'backend');
  const copies = backend.match(/^COPY\s+.+$/gm) ?? [];

  assert.deepEqual(copies, [
    'COPY --from=production-dependencies /app/node_modules ./node_modules',
    'COPY --from=build /app/dist ./dist',
    'COPY package.json package-lock.json ./',
    'COPY --from=build /app/scripts/provision-executor-roles.sql ./dist/scripts/provision-executor-roles.sql',
    'COPY --chmod=0755 deploy/back/bin/ /usr/local/bin/',
    'COPY deploy/back/supervisor/supervisord.conf /etc/sol/supervisord.conf',
    'COPY deploy/back/supervisor/programs/ /etc/sol/programs/',
  ]);
  assert.doesNotMatch(backend, /\btests?\/|fixtures?|\.env\b|\.git\b|\.worktrees|npm-cache|secret|keypair|wallet/iu);
  assert.match(backend, /^ENV\s+NODE_ENV=production$/m);
  assert.match(backend, /apt-get install --yes --no-install-recommends supervisor/u);
  for (const [user, uid] of Object.entries(STACK_USERS)) {
    assert.ok(backend.includes(`${user}:${uid}`), `missing Unix user ${user}`);
  }
  assert.match(backend, /install -d -o ops -g ops -m 0700 \/var\/lib\/sol\/evidence/u);
  // The build writes the qualification profiles 0600: without this the listener user cannot start.
  assert.match(backend, /^RUN chmod -R a\+rX \/app\/dist$/mu);
  assert.doesNotMatch(backend, /^USER\s+/mu, 'the entrypoint needs root; each program drops to its user');
  assert.match(backend, /^EXPOSE\s+3000 3100$/m);
  assert.match(backend, /^CMD\s+\["sol-entrypoint"\]$/m);
});

void test('front image serves only the built console through the reviewed Caddyfile, as a non-root user', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const frontend = stage(dockerfile, 'frontend');
  const copies = frontend.match(/^COPY\s+.+$/gm) ?? [];

  assert.deepEqual(copies, [
    'COPY --from=build /app/frontend/dist /srv',
    'COPY deploy/front/Caddyfile /etc/caddy/Caddyfile',
    'COPY --chmod=0755 deploy/front/front-entrypoint /usr/local/bin/front-entrypoint',
  ]);
  assert.match(frontend, /addgroup -S -g 10100 caddy/u);
  assert.match(frontend, /adduser -S -D -H -u 10100 -G caddy -s \/sbin\/nologin caddy/u);
  assert.match(frontend, /chown -R caddy:caddy \/data \/config/u);
  assert.match(frontend, /^EXPOSE\s+8080 80 443$/m);
  assert.match(frontend, /^CMD\s+\["front-entrypoint"\]$/m);
  assert.doesNotMatch(frontend, /(?:^|\/)src(?:\/|\s)|\btests?\b|fixtures?|\.env\b|\.git\b|\.worktrees/iu);
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

void test('Caddy relays only reads, authenticates every route but the operator API, streams SSE', async () => {
  const caddyfile = await readArtifact('deploy/front/Caddyfile');
  const route = caddyfile.slice(caddyfile.indexOf('route {'));
  let previous = -1;
  for (const marker of [
    '@write not method GET HEAD OPTIONS',
    'respond @write 405',
    'reverse_proxy /operator/v1/* back:3100 {',
    'header_up Host 0.0.0.0:3100',
    'basic_auth {',
    '{$FRONT_BASIC_AUTH_USER} {$FRONT_BASIC_AUTH_HASH}',
    'reverse_proxy /api/v1/events back:3000 {',
    'reverse_proxy @api back:3000 {',
    'try_files {path} /index.html',
    'file_server',
  ]) {
    const index = route.indexOf(marker);
    assert.ok(index > previous, `${marker} is missing or out of order`);
    previous = index;
  }
  assert.ok(caddyfile.includes('{$SITE_ADDRESS:http://:8080} {'));
  assert.ok(caddyfile.includes('admin localhost:2019'));
  assert.match(caddyfile, /@api path \/api\/v1 \/api\/v1\/\*/u);
  assert.match(caddyfile, /flush_interval -1/u);
  assert.match(caddyfile, /read_timeout 1h/u);
  assert.equal((caddyfile.match(/header_up -Authorization/gu) ?? []).length, 2);
  for (const header of [
    'Strict-Transport-Security "max-age=31536000"', 'X-Frame-Options "DENY"',
    'Referrer-Policy "no-referrer"', 'X-Content-Type-Options "nosniff"', '-Server',
  ]) {
    assert.ok(caddyfile.includes(header), `missing header ${header}`);
  }
  assert.ok(caddyfile.includes('header @immutable Cache-Control "public, max-age=31536000, immutable"'));
  assert.ok(caddyfile.includes('header @mutable Cache-Control "no-store"'));
  assert.doesNotMatch(caddyfile, /\$2[aby]\$|password/iu);
});

void test('the front entrypoint reads only the bcrypt hash and drops root before starting Caddy', async () => {
  const entrypoint = await readArtifact('deploy/front/front-entrypoint');
  assert.ok(entrypoint.startsWith('#!/bin/sh\n'));
  assert.match(entrypoint, /^set -eu$/mu);
  assert.ok(entrypoint.includes('hash_file=/root/secrets/front-basic-auth-hash'));
  assert.ok(entrypoint.includes("'$2a$'*|'$2b$'*|'$2y$'*) ;;"));
  assert.ok(entrypoint.includes(
    "exec su -s /bin/sh caddy -c 'exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'",
  ));
  const syntax = spawnSync('sh', ['-n'], { input: entrypoint, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

void test('Compose defines postgres, migrate, back and front, with no published database or backend port', async () => {
  const [compose, server] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/compose.server.yaml'),
  ]);

  assert.match(compose, /^name: sol-token-listener$/m);
  const networksOffset = compose.indexOf('\nnetworks:');
  assert.notEqual(networksOffset, -1, 'missing networks section');
  const serviceNames = [...compose.slice(compose.indexOf('\nservices:'), networksOffset)
    .matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  assert.deepEqual(serviceNames, ['postgres', 'migrate', 'back', 'front']);
  assert.match(compose, new RegExp(`^    image: ${postgresImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  for (const service of ['migrate', 'back']) {
    assert.match(composeService(compose, service), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m);
  }
  assert.match(composeService(compose, 'front'), /^ {4}image: \$\{FRONTEND_IMAGE:\?FRONTEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'back'), /^ {4}build:\s*$/m);
  assert.match(composeService(compose, 'front'), /^ {4}build:\s*$/m);
  assert.doesNotMatch(composeService(compose, 'migrate'), /^ {4}build:\s*$/m);

  assert.equal((compose.match(/^ {4}ports:/gm) ?? []).length, 1);
  assert.match(composeService(compose, 'front'), /^ {4}ports: \["127\.0\.0\.1:\$\{FRONT_PORT:-8080\}:8080"\]$/m);
  assert.match(server, /^ {4}ports: !override\n {6}- "80:80"\n {6}- "443:443"$/m);
  assert.match(server, /^ {6}SITE_ADDRESS: \$\{SITE_ADDRESS:\?SITE_ADDRESS is required on the server\}$/m);

  const postgres = composeService(compose, 'postgres');
  const migrate = composeService(compose, 'migrate');
  const back = composeService(compose, 'back');
  const front = composeService(compose, 'front');
  assert.match(postgres, /^ {6}POSTGRES_USER: sol_owner$/m);
  assert.match(postgres, /^ {6}POSTGRES_PASSWORD_FILE: \/root\/secrets\/postgres-admin-password$/m);
  for (const [service, mount] of [
    [postgres, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro'],
    [migrate, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db:/root/secrets/db:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/logins:/root/secrets/logins:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/back:/root/secrets/back:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/config:/etc/sol/config:ro'],
    [back, '      - evidence:/var/lib/sol/evidence'],
    [front, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro'],
  ] as const) {
    assert.ok(service.includes(mount), `missing mount ${mount}`);
  }
  assert.match(migrate, /^ {4}command: \["sol-admin", "migrate"\]$/m);
  assert.match(back, /^ {4}command: \["sol-entrypoint"\]$/m);
  assert.match(back, /^ {6}SOL_STACK_MODE: \$\{SOL_STACK_MODE:-observe\}$/m);
  assert.match(back, /^ {6}SOL_HEALTH_REQUIRE_OK: \$\{SOL_HEALTH_REQUIRE_OK:-true\}$/m);
  assert.match(back, /^ {4}tmpfs: \["\/run\/sol:mode=0711,size=16m"\]$/m);
  assert.match(back, /^ {4}init: true$/m);
  assert.match(back, /^ {4}stop_grace_period: 60s$/m);
  assert.match(back, /^ {6}test: \["CMD", "sol-health"\]$/m);

  assert.match(postgres, /^ {4}networks: \[internal\]$/m);
  assert.match(migrate, /^ {4}networks: \[internal\]$/m);
  assert.match(back, /^ {4}networks: \[internal, egress, edge\]$/m);
  assert.match(front, /^ {4}networks: \[edge\]$/m);
  assert.match(compose, /^networks:\n {2}internal:\n {4}internal: true\n {2}egress:\n {2}edge:$/m);
  assert.match(compose, /^volumes:\n {2}postgres-data:\n {2}evidence:\n {2}caddy-data:$/m);
  assert.match(migrate, /depends_on:\n {6}postgres:\n {8}condition: service_healthy/);
  assert.match(back, /depends_on:\n {6}migrate:\n {8}condition: service_completed_successfully/);
  assert.match(front, /depends_on:\n {6}back:\n {8}condition: service_healthy/);
  assert.match(compose, /^x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "20m"\n {4}max-file: "5"$/m);
  assert.equal((compose.match(/^ {4}logging: \*logging$/gm) ?? []).length, 4);

  assert.doesNotMatch(compose, /DATABASE_URL|SOLANA_|LISTENER_|EXECUTOR_|POSTGRES_PASSWORD:|privileged:|network_mode: host|docker\.sock/u);
  assert.doesNotMatch(compose, /api-key|keypair|wallet/iu);
  for (const imageLine of compose.match(/^ {4}image: .+$/gm) ?? []) {
    assert.match(imageLine, /(?:@sha256:[0-9a-f]{64}|\$\{(?:BACKEND|FRONTEND)_IMAGE:\?)/u);
  }
});

void test('the listener template keeps the catch-up, block hydration and ingestion scope defaults', async () => {
  const [compose, listener, localEnvironment] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/config/listener.env.example'),
    readArtifact('.env.example'),
  ]);
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
    assert.equal((listener.match(new RegExp(`^${name}=${fallback}$`, 'gmu')) ?? []).length, 1, name);
  }
  assert.match(listener, /^LISTENER_INGESTION_SCOPE=launchpad-and-market$/mu);
  assert.match(listener, /^EXECUTION_MODE=observe$/mu);
  assert.match(listener, /^API_HOST=0\.0\.0\.0$/mu);
  assert.match(listener, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.match(localEnvironment, /^LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false$/mu);
  assert.match(localEnvironment, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.doesNotMatch(compose, /LISTENER_/u);
  assert.doesNotMatch(listener, /PRIVATE_KEY|SECRET_KEY|WALLET/iu);
});

void test('deployment keeps executable bounded admission disabled until the follow-up delivery gates', async () => {
  const [compose, environment, localEnvironment, overview, readme] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/config/listener.env.example'),
    readArtifact('.env.example'),
    readArtifact('docs/system-overview.html'),
    readArtifact('README.md'),
  ]);
  const settings = Object.freeze([
    ['LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED', 'false'],
    ['LISTENER_PUMPFUN_TRACKING_WINDOW_SECONDS', '45'],
  ] as const);

  for (const [name, fallback] of settings) {
    const assignment = new RegExp(`^${name}=${fallback}$`, 'gmu');
    assert.equal((environment.match(assignment) ?? []).length, 1);
    assert.equal((localEnvironment.match(assignment) ?? []).length, 1);
  }

  assert.doesNotMatch(compose, /LISTENER_/u);

  for (const example of [environment, localEnvironment]) {
    assert.match(example, /restart-only/iu);
    assert.match(example, /classifier/iu);
    assert.match(example, /until #177 is merged AND post-merge CI is green/u);
    assert.doesNotMatch(example, /^LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=true$/mu);
    assert.doesNotMatch(example, /Part A cannot activate|true is rejected fail-closed until #171-B/u);
  }

  assert.match(overview, /migration 053[^.]{0,200}worker_admitted_at/iu);
  assert.match(overview, /worker_admitted_at[^.]{0,240}monotone[^.]{0,160}(?:never cleared|jamais effacé)/iu);
  for (const document of [readme, overview]) {
    assert.match(document, /#176/u);
    assert.match(document, /restart-only/iu);
    assert.match(document, /OFF[^.]{0,240}sélection[^.]{0,80}ordre[^.]{0,80}équité[^.]{0,80}SQL legacy de lease[^.]{0,80}inchangés/iu);
    assert.match(document, /OFF[^.]{0,200}CREATE[^.]{0,140}ambigu[^.]{0,200}SolanaProgramSubscriber[^.]{0,120}null/iu);
    assert.match(document, /ON uniquement[^.]{0,200}strict-admission[^.]{0,120}deux chemins/iu);
    assert.match(document, /ON → OFF[^.]{0,240}PENDING[^.]{0,80}null[^.]{0,240}worker_admitted_at[^.]{0,80}monotone/iu);
    assert.match(document, /seule ligne sélectionnée et verrouillée[^.]{0,100}avant[^.]{0,80}lease/iu);
    assert.match(document, /sans backfill global[^.]{0,120}blocage/iu);
    assert.match(document, /distinct[^.]{0,120}rollback[^.]{0,80}ancien binaire/iu);
    assert.match(document, /ON[^.]{0,240}worker_admitted_at IS NOT NULL/u);
    assert.match(document, /terminal_at[^.]{0,100}(?:4 hours|quatre heures)/iu);
    assert.match(document, /until #177 is merged AND post-merge CI is green/u);
    for (const dependency of [
      'LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true', 'EXECUTION_MODE=observe',
      'LISTENER_INGESTION_SCOPE=launchpad-only', 'LISTENER_CATCH_UP_POLICY=live-edge',
      'LISTENER_BLOCK_HYDRATION_ENABLED=true', 'SOLANA_EXPECTED_GENESIS_HASH',
    ]) assert.ok(document.includes(dependency), `missing classifier dependency: ${dependency}`);
    assert.match(document, /PENDING[^.]{0,80}NORMAL[^.]{0,80}null/iu);
    assert.match(document, /first_detected_at/u);
    assert.match(document, /workerAdmission\.v1/u);
    assert.doesNotMatch(document, /Part A ne peut pas activer/u);
  }
  assert.match(
    overview,
    /drain[^.]{0,200}migrations[^.]{0,120}057[^.]{0,200}deploy[^.]{0,200}restart/iu,
  );
  for (const document of [readme, overview]) {
    assert.match(document, /migration 057[^.]{0,120}tête courante/iu);
  }
  assert.match(readme, /appliquer toutes les migrations\s+jusqu'à 057/iu);
  assert.doesNotMatch(readme, /jusqu'à 056/iu);
  assert.match(overview, /old binary[^.]{0,200}schema 053[^.]{0,160}not supported/iu);
  assert.match(overview, /no change[^.]{0,240}wallet[^.]{0,120}executor[^.]{0,120}RPC[^.]{0,120}cache/iu);
  assert.doesNotMatch(overview, /45-second policy[^.]{0,120}(?:active|enabled)/iu);
});

void test('bounded worker admission canary remains post-merge, observe-only and fail-closed', async () => {
  const [compose, environment, localEnvironment, runbook, readme, architecture, overview] =
    await Promise.all([
      readArtifact('deploy/compose.yaml'),
      readArtifact('deploy/config/listener.env.example'),
      readArtifact('.env.example'),
      readArtifact('docs/operations/block-hydration-canary.md'),
      readArtifact('README.md'),
      readArtifact('docs/architecture/pumpfun-v1.md'),
      readArtifact('docs/system-overview.html'),
    ]);

  assert.doesNotMatch(compose, /LISTENER_/u);
  for (const example of [environment, localEnvironment]) {
    assert.match(example, /^LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false$/mu);
    assert.doesNotMatch(example, /^LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=true$/mu);
  }

  assert.match(runbook, /#177[^.]{0,180}(?:merged|fusionnée)[^.]{0,180}(?:post-merge CI|CI post-merge)[^.]{0,80}(?:green|verte)/iu);
  for (const checkpoint of ['T0', 'T+5', 'T+15', 'FINAL_PRESTOP', 'STOPPED']) {
    assert.ok(runbook.includes(checkpoint), `missing canary checkpoint ${checkpoint}`);
  }
  assert.match(runbook, /44[ ,.\u202f]?999[^.]{0,100}PASS/iu);
  assert.match(runbook, /45[ ,.\u202f]?000[^.]{0,100}FAIL/iu);
  assert.match(runbook, /T\+5[^.]{0,240}(?:non-growing|non croissant)[^.]{0,160}(?:classification|classement)[^.]{0,160}(?:backlog|claimable)/iu);
  assert.match(runbook, /claimableBacklogCount[^.]{0,180}(?:<=|inférieur ou égal)[^.]{0,120}backlogCount/iu);
  assert.match(runbook, /postStopWorkerAdmissionClaimableCount/iu);
  assert.match(runbook, /postStopActionableCount[^.]{0,200}shutdown[^.]{0,120}legacy/iu);
  assert.match(runbook, /SQL[^.]{0,180}post-stop[^.]{0,220}postStopWorkerAdmissionClaimableCount/iu);
  assert.match(runbook, /rollback[^.]{0,180}LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false/iu);
  for (const gate of [
    'workerAdmission', 'catchUpAdmission', 'firstProcessing', 'http429', 'finality',
    'idempotence', 'retention', 'rss', 'shutdown',
  ]) assert.ok(runbook.includes(gate), `missing independent gate ${gate}`);
  for (const forbiddenAuthority of ['wallet', 'signer', 'executor', 'submission', 'trade']) {
    assert.match(runbook, new RegExp(`(?:aucun|no)[^.]{0,160}${forbiddenAuthority}`, 'iu'));
  }

  for (const document of [readme, architecture, overview]) {
    assert.match(document, /#177/u);
    assert.match(document, /migration 056/iu);
    assert.match(document, /MANUAL_REVIEW/u);
    assert.match(document, /cinq preuves|five (?:authority )?proofs/iu);
    assert.match(document, /démotion bornée|bounded demotion/iu);
    assert.match(document, /workerAdmission\.v1/u);
    assert.match(document, /first-processing/iu);
  }
  assert.match(overview, /#177[^<]{0,160}(?:livré|delivered)[^<]{0,100}(?:désactivé|disabled)/iu);
  assert.match(overview, /class="(?:card|alert)[^"]*"/u);
});

void test('versioned admission design and plan restrict strict ingress parity to ON', async () => {
  const [spec, plan] = await Promise.all([
    readArtifact('docs/superpowers/specs/2026-09-26-pumpfun-worker-admission-classification-design.md'),
    readArtifact('docs/superpowers/plans/2026-09-26-pumpfun-worker-admission-classification.md'),
  ]);
  assert.match(spec, /Contract revision: 1\.0\.1/u);
  assert.match(plan, /Plan revision:\*\* 1\.0\.1/u);
  for (const document of [spec, plan]) {
    assert.match(document, /OFF-equivalence/u);
    assert.match(document, /ON-only strict parity/u);
    assert.match(document, /legacy CREATE precedence/u);
    assert.match(document, /direct subscriber[^.]{0,120}null hints/iu);
    assert.match(document, /workerAdmissionPolicy\.enabled/u);
  }
});

void test('Compose resolves the stack: only mode inputs reach the containers, secrets stay read-only files', (context) => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 });
  if (docker.error !== undefined || docker.status !== 0) {
    context.skip('Docker Compose unavailable: resolved configuration contract skipped');
    return;
  }
  interface ResolvedService {
    readonly environment?: Readonly<Record<string, string>>;
    readonly ports?: readonly Readonly<{ host_ip?: string; published?: string | number; target?: number }>[];
    readonly volumes?: readonly Readonly<{ type?: string; source?: string; target?: string; read_only?: boolean }>[];
  }
  const resolvedConfig = (
    files: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, ResolvedService>> => {
    const result = spawnSync('docker', [
      'compose', '--env-file', 'deploy/env.example', ...files.flatMap((file) => ['-f', file]),
      'config', '--format', 'json',
    ], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    return (JSON.parse(result.stdout) as { readonly services: Readonly<Record<string, ResolvedService>> }).services;
  };
  const ports = (service: ResolvedService | undefined): string[] => (service?.ports ?? [])
    .map((port) => `${port.host_ip ?? ''}:${String(port.published)}:${String(port.target)}`);
  const binds = (service: ResolvedService | undefined): string[] => (service?.volumes ?? [])
    .filter((volume) => volume.type === 'bind')
    .map((volume) => `${volume.source ?? ''}:${volume.target ?? ''}:${volume.read_only === true ? 'ro' : 'rw'}`);

  const services = resolvedConfig(['deploy/compose.yaml']);
  assert.deepEqual(Object.keys(services).sort(), ['back', 'front', 'migrate', 'postgres']);
  assert.deepEqual(services.back?.environment, {
    POSTGRES_DB: 'sol_token_listener', SOL_HEALTH_REQUIRE_OK: 'true', SOL_STACK_MODE: 'observe',
  });
  assert.deepEqual(services.migrate?.environment, { POSTGRES_DB: 'sol_token_listener' });
  assert.deepEqual(services.front?.environment, { FRONT_BASIC_AUTH_USER: 'operator', SITE_ADDRESS: 'http://:8080' });
  assert.deepEqual(ports(services.front), ['127.0.0.1:8080:8080']);
  for (const name of ['postgres', 'migrate', 'back']) assert.deepEqual(ports(services[name]), [], name);
  assert.deepEqual(binds(services.postgres), [
    '/srv/sol-token-listener/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro',
  ]);
  assert.deepEqual(binds(services.migrate), ['/srv/sol-token-listener/secrets/db:/root/secrets/db:ro']);
  assert.deepEqual(binds(services.back), [
    '/srv/sol-token-listener/secrets/db/logins:/root/secrets/logins:ro',
    '/srv/sol-token-listener/secrets/back:/root/secrets/back:ro',
    '/srv/sol-token-listener/config:/etc/sol/config:ro',
  ]);
  assert.deepEqual(binds(services.front), [
    '/srv/sol-token-listener/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro',
  ]);

  const server = resolvedConfig(['deploy/compose.yaml', 'deploy/compose.server.yaml'], {
    SITE_ADDRESS: 'bot.example.invalid',
  });
  assert.deepEqual(ports(server.front), [':80:80', ':443:443']);
  assert.equal(server.front?.environment?.SITE_ADDRESS, 'bot.example.invalid');
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

  assert.match(runbook, /Version : 1\.7\.0/u);
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

  assert.match(runbook, /Version : 1\.7\.0/u);
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

  assert.match(runbook, /Version : 1\.7\.0/u);
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

void test('versioned canary verdict documents provider-affine and durable shutdown semantics', async () => {
  const [runbook, overview, cli] = await Promise.all([
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('docs/system-overview.html'),
    readArtifact('scripts/evaluate-mainnet-observe-canary.ts'),
  ]);

  assert.match(runbook,
    /scanActive=true[^.]{0,240}workerClaimReady=true[^.]{0,240}valide[^.]{0,160}même provider/iu);
  assert.match(runbook,
    /epochInvalidations[^.]{0,240}diagnostique[^.]{0,160}monotone[^.]{0,240}pas[^.]{0,160}mélange provider/iu);
  assert.match(runbook,
    /finality[^.]{0,240}degraded[^.]{0,240}recovered[^.]{0,240}appariés[^.]{0,160}structure/iu);
  assert.match(runbook, /backlog durable[^.]{0,240}peut rester[^.]{0,160}shutdown/iu);
  assert.match(runbook,
    /leases[^.]{0,180}scan[^.]{0,180}queued[^.]{0,120}in-flight[^.]{0,180}cache[^.]{0,160}zéro/iu);
  assert.match(runbook,
    /compte SQL[^.]{0,180}post-stop[^.]{0,240}deux partitions[^.]{0,160}backlog/iu);
  assert.match(runbook,
    /npm run canary:evaluate -- \/absolute\/path\/to\/redacted-canary-input\.v1\.json/u);
  assert.match(runbook, /FAIL[^.]{0,160}INCONCLUSIVE[^.]{0,240}bloquent[^.]{0,160}wallet/iu);
  assert.match(runbook, /Version : 1\.7\.0/u);
  assert.match(runbook,
    /terminalEvidence[^.]{0,300}failed[^.]{0,120}quarantined[^.]{0,120}exhausted[^.]{0,300}baseline[^.]{0,120}final/iu);
  assert.match(runbook,
    /groupes[^.]{0,240}FAILED[^.]{0,160}QUARANTINED[^.]{0,240}taxonomies[^.]{0,160}fermées/iu);
  assert.match(runbook,
    /même processus[^.]{0,240}sampledAtMs[^.]{0,240}strictement croissant[^.]{0,240}STOPPED[^.]{0,240}T\+15[^.]{0,160}rétention/iu);
  assert.match(runbook,
    /http429Responses[^.]{0,80}attempts[^.]{0,240}provider non\s+configuré[^.]{0,240}0\/0[^.]{0,240}delta HTTP 429[^.]{0,240}prioritaire/iu);
  assert.match(runbook,
    /compteurs cumulatifs[^.]{0,240}blockHydration[^.]{0,240}chaque\s+snapshot[^.]{0,160}STOPPED[^.]{0,240}INCONCLUSIVE/iu);
  assert.match(runbook,
    /pause périodique authentifiée[^.]{0,240}INCONCLUSIVE[^.]{0,240}dégradation générique[^.]{0,160}FAIL/iu);
  assert.match(runbook,
    /recoveryStatus=NOT_REQUIRED[^.]{0,200}recoveryReasonCode=null[^.]{0,240}si et seulement\s+si/iu);
  assert.match(runbook,
    /incident finality[^.]{0,240}rétabli pendant[^.]{0,240}PASS[^.]{0,240}RUNNING/iu);
  assert.match(runbook, /rssBytes[^.]{0,240}T\+5[^.]{0,240}25 ?%[^.]{0,240}128 MiB/iu);
  assert.match(runbook, /retainedEntries[^.]{0,160}64[^.]{0,240}retainedBytes[^.]{0,160}67.?108.?864/iu);
  assert.match(runbook, /primary[^.]{0,120}fallback-1[^.]{0,120}fallback-2[^.]{0,120}fallback-3/iu);
  assert.match(runbook, /diagnostics finality[^.]{0,240}1024[^.]{0,240}heartbeat STOPPED/iu);
  assert.match(runbook, /groupes terminaux[^.]{0,240}128/iu);
  assert.match(runbook, /stoppedAt[\s\S]{0,240}observedAtMs[^.]{0,240}strictement postérieur/iu);

  assert.doesNotMatch(cli, /\blstat\b/u);
  assert.match(cli, /O_RDONLY[\s\S]{0,160}O_NOFOLLOW[\s\S]{0,160}O_NONBLOCK/u);
  assert.match(cli, /stat\(\{ bigint: true \}\)[\s\S]{0,1600}stat\(\{ bigint: true \}\)/u);
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    assert.match(cli, new RegExp(`before\\.${field} === after\\.${field}`, 'u'));
  }

  assert.match(overview,
    /href="superpowers\/specs\/2026-09-25-mainnet-observe-canary-verdict-design\.md"/u);
  assert.match(overview,
    /npm run canary:evaluate -- \/absolute\/path\/to\/redacted-canary-input\.v1\.json \/absolute\/path\/to\/mainnet-terminal-attribution\.v1\.json/u);
});

void test('terminal attribution runbook captures before teardown and keeps provenance local', async () => {
  const [runbook, evaluator] = await Promise.all([
    readArtifact('docs/operations/block-hydration-canary.md'),
    readArtifact('scripts/evaluate-mainnet-observe-canary.ts'),
  ]);

  assert.match(runbook, /Version : 1\.7\.0/u);
  assert.match(runbook,
    /arrêter[\s\S]{0,200}listener[\s\S]{0,240}PostgreSQL[\s\S]{0,160}actif[\s\S]{0,240}captur/iu);
  assert.match(runbook,
    /canary:capture-terminal-attribution[^\n]*mainnet-terminal-attribution\.v1\.json/u);
  assert.match(runbook,
    /canary:evaluate --[^\n]*redacted-canary-input\.v1\.json[^\n]*mainnet-terminal-attribution\.v1\.json/u);
  assert.match(runbook,
    /capture[\s\S]{0,240}évalu[\s\S]{0,240}copi[\s\S]{0,240}teardown/iu);
  assert.match(runbook, /0600[\s\S]{0,240}owner-only/iu);
  assert.match(runbook,
    /manquant[\s\S]{0,180}malformé[\s\S]{0,180}non réconcilié[\s\S]{0,180}overflow/iu);
  assert.match(runbook,
    /PUMP_BORSH_INVALID[\s\S]{0,240}quarantaine catch-up[\s\S]{0,240}PUMP_DECODER[\s\S]{0,240}(?:FAIL|PASS)/iu);
  assert.match(runbook,
    /n'autorise[\s\S]{0,180}ni[\s\S]{0,160}décodeur[\s\S]{0,180}retry[\s\S]{0,180}transaction/iu);
  assert.doesNotMatch(runbook,
    /mainnet-terminal-attribution\.v1\.json[^\n]{0,240}(?:cat|jq|tee)/u);
  assert.match(evaluator, /args\.length !== 2/u);
  assert.match(evaluator,
    /evaluateMainnetObserveCanary\(parsed, parsedTerminalAttribution\)/u);
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

void test('Compose never carries a database password or URL: the containers read secret files', async () => {
  const compose = await readArtifact('deploy/compose.yaml');
  assert.match(composeService(compose, 'postgres'), /^ {6}POSTGRES_PASSWORD_FILE: \/root\/secrets\/postgres-admin-password$/m);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:|POSTGRES_PASSWORD_URI_ENCODED|DATABASE_URL|postgresql:\/\//u);
});

void test('the compose input template holds no secret and documents every input', async () => {
  const environment = await readArtifact('deploy/env.example');
  const lines = environment.split('\n');
  for (const value of [
    'SOL_HOST_DIR=/srv/sol-token-listener',
    'SOL_STACK_MODE=observe',
    'SOL_HEALTH_REQUIRE_OK=true',
    'POSTGRES_DB=sol_token_listener',
    `BACKEND_IMAGE=registry.invalid/sol-token-listener/backend@sha256:${'0'.repeat(64)}`,
    `FRONTEND_IMAGE=registry.invalid/sol-token-listener/frontend@sha256:${'1'.repeat(64)}`,
    'FRONT_PORT=8080',
    'FRONT_BASIC_AUTH_USER=operator',
    'SITE_ADDRESS=',
  ]) {
    assert.ok(lines.includes(value), `missing compose input: ${value}`);
  }
  assert.match(environment, /outside version control/iu);
  assert.match(environment, /holds no secret/iu);
  assert.doesNotMatch(environment, /PASSWORD|PRIVATE_KEY|SECRET_KEY|WALLET|api-key|SOLANA_/iu);
  for (const name of ['BACKEND_IMAGE', 'FRONTEND_IMAGE']) {
    assert.match(environment, new RegExp(`^${name}=registry\\.invalid/[^\\s@]+@sha256:[0-9a-f]{64}$`, 'm'));
  }
});

void test('every role has a configuration template, and no template carries a secret', async () => {
  const files = [...new Set(Object.values(ROLES).map((role) => role.configFile))].sort();
  assert.deepEqual(files, [
    'listener.env', 'live-recovery.env', 'live.env', 'operations.env', 'operator-api.env',
    'preflight-bundle.env', 'provider-evidence.env', 'readiness.env', 'retention.env', 'worker-sim.env',
  ]);
  assert.deepEqual((await readdir(new URL('deploy/config/', root))).sort(), files.map((file) => `${file}.example`));
  for (const file of files) {
    const text = await readArtifact(`deploy/config/${file}.example`);
    assert.doesNotThrow(() => parseRoleConfig(text, file), file);
    assert.doesNotMatch(text, /api-key|postgresql:\/\//iu, file);
  }
  const operatorApi = parseRoleConfig(await readArtifact('deploy/config/operator-api.env.example'), 'operator-api.env');
  assert.equal(operatorApi.OPERATOR_API_HOST, '0.0.0.0');
  assert.equal(operatorApi.OPERATOR_API_PORT, '3100');
  const operations = parseRoleConfig(await readArtifact('deploy/config/operations.env.example'), 'operations.env');
  assert.equal(operations.SOLANA_HTTP_RPC_URL, undefined);
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
  assert.match(smoke, /frontPassword\s*=\s*randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(smoke, /operatorApiToken\s*=\s*randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(smoke, /SOL_HOST_DIR:\s*hostDirectory/);
  assert.match(smoke, /SOL_STACK_MODE:\s*'observe'/);
  assert.match(smoke, /SOL_HEALTH_REQUIRE_OK:\s*'false'/);
  assert.match(smoke, /\['secrets\/back\/helius-listener-http-url', 'https:\/\/rpc\.invalid\\n'\]/);
  assert.match(smoke, /\['secrets\/back\/helius-listener-ws-url', 'wss:\/\/rpc\.invalid\\n'\]/);
  assert.match(smoke, /const override = name === 'listener' \? 'LISTENER_ENABLED=false\\n' : '';/);
  assert.doesNotMatch(smoke, /SOLANA_EXPECTED_GENESIS_HASH/);
  assert.match(smoke, /BACKEND_IMAGE:\s*deploymentImages\.backend/);
  assert.match(smoke, /FRONTEND_IMAGE:\s*deploymentImages\.frontend/);
  assert.doesNotMatch(smoke, /compose\.smoke\.yaml|smokeComposeFile/);
  assert.match(smoke, /return \['compose', \.\.\.projectArgs, '-f', composeFile, \.\.\.args\];/);
  assert.match(smoke, /await compose\(\['build', 'back', 'front'\]\)/);
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
  assert.match(smoke, /'listenerCatchUpGaps'/);
  assert.match(smoke, /'listenerStrictCatchUpFailures'/);
  assert.match(smoke, /'listenerStrictCatchUpRuns'/);
  assert.match(smoke, /'046_listener_strict_catch_up_runs\.sql'/);
  assert.match(smoke, /'executionIntentTransitions'/);
  assert.match(smoke, /'executionAttempts'/);
  assert.match(smoke, /'executionIntents'/);
  assert.doesNotMatch(smoke, /Migration history does not contain exactly 14 rows\./);
  assert.doesNotMatch(smoke, /--privileged|network_mode|host networking|docker system prune|private[_ -]?key/iu);
  // The only keypair is random bytes that prove the tmpfs isolation; it never holds funds.
  assert.match(smoke, /const throwawayKeypair = JSON\.stringify\(\[\.\.\.randomBytes\(64\)\]\);/u);
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
    /const \{ stdout, stderr \} = await compose\(\[\s*'exec', '-T', 'back', 'sol-run', 'retention'/,
  );
  assert.match(retention, /if \(stderr !== ''\) throw new Error\('Retention emitted unexpected stderr\.'\)/);
  assert.match(retention, /reflectFailureOutput: false/);
  assert.match(retention, /MAX_RETENTION_OUTPUT_BYTES/);
  assert.match(retention, /JSON\.parse\(serialized\)/);
  assert.match(retention, /canonicalRetentionCounters/);
  assert.match(
    smoke,
    /'transactionInboxDecoderRecoveries',\n {2}'transactionInboxIncompleteAttributions',\n {2}'transactionInboxRecoveries',\n {2}'transactionInboxTerminalAttributions',/u,
    'deployment smoke must expect every terminal attribution retention counter',
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
  assert.match(smoke, /'exec', '-T', 'back', 'node', '-e', 'setInterval\(\(\) => undefined, 1_000\)'/);
  assert.match(smoke, /if \(exitCode === 0\) process\.stdout\.write\('Deployment smoke passed\.\\n'\)/);
  assert.equal(packageJson.scripts?.['deployment:smoke:signal'], 'node scripts/deployment-smoke.mjs --signal-fault-probe');
  assert.match(ci, /deployment-contract:[\s\S]*?- run: npm run deployment:smoke:signal/);
});

void test('deployment smoke discovers Docker allocated loopback port after startup', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /FRONT_PORT:\s*'0'/);
  assert.match(smoke, /\['port', 'front', '8080'\]/);
  assert.match(smoke, /\^127\\\.0\\\.0\\\.1:\(\[1-9\]\[0-9\]\{0,4\}\)\\n\$/);
  assert.doesNotMatch(smoke, /reserveLoopbackPort|createServer/);
});

void test('failed signal fault probes always clean only their explicit child project', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');

  assert.match(smoke, /finally\s*{\s*cleanupDeadlineAt = Date\.now\(\) \+ CLEANUP_TIMEOUT_MS;/);
  assert.match(smoke, /await cleanupFaultProject\(faultName, cleanupFailures\)/);
  assert.match(smoke, /await rm\(hostDirectoryFor\(faultName\), \{ recursive: true, force: true \}\)/);
  assert.match(
    smoke,
    /composeCommand\(\['down', '--volumes', '--remove-orphans', '--rmi', 'local'\], faultName\)/,
  );
  assert.match(smoke, /COMPOSE_PROJECT_NAME:\s*faultName/);
  assert.match(smoke, /--signal-fault-probe-kill/);
  assert.match(smoke, /--self-sigkill/);
  assert.match(smoke, /new AggregateError\(\[primaryFailure, \.\.\.cleanupFailures\]/);
});

void test('deployment smoke proves users, secret isolation, front authentication, logins and closed operations', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');
  for (const phase of ['HOST_SETUP', 'PROCESS_USERS', 'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'LOGINS', 'OPERATIONS']) {
    assert.ok(smoke.includes(`await smokePhase('${phase}'`), `missing smoke phase ${phase}`);
  }
  for (const statement of [
    "assertEqual(stdout, 'listener 10001\\nopapi 10005\\nretention 10006\\n'",
    "assertEqual(stdout.trim(), '10100'",
    "assertEqual(stdout, 'h2b 400\\nopapi 400\\n'",
    "'setpriv', '--reuid=listener', '--regid=listener', '--clear-groups', 'cat', path",
    'assertEqual(anonymous.status, 401',
    'assertEqual(write.status, 405',
    'assertEqual(operator.status, 401',
    'assertEqual(authorized.status, 200',
    '`PGOPTIONS=-c role=${group}`',
    "assertEqual(counts.trim(), '0|0'",
  ]) {
    assert.ok(smoke.includes(statement), `missing smoke check: ${statement}`);
  }
  for (const [login, group] of Object.entries(DATABASE_LOGINS)) {
    assert.ok(smoke.includes(`  ${login}: '${group}',`), `smoke login table differs for ${login}`);
  }
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

void test('deployment runbook documents the full-bot lifecycle, takeover and security boundary', async () => {
  const runbook = await readArtifact('docs/operations/deployment.md');
  let previous = -1;
  for (const heading of [
    '## Topologie', '## Prérequis', '## Dossier hôte, secrets et configuration', '## Images',
    '## Démarrage et arrêt', '## Commandes sol', '## Trading', "## Qualification d'une enveloppe (gate 10)",
    '## Santé et journaux', '## Sauvegardes', '## Reprise de la base actuelle', '## Retour arrière',
    '## Bascule vers le serveur', '## Rotation des secrets', '## Frontière de sécurité',
  ]) {
    const index = runbook.indexOf(`\n${heading}\n`);
    assert.ok(index > previous, `missing or misplaced runbook section: ${heading}`);
    previous = index;
  }
  for (const command of [
    'deploy/host/init-secrets.sh "$SOL_HOST_DIR"',
    'docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml "$@"',
    'docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml -f deploy/compose.server.yaml "$@"',
    'sol_compose up --detach --wait --wait-timeout 180',
    'sol_compose stop --timeout 60',
    'sol_compose exec -it back sol trading start',
    'sol_compose exec back sol trading stop',
    'sol_compose exec back sol qualify start',
    'sol_compose exec back sol qualify stop',
    'sol_compose run --rm migrate sol-admin report',
    'sol_compose run --rm migrate sol-admin group-roles',
    'pg_restore --exit-on-error --single-transaction -U sol_owner',
    'deploy/sql/takeover-precondition.sql',
    'deploy/sql/table-row-counts.sql',
    'diff "$takeover/source.counts" "$takeover/target.counts"',
    'docker stop sol-token-listener-live-pg',
    'sudo systemctl enable --now sol-backup.timer',
    'launchctl bootstrap "gui/$(id -u)" "$plist"',
  ]) {
    assert.ok(runbook.includes(command), `missing runbook command: ${command}`);
  }
  const secrets = runbook.slice(runbook.indexOf('## Dossier hôte'), runbook.indexOf('## Images'));
  assert.doesNotMatch(secrets, /\b(?:cat|echo)\s+"?\$(?:back|SOL_HOST_DIR)/u, 'secrets are copied, never printed');
  assert.match(runbook, /pg_advisory_lock/u);
  assert.match(runbook, /Les migrations\s+restent forward-only/u);
  assert.match(runbook, /`down --volumes` est destructif/u);
  assert.match(runbook, /ENTRY_STOP/u);
  assert.match(runbook, /0\|0\|0\|0/u);
  assert.match(runbook, /réplica unique/u);
  assert.match(runbook, /sauvegarde externe/u);
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
  assert.match(readme, /HTTPS/u);
  assert.match(readme, /sauvegarde externe/i);
  assert.match(readme, /aucune promesse[^\n]*(?:première position|sellabilité|profit)/i);

  assert.match(overview, /href="operations\/deployment\.md"/);
  assert.match(overview, /npm run deployment:smoke/);
  assert.match(overview, /réplica unique|single replica/i);
  assert.match(overview, /HTTPS/u);
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
  assert.match(deployment, /sol_compose up --detach --wait --wait-timeout 180/u);
  assert.match(deployment, /Les migrations\s+restent forward-only/u);
  assert.match(deployment, /SOL_HEALTH_REQUIRE_OK=false/u);
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const nodeImage =
  'node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
const nginxImage =
  'nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49';

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

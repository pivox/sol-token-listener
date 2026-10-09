FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json

RUN npm ci --include-workspace-root --workspaces

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY config ./config
COPY frontend/index.html frontend/index.html
COPY frontend/tsconfig.json frontend/tsconfig.json
COPY frontend/tsconfig.app.json frontend/tsconfig.app.json
COPY frontend/tsconfig.node.json frontend/tsconfig.node.json
COPY frontend/vite.config.ts frontend/vite.config.ts
COPY frontend/vite-read-only-api-proxy.ts frontend/vite-read-only-api-proxy.ts
COPY frontend/public ./frontend/public
COPY frontend/src ./frontend/src

# Frontend type-checking includes colocated tests whose fixtures are deliberately outside the build context.
RUN find frontend/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete
RUN npm run build
RUN rm -rf dist/tests

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json

RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS backend

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install --yes --no-install-recommends supervisor \
  && rm -rf /var/lib/apt/lists/*

# One Unix user per process family (spec 6.1); only the entrypoint and supervisord stay root.
RUN set -eu; \
  for entry in listener:10001 h2b:10002 h2a:10003 autoarm:10004 opapi:10005 retention:10006 worker:10007 ops:10008; do \
    name="${entry%%:*}"; uid="${entry##*:}"; \
    groupadd --system --gid "$uid" "$name"; \
    useradd --system --uid "$uid" --gid "$uid" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$name"; \
  done; \
  install -d -o ops -g ops -m 0700 /var/lib/sol/evidence

WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY --from=build /app/scripts/provision-executor-roles.sql ./dist/scripts/provision-executor-roles.sql
# The build writes the qualification profiles owner-only; every service user reads dist/.
RUN chmod -R a+rX /app/dist
COPY --chmod=0755 deploy/back/bin/ /usr/local/bin/
COPY deploy/back/supervisor/supervisord.conf /etc/sol/supervisord.conf
COPY deploy/back/supervisor/programs/ /etc/sol/programs/
# vault-setup loads the policies into Vault (deploy/host/vault-init.sh).
COPY --chmod=0755 deploy/vault/policies/ /etc/sol/vault/policies/

EXPOSE 3000 3100

CMD ["sol-entrypoint"]

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS frontend

RUN addgroup -S -g 10100 caddy \
  && adduser -S -D -H -u 10100 -G caddy -s /sbin/nologin caddy \
  && chown -R caddy:caddy /data /config

COPY --from=build /app/frontend/dist /srv
COPY deploy/front/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/front/front-entrypoint /usr/local/bin/front-entrypoint

EXPOSE 8080 80 443

CMD ["front-entrypoint"]

FROM hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55 AS vault

# vault-entrypoint starts as root to read the unseal key, then runs Vault as the image's vault
# user (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 5).
USER root
ENV VAULT_ADDR=http://127.0.0.1:8200
COPY --chmod=0644 deploy/vault/vault.hcl /vault/config/vault.hcl
COPY --chmod=0755 deploy/vault/vault-entrypoint /usr/local/bin/vault-entrypoint

EXPOSE 8200

ENTRYPOINT ["vault-entrypoint"]
CMD []

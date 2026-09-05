# Listener Database Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le listener paper capable d'émettre une intention canary sous un rôle PostgreSQL dédié sans aucune autorité live.

**Architecture:** Étendre le script de provisioning rejouable avec une allowlist fermée propre au listener. Vérifier statiquement et sur PostgreSQL 16 que les projections métier restent accessibles tandis que les tables d'armement, signature et soumission restent interdites.

**Tech Stack:** PostgreSQL 16, TypeScript strict, `node:test`, ESM, GitHub Actions.

---

### Task 1: Contrat d'autorité listener

**Files:**
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `scripts/provision-executor-roles.sql`

- [ ] **Step 1: Write the failing static test**

Ajouter des assertions exigeant la remise à zéro complète du rôle, les grants
métier, les colonnes exactes d'intention et l'absence de toute table live.

- [ ] **Step 2: Run test to verify RED**

Run: `npx tsx --test tests/executor-roles-provisioning.test.ts`

Expected: FAIL car le rôle listener ne possède encore aucun grant positif.

- [ ] **Step 3: Implement the minimal SQL authority**

Ajouter un bloc rejouable qui révoque les dérives, accorde les tables métier,
les deux séquences et le sous-ensemble lecture/insert d'intention documenté.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `npx tsx --test tests/executor-roles-provisioning.test.ts`

Expected: PASS.

### Task 2: Preuve PostgreSQL 16 et exploitation

**Files:**
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `docs/operations/executor-live-canary.md`

- [ ] **Step 1: Write the failing PostgreSQL integration assertions**

Étendre le test réel pour créer un login `NOINHERIT`, activer le rôle, vérifier
les DML métier nécessaires et refuser lecture/mutation des tables live.

- [ ] **Step 2: Run the integration test against PostgreSQL 16**

Run: `TEST_DATABASE_URL="$CANARY_ADMIN_DATABASE_URL" npx tsx --test tests/executor-roles-provisioning.test.ts`

`CANARY_ADMIN_DATABASE_URL` est injectée par l'environnement de test et n'est
jamais écrite dans le dépôt.

Expected before final SQL: FAIL sur au moins un droit métier manquant.

- [ ] **Step 3: Complete only the missing grants**

Corriger l'allowlist SQL sans donner de droit de table global ni d'autorité
`execution_*` supplémentaire.

- [ ] **Step 4: Document the external role activation**

Versionner le runbook et documenter le login mono-membre, le paramètre
`options=-c role=sol_token_listener_writer`, `POSTGRES_AUTO_MIGRATE=false` et
l'arrêt de l'émission avant armement.

- [ ] **Step 5: Verify the real bounded paper probe**

Run: `npm run paper:dry-run -- --duration-seconds=5 --max-sessions=5 --report-file=/var/lib/sol-token-listener/evidence/listener-role-probe.json`

Expected: technical status `COMPLETED`, même si aucune position n'est observée.

### Task 3: Vérification et livraison

**Files:**
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`

- [ ] **Step 1: Update versioned architecture documentation**

Décrire H2i comme frontière de données, sans le présenter comme un canary ou
une validation économique.

- [ ] **Step 2: Run all quality gates**

Run: `npm run build && npm run check && npm run lint && npm test && npm run docs:check`

Expected: tous les contrôles passent.

- [ ] **Step 3: Commit, push, open PR, request review**

Limiter la PR à H2i et demander une revue Codex. Corriger au plus trois cycles,
puis fusionner uniquement si la CI et les fils bloquants sont verts.

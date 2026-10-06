# Chemin simple — lot 1 : suppressions — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retirer le code mort, le harnais paper MVP et le sous-système « dossier » (social, graphe de wallets, analytics participants), puis supprimer les tables devenues inutiles, sans changer le comportement du listener, du paper ni de l'exécuteur.

**Architecture:** Deux PR. PR A : code mort et harnais paper MVP (aucune table touchée). PR B : `creatorHasNotSold` recalculé depuis les trades du mint, retrait du câblage dossier (factory, runtime, pipeline, repositories), API et front réduits, puis migration 062 qui supprime les tables. Les enums (types d'événements, signaux, codes de qualification, étapes du pipeline) restent tels quels.

**Tech Stack:** TypeScript ESM, `node:test` via `tsx`, `pg`, React 19 + Vite + zod, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-simple-path-design.md` (sections « Suppressions », « API et front »).

## Conventions pour chaque tâche

- Worktree : `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile`. Jamais le dépôt parent.
- Base de test : Postgres jetable Docker sur 55432. Export avant les tests :
  `export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test`.
  Ne jamais toucher le Postgres natif sur 5432.
- Les tests d'architecture lisent `dist/` : `npm run build:backend` avant `npm run test:backend`.
- Vérification de fin de tâche : `npm run check:backend && npm run lint:backend && git diff --check`, plus les tests ciblés de la tâche.
- Un commit par tâche, message en anglais, terminé par la ligne
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Suppression : `git rm` du fichier, puis `grep -rn "<nom-du-module>" src tests scripts frontend` doit être vide (hors docs historiques).

---

# PR A — code mort et harnais paper MVP

Branche : `refactor/remove-dead-code` depuis `origin/main`.

### Task A1 : déplacer `createRepositoryId`

**Files:**
- Create: `src/storage/repository-id.ts`
- Modify: `src/storage/launchpad-event.repository.ts:30`, `src/storage/pumpfun-observation.repository.ts:9`, `tests/storage-foundation.test.ts:3`

- [ ] **Step 1 :** copier tel quel `createRepositoryId` depuis `src/storage/repositories.ts:19-26` (avec ses imports `node:crypto`) dans `src/storage/repository-id.ts`, exporté sous le même nom.
- [ ] **Step 2 :** remplacer `from './repositories.js'` par `from './repository-id.js'` dans les deux repositories, et `from '../src/storage/repositories.js'` par `from '../src/storage/repository-id.js'` dans `tests/storage-foundation.test.ts` pour l'import de `createRepositoryId` uniquement (si le test importe autre chose de `repositories.ts`, retirer ces cas de test, ils couvrent le code mort de la tâche A2).
- [ ] **Step 3 :** `npx tsx --test tests/storage-foundation.test.ts tests/launchpad-event.repository.test.ts` → PASS.
- [ ] **Step 4 :** commit `refactor(storage): move createRepositoryId out of the legacy repositories module`.

### Task A2 : supprimer le code mort

**Files (git rm):**
- `src/dashboard/` (tout le dossier)
- `src/strategy/session-engine.ts`, `src/execution/trade-executor.ts`, `src/security/token-risk.service.ts`
- `src/storage/repositories.ts`, `src/storage/ignored-asset.repository.ts`
- `src/executor-live/confirmation-worker.ts`, `src/executor-live/reconciliation-worker.ts`
- Devenus orphelins : `src/security/risk-evaluator.ts`, `src/security/passive-round-trip-probe.ts`, `src/security/token-risk.types.ts`, `src/execution/transaction-queue.ts`, `src/execution/transaction-simulator.ts`, `src/execution/transaction-confirmer.ts`, `src/execution/wallet.ts`, `src/domain/session-status.ts`, `src/heartbeat/heartbeat.ts`, `src/solana/token/mint-reader.ts`, `src/ports/bonding-curve-snapshot-store.ts`
- Tests : `tests/session-engine.test.ts`, `tests/trade-executor.test.ts`, `tests/risk-policy.test.ts`, `tests/executor-live-confirmation.test.ts`, `tests/executor-live-reconciliation.test.ts`, et tout test qui n'importe qu'un des fichiers ci-dessus (vérifier avec `grep -ln` avant suppression).

**Files (modify):**
- `src/config/env.ts:125-130, 248-250, 461-466` (config dashboard), `.env.example:218-223`, `tests/config-safety.test.ts:784-786`
- `tests/api-safety.test.ts:10` (regex citant `trade-executor`), `tests/helpers/execution-boundary.ts:7`
- `tests/executor-architecture.test.ts:773, 782` (liste `expectedLiveFiles`)

**Ne pas supprimer** (encore utilisés) : `src/storage/pumpfun-observation.repository.ts`, `src/application/catch-up-scanner.ts`, `src/dex/raydium-cpmm/`, `src/solana/rpc/program-subscriber.ts`, `src/solana/rpc/rpc-soak-transport.ts`, `src/operations/`.

- [ ] **Step 1 :** pour chaque fichier listé, `grep -rn "<basename sans extension>" src tests scripts` ; si un importeur hors liste apparaît, s'arrêter et le signaler (BLOCKED) au lieu de supprimer.
- [ ] **Step 2 :** `git rm` des fichiers ; éditer les fichiers « modify ».
- [ ] **Step 3 :** `npm run check:backend && npm run lint:backend && npm run build:backend` → OK ; `npx tsx --test tests/executor-architecture.test.ts tests/config-safety.test.ts tests/api-safety.test.ts` → PASS.
- [ ] **Step 4 :** commit `refactor: remove dead dashboard, legacy session engine and unwired executor workers`.

### Task A3 : supprimer le harnais paper MVP (code seulement)

**Files (git rm):**
- `src/cli/paper-mvp.ts`, `src/cli/paper-mvp-runtime.ts`, `src/application/paper-mvp-collector.ts`
- `src/domain/paper-mvp.ts`, `src/domain/paper-mvp-causal-evidence.ts`
- `src/ports/paper-mvp-repository.ts`, `src/ports/paper-mvp-source.ts`
- `src/storage/paper-mvp.repository.ts`, `src/storage/paper-mvp-source.ts`, `src/storage/paper-mvp-causal-evidence.ts`
- `src/ports/provider-usage-probe.ts`, `src/application/unavailable-provider-usage.probe.ts` (si aucun autre importeur)
- Tests : `tests/paper-mvp-cli.test.ts`, `tests/paper-mvp-collector.test.ts`, `tests/paper-mvp.repository.test.ts`, `tests/paper-mvp.test.ts`, `tests/provider-usage-probe.test.ts`, `tests/fixtures/paper-mvp-cycle-evidence.ts`
- Doc : `docs/operations/paper-mvp-validation.md`

**Files (modify):**
- `package.json` : retirer les scripts `paper:mvp` et `paper:mvp:compiled`
- `src/qualification/qualification-profile.ts:67` : retirer `loadBundledTechnicalMvpQualificationProfile` si `paper-mvp.ts` était son seul appelant
- `src/storage/database.ts:269-363, 383-437, 1095, 1208-1218` : retirer les gardes et purges liées aux runs MVP (`paper_mvp_*`) et les clés `paperMvp*` du type de résultat de purge (`:138-215`)
- `tests/bootstrap-safety.test.ts:15, 470`
- `scripts/deployment-smoke.mjs:121-193` : retirer les clés de purge `paperMvp*` (garder les noms de migrations 018-025 aux lignes 73-80)
- `tests/deployment-artifacts.test.ts:1234-1235` si elles citent ces clés

**Garder :** `tests/paper-mvp-migration.test.ts` jusqu'à la tâche B6 (les tables existent encore) ; les migrations 018-025.

- [ ] **Step 1 :** même vérification d'importeurs qu'en A2.
- [ ] **Step 2 :** `git rm` et éditions.
- [ ] **Step 3 :** `npm run check:backend && npm run lint:backend && npm run build:backend` → OK ; `TEST_DATABASE_URL=… npx tsx --test tests/bootstrap-safety.test.ts tests/database*.test.ts tests/deployment-artifacts.test.ts` → PASS.
- [ ] **Step 4 :** commit `refactor(paper): remove the paper MVP validation harness`.

### Task A4 : vérification complète, PR A

- [ ] **Step 1 :** `npm run build:backend && TEST_DATABASE_URL=… npm run test:backend` ; `cd frontend && npm test` (inchangé). Tout échec : corriger dans la tâche concernée, nouveau commit.
- [ ] **Step 2 :** push, `gh pr create --base main`, corps en français terminé par `🤖 Generated with [Claude Code](https://claude.com/claude-code)` ; attendre `quality`, `deployment-contract`, `frontend-e2e` verts ; merge ; mettre `main` local à jour.

---

# PR B — dossier, API/front, tables

Branche : `refactor/remove-dossier` depuis `origin/main` après merge de la PR A.

### Task B1 : `creatorHasNotSold` depuis les trades du mint (TDD)

**Files:**
- Modify: `src/ports/qualification-projection-repository.ts:12-21` (`QualificationEvidenceSnapshot`)
- Modify: `src/storage/qualification-projection.repository.ts` (`loadCanonicalInput` :298, requête créateur :446-487, règle :526-533)
- Modify: `src/application/qualification-rebuild.service.ts:312-315`
- Test: `tests/qualification-rebuild.service.test.ts`, `tests/qualification-projection.repository.test.ts`

- [ ] **Step 1 : test qui échoue (service).** Dans `tests/qualification-rebuild.service.test.ts`, ajouter deux cas qui construisent le snapshot avec `creatorProfile: null` et `creatorHasSold: false` puis `true`, et vérifient : signal `creatorHasNotSold` `SATISFIED` puis `NOT_SATISFIED`, et condition `CREATOR_EARLY_SELL` active seulement dans le second cas. Utiliser les helpers de snapshot déjà présents dans le fichier.
- [ ] **Step 2 :** `npx tsx --test tests/qualification-rebuild.service.test.ts` → FAIL (propriété `creatorHasSold` inconnue / signal `UNKNOWN`).
- [ ] **Step 3 : implémentation service.** Ajouter `readonly creatorHasSold: boolean;` à `QualificationEvidenceSnapshot`. Dans `qualification-rebuild.service.ts:312-315`, remplacer la lecture de `snapshot.creatorProfile?.hasSold` par `snapshot.creatorHasSold`, pour le signal et pour `CREATOR_EARLY_SELL`.
- [ ] **Step 4 : test qui échoue (repository, Postgres).** Dans `tests/qualification-projection.repository.test.ts`, un cas qui insère un lancement puis un `BondingCurveTradeObserved` `SELL` du créateur (fixtures existantes du fichier) et vérifie `creatorHasSold === true` ; même cas sans vente → `false` ; une vente `orphaned` → `false`.
- [ ] **Step 5 : implémentation repository.** Dans `loadCanonicalInput`, remplacer la requête `creator_profiles` (:446-487) par :

```sql
SELECT EXISTS (
  SELECT 1
  FROM domain_events event
  JOIN raw_chain_events raw ON raw.raw_event_id = event.raw_event_id
  WHERE event.mint = $1
    AND event.type = 'BondingCurveTradeObserved'
    AND event.confirmation_status <> 'orphaned'
    AND raw.confirmation_status <> 'orphaned'
    AND event.payload #>> '{trade,kind}' = 'SELL'
    AND event.payload #>> '{trade,trader}' = $2
) AS creator_has_sold
```

avec `$2 = launch.creator`, en reprenant exactement la forme de jointure de `src/storage/paper-decision.repository.ts:1860-1885` (`activeLaunchTrades`) si les noms de colonnes ou de chemins JSON diffèrent. Supprimer la règle « profil créateur et snapshot holders présents ensemble » (:526-533). `creatorProfile` reste dans le snapshot, toujours `null`, jusqu'à B3.
- [ ] **Step 6 :** `TEST_DATABASE_URL=… npx tsx --test tests/qualification-rebuild.service.test.ts tests/qualification-projection.repository.test.ts tests/qualification-projection.service.test.ts` → PASS.
- [ ] **Step 7 :** commit `feat(qualification): derive creatorHasNotSold from the mint's bonding-curve trades`.

### Task B2 : retirer le câblage dossier du listener

**Files (modify):**
- `src/application/production-listener-factory.ts` : imports :68, 69, 97, 101, 106, 110, 111, 123, 148-151, 158 ; argument `socialJobPolicy` :517-520 ; `publicHttp` :523-529 ; `funding`/`participants`/`graph` :532-541 ; `socialWorker` :585-596 ; arguments du pipeline :675-677 ; composant `socialWorker` :706, :746
- `src/application/listener-runtime.ts` : :10, 18, 19, 63, 77, 84, 163-185 (dépendance et état `social`)
- `src/application/observed-transaction-pipeline.ts` : champs de résultat :40-44, interfaces `FundingObserver`/`MintProjectionRebuilder` :83-100, paramètres :126-128, étapes :156-160, :167-178, :208-212. La taxonomie `src/domain/observed-pipeline-taxonomy.ts` ne change pas.
- `src/storage/launchpad-event.repository.ts` : `SocialJobPolicy` et `PUBLIC_SOCIAL_RETENTION_HOURS` :10, 45-50, 72, 80-87 ; `reconcileSocialFinality` :235 ; `enqueueSocialJob` :280 ; purge sociale dans `retract` :310-339 (conserver le calcul de `purge_after` de `token_launches` et `raw_chain_events`, :314, 323, 341, en le reprenant sans le social) ; helpers :352-363, :365-407, :415-431 ; écriture `launch_trades` :283-302, :342, :583. Ne pas toucher `writeTransition` (`state_transitions`).
- `src/storage/paper-decision.repository.ts` : `loadSnapshot` :346-356, :381-382 ; `latestMetadata` :1270-1290 ; `latestWalletGraph` :1909-1965 ; port `src/ports/paper-decision-repository.ts:9, 12, 15, 50-54`
- `src/storage/qualification-projection.repository.ts` : loaders social :376-422, metadata :424-445 (garder si l'API ou le paper lit `token_metadata_snapshots` ; sinon retirer), holders :488-525, graphe :534-600, `loadSocial` :613-667, `loadWalletGraph` :668-800, helpers :1143-1530, :1577-1626, :1951-2009 ; port `src/ports/qualification-projection-repository.ts:2, 8, 10, 12-37` (`creatorProfile`, `holderSnapshot`, `social`, `walletGraph` retirés du snapshot)
- `src/application/qualification-rebuild.service.ts` : lectures de `snapshot.social`, `snapshot.metadata` (si retiré), `snapshot.holderSnapshot`, `snapshot.walletGraph` (:297-311, :317-333) → signaux et faits correspondants laissés absents (`UNKNOWN`)
- `src/storage/database.ts` : purges sociales :227-262, `launch_trades` :296, wallet/participants :899-940, `participantDomainEvents` :1066-1090, gardes `NOT EXISTS` sociaux :1103-1110, :1147, :1174-1183, et les clés correspondantes du type de résultat :138-215
- `src/config/env.ts:91-98, 405-428` (config `social*`) et `.env.example` correspondant

**Files (git rm):**
- `src/social/`, `src/analytics/`, `src/metadata/http-metadata.provider.ts`, `src/metadata/bounded-public-http.client.ts`
- `src/application/launch-participant-analytics.service.ts`, `social-enrichment-worker.ts`, `social-qualification-refresh.service.ts`, `wallet-evidence-observation.service.ts`, `wallet-graph-rebuild.service.ts`
- `src/domain/participant-analytics.ts`, `participant-analytics-events.ts`, `social-evidence.ts`, `wallet-funding.ts`, `wallet-graph.ts`, `wallet-graph-events.ts` — **sauf** si un type ou une constante y est encore importé par `src/domain/events.ts` ou le front (types d'événements conservés) : dans ce cas ne garder que cette constante, déplacée dans `events.ts`
- `src/ports/metadata-provider.ts`, `participant-analytics-repository.ts`, `social-evidence-repository.ts`, `social-verification-provider.ts`, `wallet-evidence-repository.ts`, `wallet-funding-evidence-extractor.ts`, `wallet-graph-repository.ts`
- `src/solana/wallet-funding-evidence-extractor.ts`
- `src/storage/participant-analytics.repository.ts`, `social-evidence.repository.ts`, `wallet-evidence.repository.ts`, `wallet-graph.repository.ts`
- Tests listés dans la section « Tests to delete » ci-dessous

**Tests to delete:** `bounded-public-http.client`, `creator-profiler`, `http-metadata.provider`, `launch-participant-analytics.service`, `observed-holder-analyzer`, `participant-analytics-contracts`, `participant-analytics-events`, `participant-analytics.repository`, `public-content-evidence`, `public-social-verification.provider`, `social-enrichment-worker`, `social-evidence-contracts`, `social-evidence.repository`, `social-qualification-observations`, `social-qualification-refresh.service`, `social-url-normalizer`, `solana-wallet-funding-evidence-extractor`, `wallet-evidence-observation.service`, `wallet-evidence.repository`, `wallet-funding-contracts`, `wallet-graph-analyzer`, `wallet-graph-contracts`, `wallet-graph-events`, `wallet-graph-rebuild.service`, `wallet-graph-terminal-diagnostics`, `wallet-graph.repository` (`tests/<nom>.test.ts`), `tests/helpers/wallet-graph-fixture.ts`, `tests/fixtures/pumpfun/create-v2-opaque-holder-mainnet.json` si plus aucun test ne le lit. Les tests de migration (`participant-analytics-migration`, `social-evidence-migration`, `social-persistence-retry-migration`, `wallet-graph-migration`) restent jusqu'à B6.

**Tests to edit:** `observed-pipeline-failure-fixtures.ts`, `observed-pipeline-failure`, `observed-transaction-pipeline`, `qualification-projection.repository`, `qualification-projection.service`, `qualification-rebuild.service`, `tracked-trade-ingestion.integration`, `transaction-ingestion-recovery`, `production-listener-factory` (:1417, :1429), `launchpad-event.repository`, `listener-runtime`, `paper-decision.repository`, `paper-decision-worker`.

- [ ] **Step 1 :** éditions dans cet ordre : pipeline, factory, runtime, repositories, puis `git rm`. Le compilateur sert de liste de contrôle : `npm run check:backend` jusqu'à 0 erreur.
- [ ] **Step 2 :** `grep -rnE "social|walletGraph|wallet_graph|creator_profiles|token_holders|observed_wallet|launch_trades|participant" src --include='*.ts' | grep -vE "socialAuthenticity|social_score|observed-pipeline-taxonomy|domain/events.ts"` → ne doit rester que des références justifiées (qualification, taxonomie, types d'événements conservés, API traitée en B3).
- [ ] **Step 3 :** `npm run build:backend && TEST_DATABASE_URL=… npx tsx --test` sur les tests modifiés → PASS.
- [ ] **Step 4 :** commit `refactor(listener): remove social enrichment, wallet graph and participant analytics`.

### Task B3 : API backend

**Files (modify):**
- `src/interfaces/http/api-router.ts:54-55, 140-151, 375, 382-383` : routes `social` et `holders` retirées, regex `(?:\/(events|risk))?$`
- `src/ports/api-projection-repository.ts:3, 9, 26-27`
- `src/storage/api-projection.repository.ts` : imports :3-4, 17-18, 24-26, 37-39, 72-76, 111 ; `ApiHolderProjectionLimits` :139, :223-236, :734 ; `NOT_AVAILABLE_*` :189-192 ; `getLaunch` :280-282 (`assembleLaunchDetail(launch, projections)`) ; `listLaunchEvents` :286-326 (garder seulement le SELECT `domain_events`, conserver la colonne `inner_sort` utilisée par le keyset `afterSql`) ; `getLaunchSocial`/`getLaunchHolders` :415-433 ; santé :552-572, :689-690, :693, :705 (plus de lecture de `social_enrichment_jobs`, plus de `socialJobs` ni de `pipeline.social`) ; `loadSocial` :879-1002, `loadHolders` :1004-1070, `loadWalletGraph` :1072-1215 ; `assembleLaunchDetail` :1243-1258 ; mappers `toSocialLink` :1339, `toSocialEvidence` :1361, `toHolderSnapshot` :1451, `toWalletGraphCoverage` :1510 ; helpers `holderLimit` :2043, `emptySocialJobs` :2138, `socialJobsFromRow` :2162, `activeConfirmation` :2079 seulement s'il n'a plus d'appelant ; validation du pipeline :2641-2654, :2678, :2689-2691
- `src/api/contracts.ts:42-46, 53-54, 128-129, 229-350, 411, 425, 471, 487, 495`
- `src/app.ts:46, 182-186, 227` ; `src/config/env.ts:473-491` (`API_HOLDER_*`, `API_WALLET_CLUSTER_*`) et `.env.example`
- Ne pas toucher : `socialAuthenticity` / `social_score` (qualification), `DOMAIN_EVENT_TYPES`.

**Tests (modify):** `tests/api-router.test.ts` (:7, 13, 76-83, 109, 111, 128-129, 195-196, 212-240, 247-248, 267, 476), `tests/api-projection.repository.test.ts` (cas :548, 566, 641, 691, 716, 867, 925, 1004, 1033, 1082 supprimés ; :1106 réécrit pour vérifier que le SQL ne contient plus `state_transitions` ; mocks `social_enrichment_jobs` :1690, 2027, 2057, 2094 et cas :2017 supprimés), `tests/api-safety.test.ts:14, 16, 37-38`, `tests/api-contracts.test.ts:26-27, 330-405, 476-478, 520-531`. `tests/api-sse.test.ts:510-538` reste (le type d'événement est conservé).

- [ ] **Step 1 :** dans `tests/api-router.test.ts`, ajouter un cas : `GET /api/v1/launches/<mint>/social` et `/holders` → 404 `ROUTE_NOT_FOUND`. Lancer → FAIL.
- [ ] **Step 2 :** éditions backend ; relancer → PASS.
- [ ] **Step 3 :** `npm run check:backend && npm run lint:backend && npm run build:backend` ; `TEST_DATABASE_URL=… npx tsx --test tests/api-*.test.ts` → PASS.
- [ ] **Step 4 :** commit `refactor(api): drop social and holders projections and the state-transition timeline union`.

### Task B4 : front

**Files (git rm):** `frontend/src/features/launch/holders-panel.tsx`, `frontend/src/features/launch/social-panel.tsx` (et leurs tests s'ils existent).

**Files (modify):**
- `frontend/src/features/launch/launch-page.tsx:9, 12, 15, 18, 63-64`
- `frontend/src/data/api-client.ts:10, 15, 20, 51-52, 173-178`
- `frontend/src/data/api-schemas.ts` : schémas social :141-194, holders/graphe :236-332, `launchDetailSchema.social`/`.holders` :343-344, `pipeline.social` :806, `socialJobs` :812, enveloppes :889-890, types :926-927. **Garder** les quatre types dans `domainEventTypeSchema` (:25-28).
- `frontend/src/data/queries.ts:12, 17, 100-118`, `frontend/src/data/query-keys.ts:10-11, 17-19, 31-32`
- `frontend/src/features/health/health-page.tsx:24, 180`
- Tests : `frontend/tests/fixtures/api.ts` (fixtures social/holders), `src/app/app.test.tsx:26-27`, `src/features/health/health-page.test.tsx:93-94`, `src/data/api-schemas.test.ts:103, 117-118, 148-149, 323-324, 371`, `src/data/query-keys.test.ts:10-11, 37-48`, `src/features/launch/launch-page.test.tsx:10, 19, 27-28, 42-43, 96-100` (garder la partie « escaped orphan diagnostics » de la Timeline)
- E2E : `frontend/tests/e2e/mock-api.mjs:9-11, 14, 63, 68-69` ; `frontend/tests/e2e/operator-console.spec.ts:16-19` (étapes Social et Détenteurs retirées)
- Ne pas toucher : `features/live/`, `operator-client`, `operator-schemas`.

- [ ] **Step 1 :** dans `launch-page.test.tsx`, cas : la page de détail n'affiche que les onglets attendus (sans « Social » ni « Détenteurs »). Lancer `cd frontend && npx vitest run src/features/launch` → FAIL.
- [ ] **Step 2 :** éditions ; relancer → PASS.
- [ ] **Step 3 :** `cd frontend && npm test && npm run build && npx playwright test` → PASS (Playwright sur le mock API).
- [ ] **Step 4 :** commit `refactor(frontend): remove the social and holders tabs`.

### Task B5 : docs

**Files (modify):** `docs/api/v1.md` (:47-48, 53, 82-100, 168-205, 212-215, 656-658, 668-672, 702-704, 751), `README.md` (:235, 578, 738, 753, 827-834, 909, 920, 929-930) — retirer routes, champs, variables et paragraphes social/holders/graphe ; garder la mention des scores de qualification.

- [ ] **Step 1 :** éditions ; `grep -nE "/social|/holders|socialJobs|API_HOLDER|API_WALLET_CLUSTER|SOCIAL_(HTTP|WORKER|RETRY)" docs/api/v1.md README.md` → vide.
- [ ] **Step 2 :** commit `docs: drop social and holders from the API reference and README`.

### Task B6 : migration 062, droits et tête de migration

**Files:**
- Create: `migrations/062_drop_dossier_and_legacy_tables.sql`
- Modify: `src/execution-migrations/live-catalog.ts` (ligne sha256 de 062), `src/executor-live/startup-validator.ts:34, 592`, `src/executor-live-recovery/startup-validator.ts:39, 265`, `scripts/deployment-smoke.mjs:116` et les tests qui épinglent 061 (`grep -rln "061_execution_live_position_ledger" src scripts tests` et `grep -rnE "length, 61\)" tests`), en suivant le commit `24f54e4` comme modèle
- Modify: `scripts/provision-executor-roles.sql` (grants listener :336-385, rétention SELECT :1332-1399 et DELETE :1418-1484, `GRANT UPDATE … paper_mvp_runs` :1507-1509) : retirer les 27 tables
- Modify: `tests/listener-database-authority.test.ts:21-40` (`BUSINESS_TABLES`), `tests/executor-roles-provisioning.test.ts:311`, `tests/migration-contract.test.ts:42-43, 57`
- Delete: `tests/paper-mvp-migration.test.ts`, `tests/participant-analytics-migration.test.ts`, `tests/social-evidence-migration.test.ts`, `tests/social-persistence-retry-migration.test.ts`, `tests/wallet-graph-migration.test.ts` — ou, si un autre test en dépend, les borner à leur propre tête comme fait pour 059 (helper de copie `migrateDatabase` jusqu'à leur migration)
- Modify: `tests/api-event-stream-migration.test.ts:41, 45, 172-219, 276-278` : borner les cas qui purgent les tables supprimées à la tête 061 avec le même helper

- [ ] **Step 1 : test qui échoue.** Ajouter `tests/drop-dossier-tables-migration.test.ts` (Postgres) : après `migrateDatabase`, chacune des 27 tables est absente (`to_regclass('public.<t>') IS NULL`), les fonctions `prevent_paper_mvp_sample_mutation` et `prevent_paper_mvp_run_immutable_mutation` sont absentes, et `state_transitions`, `token_metadata_snapshots`, `domain_events`, `token_launches` existent. Lancer → FAIL.
- [ ] **Step 2 : migration.**

```sql
-- 062_drop_dossier_and_legacy_tables.sql
-- Simple path (docs/superpowers/specs/2026-10-06-simple-path-design.md): tables of the removed
-- dossier subsystem, the paper MVP harness and the unused migration-001 schema. Fails closed:
-- no CASCADE, so an unexpected dependent object aborts the migration.

DROP TABLE paper_mvp_position_samples, paper_mvp_runs;
DROP FUNCTION prevent_paper_mvp_sample_mutation();
DROP FUNCTION prevent_paper_mvp_run_immutable_mutation();

DROP TABLE social_verification_evidence, social_http_observations, social_links,
  social_evidence_collections, social_enrichment_jobs;

DROP TABLE wallet_cluster_members, wallet_clusters, wallet_relationships, wallet_graph_snapshots,
  wallet_graph_profiles, wallet_funding_evidence, wallet_funding_observations;

DROP TABLE observed_wallet_positions, token_holders_snapshots, creator_profiles;

DROP TABLE launch_trades;

DROP TABLE trades, swap_events, token_risk_reports, token_sessions, discovered_pools,
  listener_checkpoints, risk_settings, ignored_assets;
```

Si une instruction échoue sur un objet dépendant non inventorié, l'ajouter explicitement (pas de `CASCADE`) et le noter dans le commit.
- [ ] **Step 3 :** tête de migration et sha256 (voir `24f54e4`), droits, tests épinglés.
- [ ] **Step 4 :** `npm run build:backend && TEST_DATABASE_URL=… npx tsx --test tests/drop-dossier-tables-migration.test.ts tests/migration-*.test.ts tests/*-migration.test.ts tests/listener-database-authority.test.ts tests/executor-roles-provisioning.test.ts tests/executor-live-startup.test.ts tests/executor-live-recovery-startup.test.ts tests/deployment-artifacts.test.ts` → PASS.
- [ ] **Step 5 :** commit `feat(migrations): drop dossier, paper MVP and legacy tables (062)`.

### Task B7 : vérification complète, PR B

- [ ] **Step 1 :** `npm run build:backend && TEST_DATABASE_URL=… npm run test:backend` ; `cd frontend && npm test && npx playwright test`. Les échecs connus et isolés sous charge (cohortes de l'inbox, sérialisation de qualification) sont relancés seuls avant d'être jugés.
- [ ] **Step 2 :** smoke : `node --env-file=<scratchpad>/observe.env --import tsx scripts/migrate.ts` sur la base jetable vidée, puis démarrage du listener **seulement avec l'accord de l'opérateur** (connexion RPC mainnet).
- [ ] **Step 3 :** push, PR, CI verte, merge, `main` local à jour.

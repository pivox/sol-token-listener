# Canary Intent Pair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Émettre et persister atomiquement une cible canary pristine et son sibling de simulation, puis fermer tous les chemins qui pourraient consommer ou promouvoir le mauvais côté de la paire.

**Architecture:** Un nouvel agrégat domaine versionné dérive la paire depuis l'intention BUY canonique. Le repository paper insère cible, sibling et paire dans la transaction existante lorsque le flag H2k est activé. PostgreSQL porte les invariants inter-lignes, les claims génériques excluent la cible et H2c/H2h valident le rôle exact de chaque intention. Aucun composant H2k-a ne contacte Solana ou ne possède de capacité wallet/live.

**Tech Stack:** TypeScript strict ESM, Node.js test runner via `tsx`, PostgreSQL 16, migrations SQL versionnées, Pino/configuration existante.

---

## Contraintes transverses

- Spécification normative : `docs/superpowers/specs/2026-09-05-executor-canary-intent-pair-design.md` v1.0.0.
- Deux cycles de revue GitHub au maximum.
- TDD obligatoire : chaque tâche commence par un test rouge ciblé.
- `EXECUTION_PREFLIGHT_PAIR_EMISSION_ENABLED=false` par défaut.
- Aucun wallet, keypair, signer, armement, byte signé ou transport de soumission.
- H2k-b, et seulement H2k-b, ajoutera le runner one-shot, la sélection après watermark, les claims exacts, les contrats H2c/H2h v2 et le manifeste.

### Task 1: Agrégat domaine déterministe de paire

**Files:**

- Create: `src/domain/execution-preflight-intent-pair.ts`
- Create: `tests/execution-preflight-intent-pair.test.ts`

**Step 1: Write the failing test**

Tester que `createExecutionPreflightIntentPairDraft(targetDraft)` :

- refuse tout draft autre qu'un BUY WSOL/SPL Token 9 décimales et `PUMP_FUN_ONLY` ;
- dérive un sibling économiquement identique avec un `logicalCommandId`, `logicalOrderKey` et `id` distincts et déterministes ;
- dérive un `pairId` et un `pairFingerprint` stables depuis une forme canonique v1 ;
- refuse les objets mutables, proxifiés, les propriétés supplémentaires et les entiers hors bornes.

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/execution-preflight-intent-pair.test.ts`

Expected: FAIL, module absent.

**Step 3: Write minimal implementation**

Créer des types immuables explicites :

```ts
export interface ExecutionPreflightIntentPairDraftV1 {
  readonly payloadVersion: 1;
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationIntent: ExecutionIntentDraftV1;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly expiresAtMs: number;
}
```

Réutiliser `createExecutionIntentDraft` et `canonicalStringifyJson`; ne jamais recopier une logique de hash divergente.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/execution-preflight-intent-pair.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/domain/execution-preflight-intent-pair.ts tests/execution-preflight-intent-pair.test.ts
git commit -m "feat(executor): define deterministic canary intent pairs"
```

### Task 2: Migration 041 et invariants PostgreSQL

**Files:**

- Create: `migrations/041_execution_preflight_intent_pairs.sql`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `src/executor-live/startup-validator.ts`
- Modify: `src/executor-live-recovery/startup-validator.ts`
- Modify: `src/executor-readiness/database.ts`
- Modify: `src/preflight-source/database.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Create: `tests/execution-preflight-intent-pair-migration.test.ts`
- Modify: `tests/execution-intent-migration.test.ts`
- Modify: migration/startup tests that pin the migration head

**Step 1: Write the failing migration tests**

Couvrir base vide, upgrade depuis 040, rejeu, schéma non-public/search_path hostile, hash catalogue et cas hostiles : parent manquant, même parent deux fois, tuple économique divergent, cible/probe non pristine, probe déjà `live_reserved`, modification/suppression isolée d'une paire, rétention avant quatre heures et collision cross-lane 1:1. Le rejeu exact d'une paire existante fonctionne après terminalisation du probe sans réappliquer le guard pristine de création.

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/execution-preflight-intent-pair-migration.test.ts tests/copy-migrations.test.ts`

Expected: FAIL, migration/catalogue absents.

**Step 3: Implement the migration**

Ajouter la table append-only et des fonctions/contraintes qui :

- verrouillent les deux parents dans l'ordre lexical ;
- contrôlent l'identité du tuple causal et économique ;
- exigent target/probe distincts, pristine, BUY, WSOL/SPL9, `PUMP_FUN_ONLY` ;
- interdisent `live_reserved=true` au sibling ;
- imposent une membership normalisée avec unicité globale cross-lane ;
- interdisent UPDATE et DELETE hors chemin de rétention atomique avec les deux parents ;
- s'appuient après purge sur les tombstones d'intentions existants pour interdire le rejeu.

La migration doit rester qualifiée par schéma, rejouable et compatible avec les rôles créés après migration. Propager le nouveau head 041 dans tous les validateurs, manifests et tests qui épinglent actuellement 040 ; aucun composant ne doit annoncer un faux head.

**Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/execution-preflight-intent-pair-migration.test.ts tests/execution-intent-migration.test.ts tests/executor-live-startup.test.ts tests/executor-live-recovery-startup.test.ts tests/executor-readiness-database.test.ts tests/execution-preflight-source-database.test.ts`

Expected: PASS sous PostgreSQL 16.

**Step 5: Commit**

```bash
git add migrations/041_execution_preflight_intent_pairs.sql src/execution-migrations/live-catalog.ts src/executor-live/startup-validator.ts src/executor-live-recovery/startup-validator.ts src/executor-readiness/database.ts src/preflight-source/database.ts scripts/deployment-smoke.mjs tests
git commit -m "feat(storage): persist immutable canary intent pairs"
```

### Task 3: Émission atomique derrière configuration fermée

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `src/storage/execution-intent.repository.ts`
- Create: `src/storage/execution-preflight-intent-pair.repository.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/execution-intent-emission.integration.test.ts`
- Create: `tests/execution-preflight-intent-pair.repository.test.ts`

**Step 1: Write failing configuration and integration tests**

Prouver que le flag absent/faux conserve une seule intention, que `true` échoue hors `paper`, sans émission normale, sans `PAPER_MINIMUM_CONFIRMATION=finalized` ou hors allowlist WSOL, et qu'un OPEN finalized valide insère les deux intentions et la paire dans une seule transaction. Un CLOSE sous flag reste une intention SELL canonique unique. Injecter une erreur à chaque insert et vérifier qu'aucune moitié n'est commitée ; couvrir aussi replay paper/ACK ambigu et collision d'un sibling préexistant. Prouver qu'il n'existe ni rétro-formation ni backfill des décisions antérieures.

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/config.test.ts tests/execution-intent-emission.integration.test.ts tests/execution-preflight-intent-pair.repository.test.ts`

Expected: FAIL sur le nouveau contrat.

**Step 3: Implement minimal emission**

Étendre la configuration interne sans modifier le comportement par défaut :

```ts
readonly executionPreflightPairEmissionEnabled: boolean;
```

Dans `emitExecutionIntentInTransaction`, conserver le chemin actuel pour CLOSE. Pour OPEN seulement, créer d'abord la cible canonique via le chemin existant, puis dériver/créer le sibling et la paire dans le même client transactionnel. Le rejeu doit retourner les lignes existantes seulement si tous les fingerprints correspondent.

**Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/config.test.ts tests/execution-intent-emission.integration.test.ts tests/execution-preflight-intent-pair.repository.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add .env.example src/config/env.ts src/application/production-listener-factory.ts src/storage/paper-decision.repository.ts src/storage/execution-intent.repository.ts src/storage/execution-preflight-intent-pair.repository.ts tests/config.test.ts tests/execution-intent-emission.integration.test.ts tests/execution-preflight-intent-pair.repository.test.ts
git commit -m "feat(listener): emit canary intent pairs atomically"
```

### Task 4: Fences de claim et de promotion

**Files:**

- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `src/storage/execution-operations.repository.ts`
- Modify: `migrations/041_execution_preflight_intent_pairs.sql`
- Modify: `tests/execution-intent.repository.test.ts`
- Modify: `tests/execution-operations.repository.test.ts`
- Modify: `tests/execution-preflight-intent-pair-migration.test.ts`

**Step 1: Write failing hostile tests**

Créer une cible plus ancienne que tout le backlog et vérifier que le claim non-live `purpose=EXECUTE`/simulation ne la prend jamais, alors que le sibling reste claimable. Tester concurrence, expiration et replay. Tester que H2c v1 continue d'accepter une intention historique non appairée mais que SQL direct comme repository refusent tout sibling.

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/execution-intent.repository.test.ts tests/execution-operations.repository.test.ts tests/execution-preflight-intent-pair-migration.test.ts`

Expected: au moins une cible appairée est encore claimable/promouvable à tort.

**Step 3: Add the fences**

Ajouter `NOT EXISTS` ciblé au claim non-live `EXECUTE`; conserver `DRY_RUN` non consommant et les claims live inchangés. Ajouter un guard SQL monotone qui refuse toute promotion côté sibling, y compris par un autre repository. Ne pas exiger encore une paire pour les cibles legacy H2c v1.

**Step 4: Run tests to verify they pass**

Run: même commande.

Expected: PASS, y compris les courses transactionnelles.

**Step 5: Commit**

```bash
git add src/storage/execution-intent.repository.ts src/storage/execution-operations.repository.ts migrations/041_execution_preflight_intent_pairs.sql tests/execution-intent.repository.test.ts tests/execution-operations.repository.test.ts tests/execution-preflight-intent-pair-migration.test.ts
git commit -m "fix(executor): fence paired canary targets"
```

### Task 5: Autorités PostgreSQL, rétention et documentation

**Files:**

- Modify: `scripts/provision-executor-roles.sql`
- Modify: `src/storage/database.ts`
- Modify: `tests/execution-worker-live-partition-migration.test.ts`
- Modify: `tests/execution-operations-retention.test.ts`
- Modify: `tests/listener-database-authority.test.ts`
- Modify: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/executor-readiness-database.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/executor-live-main.integration.test.ts`

**Step 1: Write failing authority and retention tests**

Prouver les droits minimums avec les vrais rôles PostgreSQL : H2i insère paire/memberships, H2j lit seulement la membership requise par son anti-join, H2c lit seulement la lane nécessaire au rejet sibling ; H2h v1, readiness, API et PUBLIC n'y accèdent pas. Vérifier les cinq familles de refus du provisioning. Couvrir paire jamais consommée, probe terminal/cible intacte, préparation échouée et crash : la phase productrice expire d'abord les parents périmés par lots bornés avec transitions cohérentes, puis la purge attend quatre heures après le terminal le plus récent et supprime enfants, memberships, paire, tombstones et parents dans l'ordre FK.

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/execution-worker-live-partition-migration.test.ts tests/execution-operations-retention.test.ts tests/listener-database-authority.test.ts tests/executor-worker-database-authority.test.ts tests/executor-roles-provisioning.test.ts tests/executor-readiness-database.test.ts tests/executor-live-main.integration.test.ts`

Expected: droits/table/références H2k manquants.

**Step 3: Implement and document**

Extraire/réutiliser le chemin `expirePreSubmission` pour que `purgeExpiredFoundationData` exécute réellement une phase d'expiration bornée avant sa cohorte de purge, sans dupliquer les règles de transition. Mettre à jour le provisioning hermétique et les documents versionnés. Le HTML Bootstrap doit montrer H2k-a comme disponible seulement après fusion et H2k-b comme prochaine étape, avec `CANARY_NOT_STARTED` visible.

**Step 4: Run tests and docs checks**

Run: commande précédente puis `npm run docs:check`.

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/provision-executor-roles.sql src/storage/database.ts tests/execution-worker-live-partition-migration.test.ts tests/execution-operations-retention.test.ts tests/listener-database-authority.test.ts tests/executor-worker-database-authority.test.ts tests/executor-roles-provisioning.test.ts tests/executor-readiness-database.test.ts docs/architecture/pumpfun-v1.md docs/operations/executor-live-canary.md docs/system-overview.html tests/executor-live-main.integration.test.ts
git commit -m "docs(executor): document canary intent pair controls"
```

### Task 6: Vérification, PR et deux cycles de revue maximum

**Files:**

- Modify only if a verification or review finding requires a scoped fix.

**Step 1: Run targeted execution suite**

```bash
npx tsx --test tests/execution-preflight-intent-pair*.test.ts tests/execution-intent*.test.ts tests/execution-operations*.test.ts tests/execution-worker-live-partition-migration.test.ts
```

Expected: PASS.

**Step 2: Run repository gates**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
```

Expected: PASS; si le full suite local subit un timeout de contention, rejouer le fichier isolé et exiger quand même la CI GitHub complète verte.

**Step 3: Security boundary scan**

```bash
rg -n "Keypair|secretKey|signTransaction|sendRawTransaction|sendTransaction|EXECUTION_ARM" src/domain/execution-preflight-intent-pair.ts src/storage/execution-preflight-intent-pair.repository.ts migrations/041_execution_preflight_intent_pairs.sql
```

Expected: aucune capacité interdite.

**Step 4: Create PR**

Pousser la branche, ouvrir une PR H2k-a vers `main`, demander la première revue Codex et attendre CI/revue.

**Step 5: Review cycle 1**

Vérifier chaque finding, corriger seulement les findings valides par TDD, pousser et résoudre les threads. Si aucun finding bloquant et CI verte, fusionner sans consommer un second cycle.

**Step 6: Review cycle 2 maximum**

Demander une seconde revue seulement si le premier cycle a produit des modifications matérielles. Après correction des findings valides et CI verte, fusionner. Ne pas lancer de troisième cycle.

**Step 7: Continue with H2k-b**

Mettre à jour `main`, créer un worktree isolé H2k-b et appliquer un nouveau plan versionné pour le runner one-shot. Ne charger aucun wallet et ne franchir aucun armement.

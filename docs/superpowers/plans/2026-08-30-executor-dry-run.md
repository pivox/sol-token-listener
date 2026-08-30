# Executor Dry-Run Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer un exécuteur ESM séparé qui évalue durablement les intentions `PENDING|RETRY_READY` sans les consommer, sans RPC Solana, wallet, signature ou soumission.

**Architecture:** Le repository d'intentions existant acquiert un lease technique avec un nouveau purpose `DRY_RUN`. Un domaine pur construit une assessment déterministe ; un repository annexe la persiste et libère le lease dans un statement PostgreSQL atomique. Un runtime single-flight séparé orchestre claim, assessment, commit et reprise après ACK ambigu, sans modifier statut, tentative, transition ou révision de l'intention.

**Tech Stack:** TypeScript strict ESM, Node.js 22, `node:test`, PostgreSQL 16/`pg`, Pino, SHA-256 avec `node:crypto`.

---

## Carte des fichiers

Nouveaux fichiers :

- `migrations/032_execution_dry_run_assessments.sql` — table annexe et contraintes ;
- `src/domain/execution-dry-run.ts` — types fermés, validations et fingerprints ;
- `src/ports/execution-dry-run-repository.ts` — contrat `complete/findExact` ;
- `src/storage/execution-dry-run.repository.ts` — commit atomique et lecture exacte ;
- `src/executor/config.ts` — configuration executor indépendante ;
- `src/executor/database.ts` — pool borné et suivi du client single-flight ;
- `src/executor/logger.ts` — logger expurgé `sol-token-executor` ;
- `src/executor/dry-run-worker.ts` — une passe claim/assessment/commit ;
- `src/executor/runtime.ts` — boucle single-flight et arrêt borné ;
- `src/executor/main.ts` — composition ESM et point d'entrée ;
- `tests/execution-dry-run.test.ts` — domaine et vecteurs SHA-256 ;
- `tests/execution-dry-run-repository-contract.test.ts` — surface de port ;
- `tests/execution-dry-run.repository.test.ts` — SQL hostile, fencing et PostgreSQL réel ;
- `tests/execution-dry-run-migration.test.ts` — migration 032 et invariants ;
- `tests/executor-config.test.ts` — parser fermé ;
- `tests/executor-logger.test.ts` — allowlist et redaction des logs ;
- `tests/executor-dry-run-worker.test.ts` — orchestration et ACK ambigu ;
- `tests/executor-runtime.test.ts` — polling, signaux et deadline ;
- `tests/executor-architecture.test.ts` — graphe source/dist sans capacité Solana.
- `tests/executor-main.integration.test.ts` — processus compilé avec PostgreSQL réel.

Fichiers modifiés :

- `src/ports/execution-intent-repository.ts` et
  `src/storage/execution-intent.repository.ts` — purpose/claim `DRY_RUN` uniquement ;
- `src/storage/database.ts` — purge et compteur assessment ;
- tests de migration qui épinglent actuellement `031_execution_intents.sql` ;
- `scripts/deployment-smoke.mjs` et `tests/deployment-artifacts.test.ts` — migration 032 et compteur ;
- `package.json`, `.env.example`, `README.md`, `docs/architecture/pumpfun-v1.md` — commande et contrat opérateur.

## Task 1: Domaine déterministe de l'assessment

**Files:**

- Create: `src/domain/execution-dry-run.ts`
- Create: `tests/execution-dry-run.test.ts`

- [ ] **Step 1: écrire le test rouge des constantes, valeurs fermées et vecteurs**

Construire un `ExecutionIntentV1` gelé depuis `createExecutionIntentDraft()` avec :

```ts
const intent = Object.freeze({
  ...createExecutionIntentDraft({
    strategyId: 'dry-run-strategy', strategyVersion: 1,
    positionId: 'position-1', logicalCommandId: 'command-1',
    mint: '11111111111111111111111111111111', side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1', decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: 1_000, expiresAtMs: 10_000,
  }),
  status: 'PENDING', attemptCount: 0, stateRevision: 0n,
  lastReasonCode: null, terminalAtMs: null,
  reconciliationCompletedAtMs: null, purgeAfterMs: null,
  createdAtMs: 1_000, updatedAtMs: 1_000,
} satisfies ExecutionIntentV1);
```

Attendre exactement :

```ts
assert.equal(draft.assessmentId,
  'execution_dry_run_assessment_eb23c443c27d692f29ed0aa96610e6b6ba248b39ab67b7cd459eff1683beaa0d');
assert.equal(draft.inputFingerprint,
  'ec733e4d262abad089b77a07dff3877ff95b2cda98875098d8336d65c5fd8b2c');
assert.equal(draft.resultFingerprint,
  '725f65dd813e14b6bfbec289964dcd94c58ac030694a76c26df13a03a80c9679');
assert.equal(draft.outcome, 'FOUNDATION_VALIDATED');
assert.equal(draft.coverage, 'INTENT_AND_LEASE_ONLY');
for (const status of [draft.quoteStatus, draft.buildStatus, draft.simulationStatus,
  draft.signatureStatus, draft.submissionStatus]) assert.equal(status, 'NOT_RUN');
```

Tester aussi un `RETRY_READY` prouvé, BUY/SELL, les bornes u64, le segment nul,
les changements de chaque champ couvert, le rejet de tous les autres statuts,
objets non gelés/proxy/accessors/clés en trop, nombres invalides et hashes en
majuscules.

- [ ] **Step 2: lancer le test et constater l'absence du module**

Run: `npx tsx --test tests/execution-dry-run.test.ts`

Expected: FAIL avec `Cannot find module '../src/domain/execution-dry-run.js'`.

- [ ] **Step 3: implémenter le domaine minimal**

Exporter les constantes :

```ts
export const EXECUTION_DRY_RUN_PAYLOAD_VERSION = 1 as const;
export const EXECUTION_DRY_RUN_SPECIFICATION_VERSION = '1.4.0' as const;
export const EXECUTION_DRY_RUN_EVALUATOR_VERSION = 1 as const;
```

Définir `ExecutionDryRunAssessmentDraftV1`, puis
`ExecutionDryRunAssessmentV1 extends ... { recordedAtMs: number }`. Tous les
champs sont `readonly`. Exporter :

```ts
export function createExecutionDryRunAssessment(
  intent: ExecutionIntentV1,
): ExecutionDryRunAssessmentDraftV1;
export function assertExecutionDryRunAssessmentDraft(
  value: unknown,
): asserts value is ExecutionDryRunAssessmentDraftV1;
export function assertExecutionDryRunAssessment(
  value: unknown,
): asserts value is ExecutionDryRunAssessmentV1;
```

Réutiliser `assertExecutionIntent()`, refuser un intent non gelé ou hors
`PENDING|RETRY_READY`, encoder chaque segment avec un préfixe longueur uint32
big-endian, et appliquer mot pour mot les trois préimages de la spec. Retourner
des objets gelés ; envelopper toute validation publique dans une
`ExecutionDryRunValidationError` à message fixe `Invalid execution dry-run assessment.`.

- [ ] **Step 4: vérifier domaine, types et lint**

Run:

```bash
npx tsx --test tests/execution-dry-run.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/domain/execution-dry-run.ts tests/execution-dry-run.test.ts --max-warnings=0
```

Expected: tous verts, zéro skip.

- [ ] **Step 5: commit**

```bash
git add src/domain/execution-dry-run.ts tests/execution-dry-run.test.ts
git commit -m "feat: add deterministic dry-run assessments"
```

## Task 2: Port annexe et claim `DRY_RUN`

**Files:**

- Create: `src/ports/execution-dry-run-repository.ts`
- Create: `tests/execution-dry-run-repository-contract.test.ts`
- Modify: `src/ports/execution-intent-repository.ts`
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `tests/execution-intent-repository-contract.test.ts`
- Modify: `tests/execution-intent.repository.test.ts`

- [ ] **Step 1: écrire les tests rouges de surface**

Figer ce contrat exact :

```ts
export interface ExecutionDryRunRepository {
  complete(
    claim: ClaimedExecutionIntent,
    assessment: ExecutionDryRunAssessmentDraftV1,
  ): Promise<ExecutionDryRunAssessmentV1>;
  findExact(
    assessment: ExecutionDryRunAssessmentDraftV1,
  ): Promise<ExecutionDryRunAssessmentV1 | null>;
}
```

Le fichier de port n'importe que des types depuis `domain/execution-dry-run` et
`ports/execution-intent-repository`. Étendre le test de type pour attendre :

```ts
export type ExecutionClaimPurpose =
  'EXECUTE' | 'CONFIRM' | 'RECONCILE' | 'DRY_RUN';
```

Ajouter un cas claim `DRY_RUN/PENDING` et `DRY_RUN/RETRY_READY` qui vérifie :

- `expires_at > operation.at + leaseMs` ;
- `NOT EXISTS` sur `execution_dry_run_assessments` version 1 ;
- `FOR UPDATE SKIP LOCKED`, ordre `requested_at,id` ;
- aucune mutation status/attempt/revision/reason ;
- aucune référence à `execution_attempts` ou transitions ;
- `renew()` existant inchangé et toujours valide pour `CONFIRM|RECONCILE` après
  l'échéance métier.

- [ ] **Step 2: lancer les tests rouges**

Run:

```bash
npx tsx --test tests/execution-dry-run-repository-contract.test.ts tests/execution-intent-repository-contract.test.ts tests/execution-intent.repository.test.ts
```

Expected: FAIL car le port annexe et le purpose `DRY_RUN` n'existent pas.

- [ ] **Step 3: ajouter le port et le SQL dédié**

Créer le port exact ci-dessus. Dans `CLAIM_SQL`, ajouter un SQL dédié commençant
par l'horloge :

```sql
WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds', statement_timestamp()) AS at
), candidate AS MATERIALIZED (
  SELECT intent.id
  FROM execution_intents intent CROSS JOIN operation
  WHERE intent.status IN ('PENDING','RETRY_READY')
    AND intent.expires_at > operation.at
      + ($2::BIGINT * INTERVAL '1 millisecond')
    AND (intent.lease_expires_at IS NULL OR intent.lease_expires_at <= operation.at)
    AND NOT EXISTS (
      SELECT 1 FROM execution_dry_run_assessments assessment
      WHERE assessment.intent_id=intent.id AND assessment.evaluator_version=1
    )
  ORDER BY intent.requested_at,intent.id
  FOR UPDATE OF intent SKIP LOCKED
  LIMIT 1
)
```

L'UPDATE conserve l'horloge `operation.at`, pose seulement le triplet de lease,
ne change pas `updated_at`, et retourne la projection hostile existante. Étendre
`claimPurpose()`/`statusMatchesPurpose()` ; vérifier après décodage
`intent.expiresAtMs > claimAtMs + leaseMs`. Ne modifier ni l'interface ni le SQL
de `renew()`. Le claim `DRY_RUN` utilise un helper de connexion dédié qui appelle
`release(true)` après toute erreur ou donnée hostile ; les autres purposes
conservent leur chemin #51-B.

- [ ] **Step 4: exécuter les tests ciblés**

Run:

```bash
npx tsx --test tests/execution-dry-run-repository-contract.test.ts tests/execution-intent-repository-contract.test.ts tests/execution-intent.repository.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: tous verts, zéro skip hors tests PostgreSQL conditionnels déjà présents.

- [ ] **Step 5: commit**

```bash
git add src/ports/execution-dry-run-repository.ts src/ports/execution-intent-repository.ts src/storage/execution-intent.repository.ts tests/execution-dry-run-repository-contract.test.ts tests/execution-intent-repository-contract.test.ts tests/execution-intent.repository.test.ts
git commit -m "feat: add non-consuming dry-run claims"
```

## Task 3: Migration 032 et invariants PostgreSQL

**Files:**

- Create: `migrations/032_execution_dry_run_assessments.sql`
- Create: `tests/execution-dry-run-migration.test.ts`

- [ ] **Step 1: écrire les tests rouges de schéma**

Le test statique exige la table, la PK `assessment_id`, l'unique
`(intent_id,evaluator_version)`, les contraintes fermées, les hashes minuscules,
les timestamps milliseconde/finis, et l'absence de wallet/signature/transaction.
Le test PostgreSQL réel applique : base vide, upgrade 031→032, replay du fichier,
insert canonique, rejet de chaque enum/version/hash/date invalide et cascade.

Exiger aussi une identité parent forte :

```sql
CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_dry_run_identity_idx
  ON execution_intents (id,strategy_id,strategy_version,decision_fingerprint);
```

et une FK composite des quatre colonnes depuis l'assessment.

- [ ] **Step 2: lancer le test rouge**

Run: `npx tsx --test tests/execution-dry-run-migration.test.ts`

Expected: FAIL avec `ENOENT` pour la migration 032.

- [ ] **Step 3: écrire la migration additive et rejouable**

Créer la table avec exactement les colonnes de la spec. Utiliser
`SMALLINT/INTEGER/BIGINT`, `TEXT`, `TIMESTAMPTZ`, défaut
`date_trunc('milliseconds', statement_timestamp())`, checks d'octets 1..256,
`^[0-9a-f]{64}$`, `payload_version=1`, `specification_version='1.4.0'`,
`evaluator_version=1`, statut `PENDING|RETRY_READY`, outcome/coverage fermés et
cinq statuts `NOT_RUN`. Ajouter un index de lecture sur `(recorded_at,intent_id)`.

- [ ] **Step 4: vérifier statique et PostgreSQL**

Run:

```bash
npx tsx --test tests/execution-dry-run-migration.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test tests/execution-dry-run-migration.test.ts
```

Expected: vert ; le second run ne doit comporter aucun skip lorsque la variable
CI PostgreSQL est présente.

- [ ] **Step 5: commit**

```bash
git add migrations/032_execution_dry_run_assessments.sql tests/execution-dry-run-migration.test.ts
git commit -m "feat: persist executor dry-run assessments"
```

## Task 4: Repository atomique `complete/findExact`

**Files:**

- Create: `src/storage/execution-dry-run.repository.ts`
- Create: `tests/execution-dry-run.repository.test.ts`

- [ ] **Step 1: écrire les tests rouges du repository**

Couvrir avec client scripté hostile et PostgreSQL réel :

- validation synchrone avant connexion et promesses rejetées typées ;
- `complete()` en un seul statement, sans `BEGIN/COMMIT` applicatifs ;
- verrou/fencing exact id, status, owner, token UUID, `state_revision`, lease et
  `expires_at > operation.at` ;
- comparaison SQL de tous les champs immuables de l'intention ;
- insert assessment puis libération du lease dépendante de l'insert ;
- aucun changement status, attempt count, state revision, reason ou
  `updated_at`, y compris pendant la libération ;
- collision, lease perdu, parent muté, ABA et échéance : erreur fermée ;
- `findExact()` retourne la ligne gelée exacte, `null` si absente et
  `INVALID_DATA` si une ligne sous la même identité contredit l'assessment ;
- erreur/release de client expurgées, éviction sur erreur de protocole ;
- deux workers concurrents : une seule assessment ;
- perte d'ACK simulée : `complete` a commit, l'appel rejette, `findExact` prouve
  ensuite le résultat ;
- statut/tentatives/transitions/révision identiques avant et après.

- [ ] **Step 2: lancer le test rouge**

Run: `npx tsx --test tests/execution-dry-run.repository.test.ts`

Expected: FAIL car l'adaptateur n'existe pas.

- [ ] **Step 3: implémenter l'adaptateur minimal**

Exporter une erreur typée à message fixe :

```ts
export type ExecutionDryRunRepositoryErrorCode =
  | 'INVALID_INPUT' | 'INVALID_DATA' | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN' | 'INTENT_FENCE_LOST'
  | 'ASSESSMENT_CONFLICT';
```

`complete()` utilise un CTE unique `operation -> locked -> inserted -> released`
et retourne assessment + compteurs `locked_count/inserted_count/released_count`.
Le seul succès admis est `1/1/1` avec une ligne exactement décodable. Toute
autre combinaison devient l'erreur stable correspondante. Ne pas utiliser la
méthode transactionnelle multi-statement du repository d'intentions.

Une erreur survenue après dispatch du statement `complete`, y compris pendant
la restitution du client, porte `COMMIT_OUTCOME_UNKNOWN`; une erreur de
connexion avant dispatch porte `DATABASE_FAILURE`. `findExact()` exécute un
SELECT unique par `(assessment_id,intent_id,
evaluator_version)`, décode des colonnes exactes projetées en texte pour BIGINT
et timestamp, puis compare chaque champ du draft attendu.

- [ ] **Step 4: vérifier repository et intégration PG**

Run:

```bash
npx tsx --test tests/execution-dry-run.repository.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/storage/execution-dry-run.repository.ts tests/execution-dry-run.repository.test.ts --max-warnings=0
```

Expected: tous verts ; tests PG sans skip en CI.

- [ ] **Step 5: commit**

```bash
git add src/storage/execution-dry-run.repository.ts tests/execution-dry-run.repository.test.ts
git commit -m "feat: atomically record dry-run assessments"
```

## Task 5: Rétention et verrou de migration 032

**Files:**

- Modify: `src/storage/database.ts`
- Modify: `tests/execution-intent-migration.test.ts`
- Modify: `tests/migration-lock.test.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`
- Modify: `tests/creation-entry-migration.test.ts`
- Modify: `tests/paper-claim-scheduler-migration.test.ts`
- Modify: `tests/paper-finality-replay-migration.test.ts`
- Modify: `tests/paper-mvp-migration.test.ts`
- Modify: `tests/participant-analytics-migration.test.ts`
- Modify: `tests/provider-affine-finality-migration.test.ts`
- Modify: `tests/social-persistence-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-timestamp-migration.test.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`
- Modify: `tests/websocket-health-migration.test.ts`

- [ ] **Step 1: étendre les tests de purge avant l'implémentation**

Dans le test de cohorte #51-B, insérer une assessment par intention terminale et
une assessment non éligible. Attendre :

```ts
assert.equal(purged.executionDryRunAssessments, terminalStatuses.length);
assert.equal(purged.executionIntentTransitions, terminalStatuses.length);
assert.equal(purged.executionAttempts, terminalStatuses.length);
assert.equal(purged.executionIntents, terminalStatuses.length);
```

Vérifier transaction atomique/rollback, deuxième passe à zéro, cohorte figée,
tombstones conservés et assessment ouverte conservée.

- [ ] **Step 2: lancer les tests rouges de rétention/déploiement**

Run:

```bash
npx tsx --test tests/execution-intent-migration.test.ts tests/deployment-artifacts.test.ts
```

Expected: FAIL car compteur et migration 032 manquent.

- [ ] **Step 3: implémenter la purge explicite**

Ajouter `executionDryRunAssessments` au type de retour. Après insertion des
tombstones et avant transitions, exécuter :

```sql
DELETE FROM execution_dry_run_assessments assessment
WHERE assessment.intent_id = ANY($1::TEXT[])
```

Retourner le compteur. Ajouter `032_execution_dry_run_assessments.sql` à la
liste canonique du smoke et le compteur à la liste triée. Remplacer uniquement
les assertions « dernière migration » qui pointent 031 par 032 ; conserver les
tests propres à la migration 031 épinglés sur 031.

- [ ] **Step 4: vérifier la cohorte et tous les locks de migration**

Run:

```bash
npx tsx --test tests/execution-intent-migration.test.ts tests/deployment-artifacts.test.ts tests/*migration.test.ts
```

Expected: tous verts ; seuls les tests PG conditionnels peuvent être skip localement.

- [ ] **Step 5: commit**

```bash
git add src/storage/database.ts scripts/deployment-smoke.mjs tests
git commit -m "feat: retain dry-run assessments with intents"
```

## Task 6: Configuration, logger et worker single-pass

**Files:**

- Create: `src/executor/config.ts`
- Create: `src/executor/logger.ts`
- Create: `src/executor/dry-run-worker.ts`
- Create: `tests/executor-config.test.ts`
- Create: `tests/executor-logger.test.ts`
- Create: `tests/executor-dry-run-worker.test.ts`

- [ ] **Step 1: écrire les tests rouges de configuration**

Attendre cette valeur gelée par défaut :

```ts
{
  mode: 'dry-run', databaseUrl: 'postgresql://executor@127.0.0.1:5432/executor',
  pollMs: 1_000,
  leaseMs: 30_000, databaseStatementTimeoutMs: 3_000,
  shutdownGraceMs: 10_000,
}
```

Tester les bornes exactes, nombres canoniques, relations poll/lease/timeout/grâce,
DB vide, `LIVE_TRADING_ENABLED` absent/`false`, rejet de toute autre valeur et
les treize variables de secret listées dans la spec. Vérifier qu'aucun message
d'erreur ne contient la valeur fautive ou `DATABASE_URL`.

- [ ] **Step 2: écrire les tests rouges du worker**

Avec fakes stricts, couvrir : `IDLE`, `RECORDED`, erreur complete + `findExact`
exact donnant `COMMIT_RECOVERED`, erreur + absence repropagée, ligne
contradictoire repropagée, claim perdu, aucune release/renew/attempt/transition,
et un seul travail en vol. Les résultats fermés sont :

```ts
export type DryRunPassResult = 'IDLE' | 'RECORDED' | 'COMMIT_RECOVERED';
```

Dans `tests/executor-logger.test.ts`, écrire dans un sink mémoire et vérifier que
seuls `event`, `mode`, `intentId`, `side`, `outcome` et `errorCode` peuvent être
émis. Injecter URL PostgreSQL, mint, montants, objet Error et les treize noms de
secrets ; aucune valeur ne doit apparaître dans le JSON sérialisé.

- [ ] **Step 3: lancer les tests rouges**

Run:

```bash
npx tsx --test tests/executor-config.test.ts tests/executor-logger.test.ts tests/executor-dry-run-worker.test.ts
```

Expected: FAIL car les modules executor n'existent pas.

- [ ] **Step 4: implémenter config, logger et worker**

Le parser pur accepte `NodeJS.ProcessEnv | Record<string,string|undefined>` et
n'importe pas `src/config/env.ts`. Le logger Pino porte `base.service =
'sol-token-executor'`, redacte les treize noms et n'accepte que des contextes
fermés sans mint, amount, URL ou objet Error.

Le worker dépend de :

```ts
interface DryRunWorkerDependencies {
  readonly intents: Pick<ExecutionIntentRepository, 'claim'>;
  readonly assessments: ExecutionDryRunRepository;
  readonly ownerId: string;
  readonly leaseMs: number;
}
```

Il réclame avec `purpose:'DRY_RUN'`, construit l'assessment pure, appelle
`complete()`. Uniquement sur l'erreur typée `COMMIT_OUTCOME_UNKNOWN`, il appelle
`findExact()` ; exact retourne `COMMIT_RECOVERED`, absence rethrow l'erreur
originale. Il n'appelle jamais `findExact` pour `DATABASE_FAILURE`, conflit ou
fencing, et jamais `renew`, `release`, `beginAttempt`, `finishAttempt` ou
`transition`.

- [ ] **Step 5: vérifier**

Run:

```bash
npx tsx --test tests/executor-config.test.ts tests/executor-logger.test.ts tests/executor-dry-run-worker.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/executor tests/executor-config.test.ts tests/executor-logger.test.ts tests/executor-dry-run-worker.test.ts --max-warnings=0
```

Expected: tous verts.

- [ ] **Step 6: commit**

```bash
git add src/executor/config.ts src/executor/logger.ts src/executor/dry-run-worker.ts tests/executor-config.test.ts tests/executor-logger.test.ts tests/executor-dry-run-worker.test.ts
git commit -m "feat: add executor dry-run worker"
```

## Task 7: Runtime, signaux et frontière d'architecture

**Files:**

- Create: `src/executor/database.ts`
- Create: `src/executor/runtime.ts`
- Create: `src/executor/main.ts`
- Create: `tests/executor-runtime.test.ts`
- Create: `tests/executor-architecture.test.ts`
- Create: `tests/executor-main.integration.test.ts`
- Modify: `tests/helpers/execution-boundary.ts`
- Modify: `package.json`

- [ ] **Step 1: écrire les tests rouges du runtime**

Avec un scheduler manuel et une source de signaux fake, vérifier :

- immédiat `runOnce()`, puis délai poll ;
- aucune passe chevauchée ;
- erreur journalisée par code fixe, puis backoff poll ;
- SIGINT/SIGTERM retirent les deux handlers et empêchent tout nouveau claim ;
- le statement en vol est attendu avant fermeture ;
- deadline déclenche éviction, log `executor.shutdown_forced` et sortie non-zéro ;
- fermeture/échec primaire agrégés sans exposer le message de l'erreur ;
- aucun timer ou handler restant après arrêt propre.

- [ ] **Step 2: écrire le test rouge d'architecture source/dist**

Parcourir récursivement les imports statiques/dynamiques de
`src/executor/main.ts` et, après build, `dist/src/executor/main.js`. Refuser :

```text
@solana/web3.js
@solana/spl-token
@pump-fun/pump-sdk
@pump-fun/pump-swap-sdk
src/execution
src/app
wallet, keypair, signer, secret loader
simulateTransaction, sendTransaction, sendRawTransaction, signTransaction
```

Autoriser uniquement builtins Node, `pg`, `pino`, `dotenv`, domaine/ports
dry-run/intention et storage database/repositories.

- [ ] **Step 3: lancer les tests rouges**

Run:

```bash
npx tsx --test tests/executor-runtime.test.ts tests/executor-architecture.test.ts
```

Expected: FAIL car runtime/main et script manquent.

- [ ] **Step 4: implémenter runtime et composition**

`runtime.ts` expose `runExecutorRuntime(dependencies, options)` avec scheduler,
signal source, `closeDatabase`, `evictDatabase`, `forceExit` injectables. Il
reste single-flight et n'initie aucun statement après signal.

`database.ts` enveloppe le pool `pg` partagé, suit au maximum un client actif,
rend `release()` idempotent et expose `evictActive()` idempotent. Il applique les
timeouts de config dès la construction. Le test de deadline prouve que le
client bloqué reçoit `release(true)` avant `forceExit(1)`.

`main.ts` : charge seulement la config executor, ouvre le pool via
`getDatabasePool(databaseUrl, { connectionTimeoutMillis, query_timeout,
statement_timeout, lock_timeout, idle_in_transaction_session_timeout })`, compose
les deux repositories, génère un owner éphémère
`executor-dry-run-${randomUUID()}` et le worker, installe les signaux puis
exécute le runtime. Il n'importe/n'appelle pas `migrateDatabase` : l'opérateur
applique 032 avant démarrage. Le bootstrap fatal journalise uniquement
`errorName`/code stable et fixe exit 1.

Ajouter :

```json
"executor:dev": "tsx src/executor/main.ts",
"executor:start": "node dist/src/executor/main.js"
```

- [ ] **Step 5: build et test du graphe compilé**

Run:

```bash
npm run build:backend
npx tsx --test tests/executor-runtime.test.ts tests/executor-architecture.test.ts
```

Expected: tous verts ; `dist/src/executor/main.js` existe et le graphe est sûr.

- [ ] **Step 6: tester le vrai processus compilé sur PostgreSQL**

Le test conditionnel `tests/executor-main.integration.test.ts` crée un schéma
isolé via `TEST_DATABASE_URL`, applique les migrations, insère une intention
`PENDING` valide puis spawn `node dist/src/executor/main.js` avec seulement les
variables executor et un `DATABASE_URL` dont `search_path` cible ce schéma. Il
attend une assessment, envoie SIGTERM, attend code 0 et vérifie : une ligne,
parent toujours `PENDING`, mêmes `attempt_count/state_revision/updated_at`, zéro
attempt, zéro transition et lease nul. Un second spawn n'ajoute aucune ligne.

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test tests/executor-main.integration.test.ts
```

Expected: vert sans skip en CI PostgreSQL.

- [ ] **Step 7: commit**

```bash
git add src/executor tests/executor-runtime.test.ts tests/executor-architecture.test.ts tests/executor-main.integration.test.ts tests/helpers/execution-boundary.ts package.json
git commit -m "feat: run dry-run executor as separate process"
```

## Task 8: Documentation opérateur et vérification complète

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`

- [ ] **Step 1: écrire d'abord les assertions documentaires**

Étendre un test documentaire existant ou `tests/executor-architecture.test.ts`
pour exiger : commande build/migrate/start, variables executor, absence de RPC
et wallet, `FOUNDATION_VALIDATED/INTENT_AND_LEASE_ONLY`, cinq `NOT_RUN`, intention
non consommée, #51-D encore requis et live impossible.

- [ ] **Step 2: lancer le test rouge**

Run: `npx tsx --test tests/executor-architecture.test.ts`

Expected: FAIL car README et architecture décrivent encore #51-C comme futur.

- [ ] **Step 3: documenter le runbook exact**

Ajouter à `.env.example` les cinq variables avec commentaires de sécurité.
Dans README :

```bash
npm run build:backend
npm run db:migrate
EXECUTOR_MODE=dry-run DATABASE_URL=postgresql://... npm run executor:start
```

Préciser qu'aucun RPC/wallet n'est utilisé, que le listener reste
`observe|paper`, que le rapport ne vaut pas simulation/PASS, et que #51-D
apportera quote/build/simulation. Mettre à jour la section #51-B de
`docs/architecture/pumpfun-v1.md` sans déclarer #51-D..G livrées.

- [ ] **Step 4: lancer la vérification ciblée avec PostgreSQL**

Run:

```bash
npm run docs:check
npx tsx --test tests/execution-dry-run*.test.ts tests/executor-*.test.ts tests/execution-intent*.test.ts
```

Expected: tous verts ; zéro skip quand `TEST_DATABASE_URL` est disponible.

- [ ] **Step 5: lancer la gate complète fraîche**

Run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
git diff --check
```

Expected: toutes les commandes code 0, aucun test existant en régression.

- [ ] **Step 6: smoke executor PostgreSQL sans RPC/wallet**

Avec une base de test migrée et une intention `PENDING` fixture, lancer
`npm run executor:start`, attendre `executor.assessment_recorded`, envoyer
SIGTERM, puis vérifier SQL : une assessment, intention toujours `PENDING`, zéro
attempt, zéro transition, lease nul. Relancer et vérifier qu'aucune deuxième
assessment n'apparaît.

- [ ] **Step 7: commit documentation**

```bash
git add .env.example README.md docs/architecture/pumpfun-v1.md tests/executor-architecture.test.ts
git commit -m "docs: document executor dry-run operation"
```

## Task 9: Revue et livraison PR #51-C

- [ ] **Step 1: revue locale sécurité/spécification**

Comparer le diff à
`docs/superpowers/specs/2026-08-30-executor-dry-run-design.md`. Rechercher
explicitement imports Solana, `any`, float financier, secret, status/attempt/
transition mutés, appel `renew`, SQL multi-statement dans `complete`, erreur qui
contient URL/credential et test skip inattendu.

- [ ] **Step 2: demander une revue indépendante**

Utiliser `requesting-code-review` sur le range `origin/main..HEAD`, corriger les
findings bloquants, puis rejouer les tests impactés et la gate complète.

- [ ] **Step 3: pousser et ouvrir la PR**

```bash
git push -u origin feat/issue-51c-executor-dry-run
gh pr create --base main --head feat/issue-51c-executor-dry-run --title "feat: add non-consuming executor dry-run" --body "Delivers the #51-C slice: a PostgreSQL-only dry-run assessment sidecar without RPC, wallet, signing, submission, intent transition or execution attempt. #51-D remains required for quote, build and simulateTransaction."
```

Le corps cite `#51-C`, énonce les garanties et liste les commandes de preuve.

- [ ] **Step 4: exécuter au maximum trois cycles GitHub Codex**

Pour chaque cycle : commenter `@codex review`, attendre les checks/threads,
appliquer uniquement les findings valides, tester, pousser, répondre et résoudre
les threads. Arrêter après le troisième cycle même si un quatrième avis serait
souhaitable ; ne fusionner que si aucun blocage connu et CI verte.

- [ ] **Step 5: fusionner et synchroniser**

Fusionner sans réécrire l'historique, vérifier le commit sur `origin/main`, puis
mettre à jour l'issue #51 : #51-C livré, #49 toujours sauté/non PASS, #51-D
prochaine étape quote/build/simulation sans clé ni envoi.

# Execution Intents Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer #51-B, un ledger PostgreSQL durable et idempotent d'intentions d'exécution, sans signer, builder, wallet ou soumission.

**Architecture:** Le domaine partagé décrit un ordre logique et ses transitions sans dépendre de Solana. Un port expose création, claim avec fencing et transitions ; l'adaptateur PostgreSQL applique les invariants dans la migration 031. Un mapper pur peut dériver une intention des identités paper existantes, mais aucun bootstrap ne le compose dans cette PR.

**Tech Stack:** TypeScript 5 strict ESM, Node.js test runner, PostgreSQL 16, `pg`, SHA-256 `node:crypto`, montants `bigint`/`NUMERIC` avec contrainte entière u64 explicite.

---

## Périmètre verrouillé

Créer ou modifier uniquement :

- `src/domain/execution-intent.ts` — vocabulaire, validation, identité et transitions pures ;
- `src/ports/execution-intent-repository.ts` — port durable sans capacité Solana ;
- `src/application/execution-intent-producer.ts` — mapping pur et non composé depuis une décision paper ;
- `src/storage/execution-intent.repository.ts` — PostgreSQL, claims et fencing ;
- `migrations/031_execution_intents.sql` — ledger, tentatives et transitions ;
- `src/storage/database.ts` — purge ordonnée et compteurs ;
- `scripts/deployment-smoke.mjs` et `tests/deployment-artifacts.test.ts` —
  listes canoniques de migration/compteurs du contrat de déploiement ;
- tests homonymes et documentation de sécurité.

Ne pas modifier `src/app.ts`, `src/application/production-listener-factory.ts`,
`src/config/env.ts`, `.env.example` ou `package.json`. Ne pas ajouter
`EXECUTOR_MODE`, keypair, builder, simulation ou transport. La migration ne
crée aucun trigger qui produirait automatiquement une intention.

La séparation effective des rôles PostgreSQL est livrée avec les artefacts
opérateur de #51-F, avant tout déploiement executor. #51-B prépare les tables
et maintient leur absence totale du graphe API/listener ; elle ne crée pas de
rôle global dans une migration applicative et ne déploie encore aucun
executor.

### Task 1: Définir le domaine immutable et versionné

**Files:**
- Create: `src/domain/execution-intent.ts`
- Create: `tests/execution-intent.test.ts`

- [ ] **Step 1: Écrire les tests RED du vocabulaire et de l'identité**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionIntentDraft,
  createExecutionIntentId,
  EXECUTION_INTENT_REASON_CODES,
  EXECUTION_INTENT_STATUSES,
} from '../src/domain/execution-intent.js';

void test('creates one frozen deterministic BUY intent using bigint amounts', () => {
  const first = createExecutionIntentDraft({
    strategyId: 'creation-entry-v1',
    strategyVersion: 1,
    positionId: 'paper-position-1',
    logicalCommandId: 'paper_open_abc',
    mint: '11111111111111111111111111111111',
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 500_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1',
    decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: 1_787_990_400_000,
    expiresAtMs: 1_787_990_445_000,
  });
  assert.equal(first.id, createExecutionIntentId(first));
  assert.equal(first.payloadVersion, 1);
  assert.equal(first.quoteAmountRaw, 500_000n);
  assert.equal(Object.isFrozen(first), true);
});

void test('publishes stable append-only status and reason vocabularies', () => {
  assert.deepEqual(EXECUTION_INTENT_STATUSES, [
    'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
    'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED',
    'EXPIRED', 'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION',
  ]);
  assert.ok(EXECUTION_INTENT_REASON_CODES.includes('INTENT_LEASE_LOST'));
  assert.ok(EXECUTION_INTENT_REASON_CODES.includes('SUBMISSION_AMBIGUOUS'));
});
```

Ajouter des tests qui refusent : `number` à la place de `bigint`, montant nul,
BUY sans quote amount, SELL sans base amount, deux amounts présents, mint ou
fingerprint non canonique, date non entière, expiration antérieure, objet
mutable, propriété additionnelle et transition interdite.

- [ ] **Step 2: Exécuter le test et vérifier l'échec attendu**

Run: `npx tsx --test tests/execution-intent.test.ts`

Expected: FAIL avec `Cannot find module '../src/domain/execution-intent.js'`.

- [ ] **Step 3: Implémenter le contrat minimal**

```ts
export const EXECUTION_INTENT_STATUSES = Object.freeze([
  'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
  'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED',
  'EXPIRED', 'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION',
] as const);

export type ExecutionIntentStatus = typeof EXECUTION_INTENT_STATUSES[number];
export type ExecutionIntentSide = 'BUY' | 'SELL';
export type ExecutionVenuePolicy = 'PUMP_FUN_ONLY' | 'CANONICAL_EXIT';

export interface ExecutionIntentDraftV1 {
  readonly id: string;
  readonly payloadVersion: 1;
  readonly logicalOrderKey: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly positionId: string;
  readonly logicalCommandId: string;
  readonly mint: string;
  readonly side: ExecutionIntentSide;
  readonly venuePolicy: ExecutionVenuePolicy;
  readonly quoteMint: string;
  readonly quoteTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
  readonly quoteDecimals: number;
  readonly quoteAmountRaw: bigint | null;
  readonly baseAmountRaw: bigint | null;
  readonly minimumAmountOutRaw: bigint;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ExecutionIntentV1 extends ExecutionIntentDraftV1 {
  readonly status: ExecutionIntentStatus;
  readonly attemptCount: number;
  readonly lastReasonCode: ExecutionIntentReasonCode | null;
  readonly terminalAtMs: number | null;
  readonly reconciliationCompletedAtMs: number | null;
  readonly purgeAfterMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
```

Implémenter l'identité avec `createHash('sha256')` et un encodage canonique
length-prefixed ; ne jamais concaténer des valeurs avec un séparateur ambigu.
`createExecutionIntentDraft` produit le draft déterministe sans inventer
d'horloge. Le repository retourne `ExecutionIntentV1` avec
`createdAtMs`/`updatedAtMs` issus de PostgreSQL, `status='PENDING'`,
`attemptCount=0` et les champs terminaux à `null`. Exporter
`ExecutionIntentReasonCode`,
`assertExecutionIntent`, `assertExecutionIntentTransition` et les reason codes
exacts de la spécification 1.0.0. Les validateurs doivent lire uniquement des
own data properties et ne jamais invoquer de getter/proxy.

- [ ] **Step 4: Vérifier GREEN et le typecheck**

Run: `npx tsx --test tests/execution-intent.test.ts && npm run check:backend`

Expected: tous les tests du fichier passent et TypeScript sort avec code 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/execution-intent.ts tests/execution-intent.test.ts
git commit -m "feat: define durable execution intent domain (#51)"
```

### Task 2: Créer le schéma PostgreSQL 031

**Files:**
- Create: `migrations/031_execution_intents.sql`
- Create: `tests/execution-intent-migration.test.ts`

- [ ] **Step 1: Écrire les tests RED de migration**

Le test statique doit charger le SQL et exiger les trois tables, les contraintes
d'identité, les statuts, les leases et l'absence de cascade vers paper :

```ts
const sql = await readFile(
  new URL('../migrations/031_execution_intents.sql', import.meta.url),
  'utf8',
);
assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_intents/u);
assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_attempts/u);
assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_intent_transitions/u);
assert.match(sql, /UNIQUE\s*\(logical_order_key\)/u);
assert.doesNotMatch(sql, /REFERENCES\s+paper_(?:positions|trades)/u);
assert.match(sql, /quote_amount_raw NUMERIC,/u);
assert.match(sql, /quote_amount_raw = trunc\(quote_amount_raw\)/u);
```

Le test PostgreSQL conditionnel `TEST_DATABASE_URL` doit appliquer toutes les
migrations depuis une base vide, rejouer sans changement, insérer les bornes
valides, puis vérifier que les incohérences état/lease/amounts sont rejetées.

- [ ] **Step 2: Vérifier RED**

Run: `npx tsx --test tests/execution-intent-migration.test.ts`

Expected: FAIL car la migration 031 manque.

- [ ] **Step 3: Écrire la migration**

Le début du schéma doit suivre ce contrat exact :

```sql
CREATE TABLE IF NOT EXISTS execution_intents (
  id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  logical_order_key TEXT NOT NULL UNIQUE,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  position_id TEXT NOT NULL,
  logical_command_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  venue_policy TEXT NOT NULL CHECK (
    venue_policy IN ('PUMP_FUN_ONLY', 'CANONICAL_EXIT')
  ),
  quote_mint TEXT NOT NULL,
  quote_token_program TEXT NOT NULL,
  quote_decimals SMALLINT NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_amount_raw NUMERIC,
  base_amount_raw NUMERIC,
  minimum_amount_out_raw NUMERIC NOT NULL,
  decision_event_id TEXT NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_reason_code TEXT,
  terminal_at TIMESTAMPTZ,
  reconciliation_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  purge_after TIMESTAMPTZ,
  CHECK ((side = 'BUY' AND quote_amount_raw > 0 AND base_amount_raw IS NULL)
      OR (side = 'SELL' AND base_amount_raw > 0 AND quote_amount_raw IS NULL)),
  CHECK (quote_amount_raw IS NULL OR (
    quote_amount_raw = trunc(quote_amount_raw)
    AND quote_amount_raw < 18446744073709551616
  )),
  CHECK (base_amount_raw IS NULL OR (
    base_amount_raw = trunc(base_amount_raw)
    AND base_amount_raw < 18446744073709551616
  )),
  CHECK (
    minimum_amount_out_raw > 0
    AND minimum_amount_out_raw = trunc(minimum_amount_out_raw)
    AND minimum_amount_out_raw < 18446744073709551616
  ),
  CHECK (expires_at > requested_at),
  CHECK ((lease_owner IS NULL) = (lease_token IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
    OR lease_owner IS NULL),
  CHECK (purge_after IS NULL OR (
    terminal_at IS NOT NULL
    AND reconciliation_completed_at IS NOT NULL
    AND purge_after = reconciliation_completed_at + INTERVAL '4 hours'
  ))
);
```

La liste de statut SQL est exactement celle du domaine, y compris
`RETRY_READY`. Chaque champ texte est non vide et borné à 256 caractères, sauf
les fingerprints qui sont exactement 64 caractères hexadécimaux lowercase.
`requested_at`, `expires_at`, `created_at`, `updated_at`, `terminal_at`,
`reconciliation_completed_at` et `purge_after` sont finis. Les états terminaux
exigent `terminal_at`; les états non terminaux l'interdisent.

`execution_attempts` contient exactement `intent_id`, `attempt_number`,
`status`, `effective_venue`, `provider_id`, `started_at`, `completed_at` et
`reason_code`, `purge_after`, avec PK `(intent_id, attempt_number)`, tentative strictement
positive et FK vers l'intention. `status` est
`STARTED|COMPLETED|ABANDONED`; seul `STARTED` interdit `completed_at`, les deux
autres l'exigent. `effective_venue` est `PUMP_FUN` ou
`PUMP_SWAP` et reste nullable avant #51-D. `execution_intent_transitions`
contient une séquence BIGINT, anciens/nouveaux statuts, reason code, message
humain borné, phase, tentative nullable, preuve JSONB versionnée et date DB.
Les deux tables ont une FK `ON DELETE CASCADE` uniquement vers
`execution_intents`, jamais vers le ledger paper. En #51-B, aucune colonne de
transaction signée n'est nécessaire ; elle sera ajoutée par une migration
versionnée de #51-G.

Créer l'index partiel de claim :

```sql
CREATE INDEX IF NOT EXISTS execution_intents_claim_idx
ON execution_intents (requested_at, id)
WHERE status = 'PENDING';
```

- [ ] **Step 4: Vérifier migration, packaging et replay**

Run: `npx tsx --test tests/execution-intent-migration.test.ts tests/copy-migrations.test.ts`

Expected: tests statiques verts ; tests PostgreSQL verts si
`TEST_DATABASE_URL` est défini, sinon skip explicite.

- [ ] **Step 5: Commit**

```bash
git add migrations/031_execution_intents.sql tests/execution-intent-migration.test.ts
git commit -m "feat: add execution intent ledger migration (#51)"
```

### Task 3: Définir le port durable

**Files:**
- Create: `src/ports/execution-intent-repository.ts`
- Create: `tests/execution-intent-repository-contract.test.ts`

- [ ] **Step 1: Écrire le test RED du port et des résultats figés**

Le test importe les types et instancie une implémentation factice stricte. Il
vérifie que le port n'importe aucun module `src/executor`, `src/execution`,
`@solana/web3.js`, wallet ou transport.

- [ ] **Step 2: Vérifier RED**

Run: `npx tsx --test tests/execution-intent-repository-contract.test.ts`

Expected: FAIL car le port manque.

- [ ] **Step 3: Créer le port exact**

```ts
import type {
  ExecutionIntentDraftV1,
  ExecutionIntentReasonCode,
  ExecutionIntentStatus,
  ExecutionIntentV1,
} from '../domain/execution-intent.js';

export type ExecutionClaimPurpose = 'EXECUTE' | 'CONFIRM' | 'RECONCILE';

export interface ClaimedExecutionIntent {
  readonly intent: ExecutionIntentV1;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export interface ExecutionIntentTransitionInput {
  readonly intentId: string;
  readonly expectedStatus: ExecutionIntentStatus;
  readonly nextStatus: ExecutionIntentStatus;
  readonly leaseToken: string;
  readonly reasonCode: ExecutionIntentReasonCode;
  readonly humanMessage: string;
  readonly activationPhase: 'NONE' | 'CANARY' | 'MICRO_LIVE' | 'PILOT';
  readonly evidence: ExecutionIntentTransitionEvidenceV1;
}

export interface ExecutionIntentTransitionEvidenceV1 {
  readonly payloadVersion: 1;
  readonly attemptNumber: number | null;
  readonly sourceEventId: string | null;
  readonly observedAtMs: number;
}

export interface ExecutionIntentRepository {
  create(draft: ExecutionIntentDraftV1): Promise<Readonly<{
    kind: 'CREATED' | 'REPLAYED';
    intent: ExecutionIntentV1;
  }>>;
  claim(input: Readonly<{
    ownerId: string;
    leaseMs: number;
    purpose: ExecutionClaimPurpose;
  }>): Promise<ClaimedExecutionIntent | null>;
  beginAttempt(claim: ClaimedExecutionIntent): Promise<Readonly<{
    intentId: string;
    attemptNumber: number;
    startedAtMs: number;
  }>>;
  finishAttempt(claim: ClaimedExecutionIntent, input: Readonly<{
    attemptNumber: number;
    status: 'COMPLETED' | 'ABANDONED';
    effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
    providerId: string | null;
    reasonCode: ExecutionIntentReasonCode;
  }>): Promise<boolean>;
  renew(claim: ClaimedExecutionIntent, leaseMs: number): Promise<boolean>;
  release(claim: ClaimedExecutionIntent): Promise<boolean>;
  transition(
    claim: ClaimedExecutionIntent,
    input: ExecutionIntentTransitionInput,
  ): Promise<ExecutionIntentV1>;
  expirePreSubmission(limit: number): Promise<number>;
  read(intentId: string): Promise<ExecutionIntentV1 | null>;
}
```

Le port n'accepte pas `nowMs` pour les opérations de lease : l'autorité de
temps est PostgreSQL. La preuve V1 reste fermée et bornée ; ne conserver aucune
échappatoire `any`.

- [ ] **Step 4: Vérifier GREEN et lint**

Run: `npx tsx --test tests/execution-intent-repository-contract.test.ts && npm run lint:backend`

Expected: code 0.

- [ ] **Step 5: Commit**

```bash
git add src/ports/execution-intent-repository.ts tests/execution-intent-repository-contract.test.ts
git commit -m "feat: define execution intent repository port (#51)"
```

### Task 4: Implémenter le repository PostgreSQL avec fencing

**Files:**
- Create: `src/storage/execution-intent.repository.ts`
- Create: `tests/execution-intent.repository.test.ts`

- [ ] **Step 1: Écrire les tests RED du repository**

Avec un faux pool/client, couvrir :

- `create` insère une fois et retourne `REPLAYED` seulement si tous les champs
  immuables relus sont identiques ;
- collision de `logical_order_key` divergente → erreur typée redacted ;
- claim utilise `FOR UPDATE SKIP LOCKED`, heure PostgreSQL et UUID généré côté
  Node avec `randomUUID()` puis passé en paramètre ;
- aucun claim ne réécrit l'état métier ; un lease expiré rend la ligne
  re-claimable et `PENDING|RETRY_READY -> PROCESSING` passe exclusivement par
  `transition()`, avec son journal atomique ;
- renew, transition, tentative et release exigent `id + lease_token + status`
  ainsi que `lease_expires_at > statement_timestamp()` ;
- `beginAttempt` incrémente le parent et insère la tentative atomiquement ;
- `finishAttempt` fait un CAS unique `STARTED -> COMPLETED|ABANDONED` sous le
  même fencing ; un second appel divergent est refusé ;
- `expirePreSubmission` journalise
  `PENDING|RETRY_READY|PROCESSING|SIMULATED -> EXPIRED` sans claim, uniquement
  avec lease absent/expiré et preuve qu'aucune signature n'existe ;
- CAS à zéro ligne → `INTENT_LEASE_LOST` ;
- transition et journal append-only sont dans la même transaction ;
- rollback/release sont exécutés et les erreurs internes ne sont pas divulguées.

- [ ] **Step 2: Vérifier RED**

Run: `npx tsx --test tests/execution-intent.repository.test.ts`

Expected: FAIL car le repository manque.

- [ ] **Step 3: Implémenter create et claim**

Utiliser cette forme de claim, adaptée sans interpolation :

```sql
WITH candidate AS (
  SELECT id, status
  FROM execution_intents
  WHERE status IN ('PENDING', 'RETRY_READY', 'PROCESSING', 'SIMULATED')
    AND expires_at > statement_timestamp()
    AND (lease_expires_at IS NULL OR lease_expires_at <= statement_timestamp())
  ORDER BY requested_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE execution_intents AS intent
SET lease_owner = $1,
    lease_token = $3::UUID,
    lease_expires_at = statement_timestamp() + ($2::BIGINT * INTERVAL '1 millisecond'),
    updated_at = statement_timestamp()
FROM candidate
WHERE intent.id = candidate.id
RETURNING intent.*
```

Ce SQL est celui de `purpose='EXECUTE'` et conserve l'état métier pour tous les
candidats. Après un claim `PENDING` ou `RETRY_READY`, le worker doit appeler
`transition(..., 'PROCESSING')` avant `beginAttempt` ; cette transaction écrit
le journal append-only et l'état parent atomiquement. Un crash avant cette
transition laisse l'intention dans son état exact pour le prochain claim. Pour
`PROCESSING` et `SIMULATED`, le worker reprend directement l'étape
pré-signature interrompue. `CONFIRM` sélectionne `SUBMITTED` ;
`RECONCILE` sélectionne `SIGNED_NOT_SUBMITTED`, `CONFIRMED`, `RECONCILING` et
`UNKNOWN_REQUIRES_RECONCILIATION`. Ces claims conservent également l'état
métier. Tous remplacent uniquement un lease absent/expiré et journalisent le
reclaim d'un lease expiré.

Générer `$3` avec `randomUUID()` de `node:crypto`, comme le repository inbox
existant ; la migration ne doit activer aucune extension PostgreSQL.

- [ ] **Step 4: Implémenter renew, transition et decode fail-closed**

La transition fait : `BEGIN`, `SELECT ... FOR UPDATE`, validation exacte du
fencing et de `lease_expires_at > statement_timestamp()`, validation domaine,
`INSERT execution_intent_transitions`, `UPDATE` CAS, `COMMIT`. Renew, release,
`beginAttempt` et `finishAttempt` appliquent le même prédicat de fraîcheur ; un
worker expiré ne peut ni se renouveler ni gagner une course contre son
reclaimer. Le decoder PostgreSQL accepte les `NUMERIC` financiers uniquement
sous forme de chaîne décimale u64 canonique puis utilise `BigInt`.
Une transition non terminale conserve le lease courant ; une transition
terminale le libère atomiquement. `release` retire uniquement le lease, sans
modifier l'état métier, afin qu'un claim de reprise dédié puisse reprendre la
ligne.

`beginAttempt` verrouille le parent, vérifie le fencing, calcule
`attempt_count + 1`, insère `(intent_id, attempt_number)` puis met à jour le
parent dans la même transaction. `finishAttempt` verrouille parent et tentative,
vérifie lease/token/numéro, puis fixe une seule fois état terminal, venue,
provider, date et reason code. `expirePreSubmission(limit)` verrouille un lot
borné de lignes expirées `PENDING|RETRY_READY|PROCESSING|SIMULATED` dont le
lease est absent/expiré et qui n'ont aucune tentative signée, écrit une
transition `INTENT_EXPIRED`, fixe `terminal_at` et
`reconciliation_completed_at` au temps DB — aucune tentative n'a alors pu
produire d'effet — puis fixe
`purge_after = reconciliation_completed_at + INTERVAL '4 hours'`.

- [ ] **Step 5: Vérifier GREEN**

Run: `npx tsx --test tests/execution-intent.repository.test.ts`

Expected: tous les scénarios passent.

- [ ] **Step 6: Ajouter le test PostgreSQL réel conditionnel**

Le test `TEST_DATABASE_URL` lance deux repositories concurrents, vérifie un
seul claim, simule perte de lease et replay, puis confirme une seule intention
et un journal ordonné. Il nettoie son schéma en `finally`.

- [ ] **Step 7: Commit**

```bash
git add src/storage/execution-intent.repository.ts tests/execution-intent.repository.test.ts
git commit -m "feat: persist and claim execution intents safely (#51)"
```

### Task 5: Mapper les décisions paper sans composition runtime

**Files:**
- Create: `src/application/execution-intent-producer.ts`
- Create: `tests/execution-intent-producer.test.ts`

- [ ] **Step 1: Écrire les tests RED du mapper pur**

Tester un BUY `PUMP_FUN_ONLY` depuis `session.openCommandId` et un SELL
`CANONICAL_EXIT` depuis `session.closeCommandId`. Refuser session non courante,
quote étrangère,
qualification stale, allowlist hors WSOL et quantité SELL nulle.

- [ ] **Step 2: Vérifier RED**

Run: `npx tsx --test tests/execution-intent-producer.test.ts`

Expected: FAIL car le mapper manque.

- [ ] **Step 3: Implémenter une fonction sans effet**

```ts
export function deriveExecutionIntent(
  input: DeriveExecutionIntentInput,
): ExecutionIntentDraftV1 | null {
  assertFrozenCanonicalDecision(input);
  if (input.requestedAction === 'NONE') return null;
  const side = input.requestedAction === 'OPEN' ? 'BUY' : 'SELL';
  const logicalCommandId = side === 'BUY'
    ? input.session.openCommandId
    : input.session.closeCommandId;
  if (logicalCommandId === null) {
    throw new ExecutionIntentError('DECISION_STALE');
  }
  return createExecutionIntentDraft({
    ...mapCanonicalDecision(input, side),
    logicalCommandId,
    side,
  });
}
```

`DeriveExecutionIntentInput` doit porter explicitement la quote, l'allowlist,
l'expiration, l'identité de qualification et le fingerprint. Le mapper produit
`PUMP_FUN_ONLY` pour un BUY et `CANONICAL_EXIT` pour un SELL ; la venue
effective est décidée et persistée par tentative seulement en #51-D. Ne pas
lire PostgreSQL, RPC, fichier ou horloge depuis cette fonction.

- [ ] **Step 4: Ajouter le test de non-composition**

Étendre `tests/bootstrap-safety.test.ts` pour interdire le nouveau mapper et le
repository dans le graphe de `src/app.ts` pour #51-B. Le domaine/port peuvent
être importés par des tests, mais aucune production d'intention ne doit se
produire au démarrage.

- [ ] **Step 5: Vérifier GREEN**

Run: `npx tsx --test tests/execution-intent-producer.test.ts tests/bootstrap-safety.test.ts`

Expected: code 0, zéro capacité d'exécution dans le bootstrap.

- [ ] **Step 6: Commit**

```bash
git add src/application/execution-intent-producer.ts tests/execution-intent-producer.test.ts tests/bootstrap-safety.test.ts
git commit -m "feat: derive inert execution intents from paper decisions (#51)"
```

### Task 6: Ajouter la rétention terminale de quatre heures

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `tests/execution-intent-migration.test.ts`

- [ ] **Step 1: Écrire le test RED de purge**

Le test vérifie qu'une intention `PENDING`, `PROCESSING` ou
`UNKNOWN_REQUIRES_RECONCILIATION` n'est jamais purgée, même avec une date
ancienne. Une intention terminale réconciliée n'est supprimée qu'à
`purge_after`, dans l'ordre transitions → attempts → intent, et le rollback est
atomique si la dernière suppression échoue.

- [ ] **Step 2: Vérifier RED**

Run: `npx tsx --test tests/execution-intent-migration.test.ts`

Expected: FAIL sur le compteur de purge absent.

- [ ] **Step 3: Étendre la transaction de purge**

Ajouter trois suppressions, avec CTE ou `USING`, puis les compteurs :

```ts
readonly executionIntentTransitions: number;
readonly executionAttempts: number;
readonly executionIntents: number;
```

Le prédicat parent exact est :

```sql
intent.status IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
AND intent.terminal_at IS NOT NULL
AND intent.reconciliation_completed_at IS NOT NULL
AND intent.purge_after <= statement_timestamp()
```

Ne jamais purger `UNKNOWN_REQUIRES_RECONCILIATION`. Les enfants sont supprimés
avant le parent dans la même transaction.

- [ ] **Step 4: Vérifier GREEN**

Run: `npx tsx --test tests/execution-intent-migration.test.ts`

Expected: purge et rollback passent.

- [ ] **Step 5: Commit**

```bash
git add src/storage/database.ts tests/execution-intent-migration.test.ts
git commit -m "feat: purge reconciled execution intents after retention (#51)"
```

### Task 7: Documentation, auto-revue et validation complète

**Files:**
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `README.md`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Documenter la capacité réellement livrée**

Ajouter un court paragraphe indiquant : migration 031 présente, ledger inert,
aucun producteur composé, aucun executor, aucun wallet, aucune signature et
aucun envoi. Ne pas annoncer #51-C à #51-G comme disponibles.

Mettre à jour les listes canoniques du smoke de déploiement avec la migration
031 et les trois nouveaux compteurs de purge. Le test artefact doit exiger ces
entrées exactes sans modifier le nombre ou la topologie des services déployés.

- [ ] **Step 2: Auto-revoir les frontières**

Run:

```bash
rg -n "Keypair|sendTransaction|sendRawTransaction|signTransaction|EXECUTOR_KEYPAIR" \
  src/domain/execution-intent.ts \
  src/ports/execution-intent-repository.ts \
  src/application/execution-intent-producer.ts \
  src/storage/execution-intent.repository.ts
```

Expected: aucune occurrence.

- [ ] **Step 3: Lancer les validations ciblées**

```bash
npx tsx --test \
  tests/execution-intent.test.ts \
  tests/execution-intent-migration.test.ts \
  tests/execution-intent-repository-contract.test.ts \
  tests/execution-intent.repository.test.ts \
  tests/execution-intent-producer.test.ts \
  tests/bootstrap-safety.test.ts
```

Expected: 0 failure.

- [ ] **Step 4: Lancer la gate complète**

```bash
npm run build
npm run check
npm run lint
npm test
npm run docs:check
npm run deployment:smoke
```

Expected: 0 failure ; les tests PostgreSQL nécessitant `TEST_DATABASE_URL`
doivent être exécutés en CI avec PostgreSQL et non silencieusement omis.

- [ ] **Step 5: Inspecter le diff et les secrets**

```bash
git diff --check
git diff --stat origin/main...HEAD
git grep -nE "BEGIN (RSA|OPENSSH|PRIVATE) KEY|\[[0-9]+(,[0-9]+){31,}\]"
```

Expected: aucun whitespace error, périmètre conforme, aucun secret.

- [ ] **Step 6: Commit final documentation**

```bash
git add README.md docs/architecture/pumpfun-v1.md scripts/deployment-smoke.mjs tests/deployment-artifacts.test.ts
git commit -m "docs: describe inert execution intent foundation (#51)"
```

### Task 8: Fermer les deux blockers de la revue finale

**Files:**
- Modify: `src/domain/execution-intent.ts`
- Modify: `migrations/031_execution_intents.sql`
- Modify: `src/application/execution-intent-producer.ts`
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `tests/execution-intent.test.ts`
- Modify: `tests/execution-intent-migration.test.ts`
- Modify: `tests/execution-intent-producer.test.ts`
- Modify: `tests/execution-intent.repository.test.ts`
- Modify: `tests/websocket-health-migration.test.ts`
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`

- [ ] **Step 1: Écrire les régressions RED anti-replay**

Ajouter un test domaine et PostgreSQL qui refusent tout draft dont
`expiresAtMs - requestedAtMs` dépasse `14_400_000`. Ajouter le mutant complet
terminalisation → réconciliation → purge → recréation et vérifier qu'après la
purge la ligne recréée est nécessairement expirée et que `claim(EXECUTE)`
retourne `null`.

- [ ] **Step 2: Borner le TTL au même horizon que la rétention**

Exporter `EXECUTION_INTENT_MAXIMUM_TTL_MS = 14_400_000` depuis le domaine,
l'appliquer dans `immutableFieldsFrom`, dans la contrainte temporelle SQL et
dans le paramètre `maximumIntentTtlMs` du producteur. La preuve attendue est :

```text
expires_at <= requested_at + 4h
requested_at <= terminal_at <= reconciliation_completed_at
purge_after = reconciliation_completed_at + 4h
donc expires_at <= purge_after
```

- [ ] **Step 3: Écrire les régressions RED du journal honnête**

Remplacer les chemins réussis utilisant `INTENT_DUPLICATE` et ajouter des tests
qui exigent les codes positifs stables :

```text
EXECUTION_STARTED
SIMULATION_SUCCEEDED
ATTEMPT_COMPLETED
RETRY_AUTHORIZED
SIGNATURE_PERSISTED
SUBMISSION_ACCEPTED
CONFIRMATION_OBSERVED
RECONCILIATION_STARTED
INTENT_SUCCEEDED
INTENT_CANCELLED
```

Une tentative `COMPLETED` doit porter `ATTEMPT_COMPLETED`; une tentative
`ABANDONED` doit porter un reason d'échec et ne peut pas porter ce code de
succès. Les transitions vers les états positifs doivent utiliser le code
correspondant au nouvel état.

- [ ] **Step 4: Appliquer les invariants TypeScript et PostgreSQL**

Étendre le vocabulaire versionné, le décodage et les contraintes des trois
tables. Valider avant toute connexion les couples statut/reason des inputs
publics et refuser les lignes PostgreSQL contradictoires.

- [ ] **Step 5: Corriger la dernière attente historique 030**

Mettre à jour `tests/websocket-health-migration.test.ts` pour reconnaître 031
comme migration courante sans affaiblir ses assertions d'upgrade historique.

- [ ] **Step 6: Versionner et valider**

Passer la spec de `1.1.0` à `1.1.1`, documenter les deux correctifs et lancer :

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test \
  tests/execution-intent.test.ts \
  tests/execution-intent-migration.test.ts \
  tests/execution-intent-producer.test.ts \
  tests/execution-intent.repository.test.ts \
  tests/websocket-health-migration.test.ts
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
npm run docs:check
npm run deployment:smoke
```

Expected: zéro échec, zéro test PostgreSQL silencieusement omis et le mutant
post-purge ne peut plus être réclamé.

## Critères de sortie de #51-B

- migration 031 compatible base vide et replay ;
- identité stable réutilisant `openCommandId`/`closeCommandId` sans les modifier ;
- ledger live distinct, sans FK cascade vers paper ;
- claim durable avec lease, fencing et temps PostgreSQL ;
- transitions append-only et erreurs typées/redacted ;
- rétention uniquement quatre heures après terminalisation réconciliée ;
- mapper pur présent mais non composé ;
- listener/API/CLI paper inchangés et toujours incapables de signer/envoyer ;
- aucun mode, secret, wallet, builder, simulation ou soumission ajouté ;
- validation complète et trois cycles de revue maximum.

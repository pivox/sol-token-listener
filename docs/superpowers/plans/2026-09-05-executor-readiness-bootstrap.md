# Executor Readiness Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire une commande Mainnet one-shot, non signante et à autorité minimale, qui collecte puis persiste atomiquement les preuves publiques nécessaires au préflight H2c.

**Architecture:** Un domaine fermé construit les identités déterministes et vérifie l'attestation fournisseur. Un client RPC en lecture seule collecte un snapshot finalisé, puis un repository PostgreSQL dédié enregistre génération et snapshots dans une transaction unique. Le CLI ne reçoit jamais de secret Solana et ne produit qu'un manifeste canonique redacted.

**Tech Stack:** TypeScript strict ESM, Node.js 22, `@solana/web3.js`, `@solana/spl-token`, Ed25519 `node:crypto`, PostgreSQL 16/`pg`, `node:test` via `tsx`.

---

## Structure des fichiers

- `src/domain/execution-readiness.ts` : génération déterministe et manifeste public.
- `src/domain/execution-provider-attestation.ts` : enveloppe Ed25519 fournisseur fermée.
- `src/executor-readiness/config.ts` : configuration dédiée et interdiction des secrets/live.
- `src/executor-readiness/rpc-gateway.ts` : cinq méthodes RPC publiques finalisées.
- `src/ports/execution-readiness-repository.ts` : port du commit atomique.
- `src/storage/execution-readiness.repository.ts` : transaction PostgreSQL rejouable.
- `src/executor-readiness/database.ts` : pool et validation de l'autorité effective.
- `src/executor-readiness/service.ts` : orchestration collecte/validation/commit.
- `src/executor-readiness/main.ts` : CLI one-shot et sortie redacted.
- `scripts/provision-executor-roles.sql` : rôle `sol_token_executor_readiness` fermé.
- `tests/execution-readiness*.test.ts` : contrats domaine, RPC, service, DB et repository.

### Task 1: Domaine déterministe et attestation fournisseur

**Files:**
- Create: `src/domain/execution-readiness.ts`
- Create: `src/domain/execution-provider-attestation.ts`
- Test: `tests/execution-readiness.test.ts`
- Test: `tests/execution-provider-attestation.test.ts`

- [ ] **Step 1: Écrire les tests rouges du domaine**

Tester que `createExecutionWalletGeneration` accepte uniquement les clés exactes, calcule `execution_wallet_generation_<sha256>` par encodage length-prefixed, est sensible aux quatre champs causaux et refuse les clusters/genesis/générations invalides. Tester que `createExecutionReadinessManifest` ne contient que le schéma V1, les identités, chaînes décimales et statuts non exécutés.

- [ ] **Step 2: Vérifier l'échec attendu**

Run: `npx tsx --test tests/execution-readiness.test.ts`

Expected: FAIL avec `ERR_MODULE_NOT_FOUND` pour `execution-readiness.js`.

- [ ] **Step 3: Implémenter les constructeurs minimaux**

Exposer les signatures suivantes avec objets gelés, clés exactes et erreurs typées sans donnée d'entrée :

```ts
export function createExecutionWalletGeneration(input: unknown): WalletGenerationDraftV1;
export function createExecutionReadinessManifest(input: unknown): ExecutionReadinessManifestV1;
export class ExecutionReadinessValidationError extends TypeError {
  readonly code = 'INVALID_EXECUTION_READINESS_INPUT';
}
```

Le hash utilise successivement `length:utf8-bytes` pour `execution-wallet-generation-v1`, public key, cluster, genesis et génération décimale.

- [ ] **Step 4: Écrire les tests rouges de l'attestation**

Générer une paire Ed25519 en mémoire, signer le JSON canonique exact d'un `ProviderUsageSnapshotInputV1`, puis vérifier succès, altération, mauvaise clé, provider divergent, mesure future, expiration, provenance et fenêtre maximale de cinq/quinze minutes.

- [ ] **Step 5: Implémenter le vérificateur minimal**

```ts
export function verifySignedProviderUsageEvidence(
  envelope: unknown,
  publicKeySpkiDerBase64: string,
  expectedProviderId: string,
  nowMs: number,
): ProviderUsageSnapshotV1;
```

L'enveloppe possède exactement `schemaVersion`, `payload`, `signatureBase64`; le payload JSON transforme les unités décimales en `bigint`, appelle `createProviderUsageSnapshot`, puis vérifie la signature Ed25519 sur la représentation canonique avant de retourner le snapshot.

- [ ] **Step 6: Passer les tests et committer**

Run: `npx tsx --test tests/execution-readiness.test.ts tests/execution-provider-attestation.test.ts`

Expected: PASS.

Commit: `feat: add deterministic readiness evidence domain (#51)`

### Task 2: Configuration fermée et collecte RPC finalisée

**Files:**
- Create: `src/executor-readiness/config.ts`
- Create: `src/executor-readiness/rpc-gateway.ts`
- Test: `tests/executor-readiness-config.test.ts`
- Test: `tests/executor-readiness-rpc.test.ts`

- [ ] **Step 1: Écrire les tests rouges de configuration**

Construire un environnement minimal puis vérifier que `parseExecutionReadinessConfig` exige Mainnet, genesis attendu, URL HTTPS, public key, provider, génération, chemin absolu, timeout et lag 0–8. Vérifier que toute propriété dont le nom correspond à `PRIVATE_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|LIVE_TRADING_ENABLED|EXECUTOR_MODE` est refusée même vide.

- [ ] **Step 2: Implémenter le parseur exact**

```ts
export interface ExecutionReadinessConfig {
  readonly databaseUrl: string;
  readonly cluster: 'mainnet-beta';
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly providerId: string;
  readonly walletPublicKey: string;
  readonly generationNumber: number;
  readonly evidencePublicKeyBase64: string;
  readonly providerEvidencePath: string;
  readonly maximumSlotLag: number;
  readonly rpcTimeoutMs: number;
}
export function parseExecutionReadinessConfig(input: unknown): ExecutionReadinessConfig;
```

- [ ] **Step 3: Écrire les tests rouges du transport RPC**

Avec un `fetch` factice, vérifier l'ordre et les seules méthodes autorisées : `getGenesisHash`, `getSlot`, `getBlockTime`, `getBalance`, deux `getTokenAccountsByOwner`. Couvrir genesis divergent, commitment non finalisé, contexte divergent, timeout, 429, réponse >1 MiB, JSON inconnu et comptes SPL/Token-2022.

- [ ] **Step 4: Implémenter le gateway en lecture seule**

```ts
export interface ReadinessWalletObservationV1 {
  readonly slot: bigint;
  readonly blockTimeMs: number | null;
  readonly observedAtMs: number;
  readonly walletLamports: bigint;
  readonly tokenBalanceCount: number;
}
export class SolanaReadinessRpcGateway {
  verifyGenesis(signal: AbortSignal): Promise<void>;
  observeWallet(walletPublicKey: string, maximumSlotLag: number,
    signal: AbortSignal): Promise<ReadinessWalletObservationV1>;
}
```

Chaque nombre financier est converti en `bigint` à partir d'un entier JSON sûr ou d'une chaîne décimale validée ; aucun solde token détaillé ne sort du gateway.

- [ ] **Step 5: Passer les tests et committer**

Run: `npx tsx --test tests/executor-readiness-config.test.ts tests/executor-readiness-rpc.test.ts`

Expected: PASS.

Commit: `feat: add bounded readiness RPC collection (#51)`

### Task 3: Commit PostgreSQL atomique et rejouable

**Files:**
- Create: `src/ports/execution-readiness-repository.ts`
- Create: `src/storage/execution-readiness.repository.ts`
- Test: `tests/execution-readiness.repository.test.ts`

- [ ] **Step 1: Écrire les tests rouges d'intégration**

Sur PostgreSQL 16 migré, tester un bootstrap neuf, un replay exact, une autre génération active, une génération retirée, un snapshot divergent, la supersession provider et une faute injectée avant commit ne laissant aucune ligne partielle.

- [ ] **Step 2: Définir le port atomique**

```ts
export interface ExecutionReadinessCommitV1 {
  readonly generation: WalletGenerationDraftV1;
  readonly walletSnapshot: WalletSnapshotDraftV1;
  readonly providerSnapshot: ProviderUsageSnapshotV1;
}
export interface ExecutionReadinessRepository {
  commit(input: ExecutionReadinessCommitV1): Promise<ExecutionReadinessCommitV1>;
}
```

- [ ] **Step 3: Implémenter une transaction unique**

Utiliser `BEGIN`, un advisory lock de génération, validation/insertion de `execution_wallet_generations` et `execution_wallet_risk_state`, `appendWalletSnapshotInTransaction`, advisory lock provider, `appendProviderUsageInTransaction`, puis `COMMIT`. Sur toute erreur : `ROLLBACK`, release et erreur fermée `ExecutionReadinessRepositoryError`.

- [ ] **Step 4: Passer les tests et committer**

Run: `npx tsx --test tests/execution-readiness.repository.test.ts`

Expected: PASS sur PostgreSQL 16, ou SKIP explicite si `TEST_DATABASE_URL` est absent.

Commit: `feat: persist readiness evidence atomically (#51)`

### Task 4: Rôle PostgreSQL dédié et validation au checkout

**Files:**
- Create: `src/executor-readiness/database.ts`
- Modify: `scripts/provision-executor-roles.sql`
- Create: `tests/executor-readiness-database.test.ts`
- Modify: `tests/executor-roles.test.ts`

- [ ] **Step 1: Écrire les tests rouges du rôle**

Vérifier PostgreSQL 16 exact, login membre unique `ADMIN FALSE, INHERIT FALSE, SET TRUE`, rôle NOLOGIN/NOINHERIT sans parent ni privilège direct, migration 039 et allowlist effective. Prouver l'absence de lecture/écriture sur intentions, qualifications, armements, locks, bytes signés, soumissions et contrôles opérateur.

- [ ] **Step 2: Ajouter le provisioning idempotent**

Révoquer d'abord toute autorité du rôle puis accorder seulement : usage `public`, lecture migrations/génération/risque/positions/snapshots ciblés, insert génération/risque/snapshots, update de la seule colonne `superseded_at`, et séquences strictement nécessaires.

- [ ] **Step 3: Implémenter le pool validé**

À chaque checkout exécuter `SET ROLE sol_token_executor_readiness`, `SET search_path = pg_catalog, public`, confirmer `session_replication_role=origin`, puis comparer l'ensemble exact des privilèges aux attentes. Éjecter la connexion en cas d'écart.

- [ ] **Step 4: Passer les tests et committer**

Run: `npx tsx --test tests/executor-readiness-database.test.ts tests/executor-roles.test.ts`

Expected: PASS PostgreSQL 16 et replay du script sans changement.

Commit: `feat: provision least-privilege readiness role (#51)`

### Task 5: Service et CLI one-shot non signants

**Files:**
- Create: `src/executor-readiness/service.ts`
- Create: `src/executor-readiness/main.ts`
- Create: `tests/executor-readiness-service.test.ts`
- Create: `tests/executor-readiness-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Écrire les tests rouges du service**

Vérifier l'ordre genesis, observation wallet, lecture bornée de l'attestation, vérification, création des snapshots à révision zéro, commit atomique, puis manifeste. Toute erreur avant commit produit zéro appel repository ; toute erreur repository ne produit aucun manifeste.

- [ ] **Step 2: Implémenter le service**

```ts
export interface ExecutionReadinessService {
  collect(signal: AbortSignal): Promise<ExecutionReadinessManifestV1>;
}
export function createExecutionReadinessService(
  dependencies: ExecutionReadinessServiceDependencies,
): ExecutionReadinessService;
```

Le service force `openPositions=[]`, `realizedNetPnlRaw=0n`, `stateRevision=0n` et utilise l'heure injectée ; il n'accepte aucun signer ou constructeur de transaction.

- [ ] **Step 3: Écrire puis implémenter les tests CLI**

Tester stdout exactement égal au manifeste JSON avec `bigint` convertis en décimal, stderr exactement `EXECUTION_READINESS_FAILED\n` et code non nul en erreur, fichier d'attestation limité à 128 KiB, fermeture DB et abort SIGTERM.

- [ ] **Step 4: Ajouter les scripts**

Ajouter `executor:readiness:dev` vers `tsx src/executor-readiness/main.ts` et `executor:readiness:start` vers `node dist/src/executor-readiness/main.js`.

- [ ] **Step 5: Passer les tests et committer**

Run: `npx tsx --test tests/executor-readiness-service.test.ts tests/executor-readiness-cli.test.ts`

Expected: PASS.

Commit: `feat: add non-signable readiness bootstrap CLI (#51)`

### Task 6: Architecture, configuration sûre et exploitation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/execution-runtime-architecture.test.ts`
- Modify: `tests/executor-deployment-smoke.test.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `docs/superpowers/specs/2026-09-05-executor-readiness-bootstrap-design.md`
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`

- [ ] **Step 1: Ajouter les tests d'architecture rouges**

Parcourir source et `dist` H2d et refuser les imports/lexèmes keypair, signer, transaction builder, simulation, soumission, H2a/H2b, live operations et secrets. Vérifier que les images de déploiement n'embarquent ni wallet ni attestation et que seul le binaire readiness est inventorié.

- [ ] **Step 2: Documenter le protocole opérateur**

Versionner la spec H2d et ses parents ; documenter configuration publique, rôle dédié, commande one-shot, schéma du manifeste, statut `CANARY_NOT_STARTED`, rétention quatre heures et interdiction de convertir le wallet avant le checkpoint humain.

- [ ] **Step 3: Mettre à jour la configuration exemple**

Ajouter uniquement des placeholders sûrs ; ne mettre aucun endpoint réel, clé, phrase, adresse financée ou contenu d'attestation dans Git.

- [ ] **Step 4: Passer les contrôles ciblés et committer**

Run: `npm run docs:check && npx tsx --test tests/execution-runtime-architecture.test.ts tests/executor-deployment-smoke.test.ts`

Expected: PASS.

Commit: `docs: integrate readiness bootstrap operations (#51)`

### Task 7: Vérification intégrale et livraison PR H2d

**Files:**
- Modify only if verification exposes a defect in files above.

- [ ] **Step 1: Vérifier la base vide et le replay**

Run: appliquer `migrations/001_*.sql` à `039_*.sql`, puis `scripts/provision-executor-roles.sql` deux fois sur le candidat PostgreSQL 16.

Expected: deux exécutions réussies, aucun privilège supplémentaire.

- [ ] **Step 2: Lancer tous les gates locaux**

Run: `npm run build && npm run check && npm run lint && npm test && npm run docs:check && npm run frontend:e2e`

Expected: toutes les commandes retournent 0.

- [ ] **Step 3: Vérifier les artefacts et le diff**

Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`

Expected: aucun secret, endpoint réel, wallet ou modification hors H2d.

- [ ] **Step 4: Pousser et ouvrir la PR**

Créer une PR séparée liée à #51, limitée à `READINESS_EVIDENCE_COLLECTED`, sans déclencher `live:resume`, `live:arm` ou le canary.

- [ ] **Step 5: Effectuer exactement trois cycles de revue**

Pour chaque cycle : demander la revue Codex, attendre la fin, inspecter tous les threads, corriger seulement les défauts confirmés, relancer les gates concernés et pousser. Après le troisième cycle vert et CI verte, fusionner la PR puis actualiser `origin/main` sans modifier le `main` local divergent.

- [ ] **Step 6: Conserver le checkpoint de sécurité**

Le résultat final H2d est `READINESS_EVIDENCE_COLLECTED / CANARY_NOT_STARTED`. Le wallet reste au format générateur, non chargé et non converti ; l'attestation H2c et le dernier checkpoint humain restent les étapes suivantes.

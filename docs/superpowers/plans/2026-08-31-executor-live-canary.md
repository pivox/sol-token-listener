# Executor Live Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer #51-G avec un exécutable live isolé, désactivé et non armé par défaut, capable de signer, persister avant envoi, soumettre une fois, confirmer et réconcilier un canary Pump.fun BUY puis SELL.

**Architecture:** Le listener ne produit que des intentions neutres derrière un flag inactif. Un nouveau graphe `executor-live` est seul autorisé à charger le keypair et à appeler un port de soumission exact-byte. PostgreSQL sérialise armement, artefact signé, soumission, position et autorisation de sortie sous le verrou de génération partagé avec #51-E/#51-F.

**Tech Stack:** TypeScript strict ESM, Node.js, PostgreSQL, `@solana/web3.js` 1.98.4, SDK officiels Pump.fun/PumpSwap épinglés, `node:test`, RPC local scripté.

**Normative design:** `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md` version 1.0.3, parent version 1.7.3.

---

### Task 1: Fermer le domaine et la migration live 036

**Files:**
- Create: `src/domain/execution-live.ts`
- Create: `migrations/036_execution_live_canary.sql`
- Create: `src/ports/execution-live-repository.ts`
- Test: `tests/execution-live.test.ts`
- Test: `tests/execution-live-migration.test.ts`

- [x] **Step 1: Write the failing domain tests**

Tester des artefacts gelés et fermés, les états signés, les positions,
autorisations de sortie, reason codes append-only et fingerprints
déterministes. L'API souhaitée est :

```ts
const artifact = createSignedTransactionArtifact({
  payloadVersion: 1,
  intentId,
  attemptNumber: 1,
  generationId,
  armamentId,
  exitAuthorizationId: null,
  providerId: 'primary',
  walletPublicKey,
  effectiveVenue: 'PUMP_FUN',
  messageHash,
  buildFingerprint,
  snapshotFingerprint,
  quoteFingerprint,
  blockhash,
  lastValidBlockHeight: 42n,
  signature,
  signedTransactionBytes: bytes,
  signedAtMs: 1_000,
});
assert.equal(artifact.signedTransactionHash, sha256(bytes));
assert.throws(() => createSignedTransactionArtifact({ ...input, signedTransactionBytes: new Uint8Array(1_233) }));
```

- [x] **Step 2: Run the domain test and verify RED**

Run: `npx tsx --test tests/execution-live.test.ts`

Expected: FAIL because `src/domain/execution-live.ts` does not exist.

- [x] **Step 3: Implement the minimal closed domain**

Define exact unions:

```ts
export type SignedTransactionState =
  | 'PERSISTED' | 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED'
  | 'ACCEPTED' | 'AMBIGUOUS' | 'CONFIRMED' | 'RECONCILED'
  | 'REVOKED_NO_SEND';
export type LivePositionState = 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'UNKNOWN';
export type ExitAuthorizationState = 'ACTIVE' | 'LOCKED' | 'CONSUMED' | 'REVOKED';
```

Valider les records par propriétés propres, sans proxy/accessor, copier les
bytes dans un `Uint8Array`, borner u64 et dates, puis geler chaque résultat.

- [x] **Step 4: Run the domain test and verify GREEN**

Run: `npx tsx --test tests/execution-live.test.ts`

Expected: PASS.

- [x] **Step 5: Write migration tests and verify RED**

Exiger les quatre tables de la spec, les enums fermés, `BYTEA` <= 1232, les
FK vers intention/tentative/armement/génération, les triggers de garde, le
verrou `hashtextextended(generation_id, 51005)`, les index uniques actifs,
l'absence de float/JSON financier et le replay sur PostgreSQL vide.

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/execution-live-migration.test.ts`

Expected: FAIL because migration 036 is absent.

- [x] **Step 6: Implement migration 036 and port repository**

Créer :

```sql
execution_signed_transactions
execution_submission_events
execution_live_positions
execution_exit_authorizations
```

Les triggers refusent tout insert signé sans tentative `STARTED`, tout BUY sans
armement `LOCKED`, tout SELL sans autorisation `LOCKED`, et tout état aval sans
événement correspondant. Les identités sont immuables. Ajouter au port des
commandes fermées `persistSigned`, `recordSignedSimulation`,
`beginSubmission`, `recordSubmissionOutcome`, `recordConfirmation`,
`commitReconciliation`, `createDeadlineExitIntent`.

- [x] **Step 7: Run migration/domain tests and commit**

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/execution-live.test.ts tests/execution-live-migration.test.ts`

Expected: PASS.

```bash
git add src/domain/execution-live.ts src/ports/execution-live-repository.ts migrations/036_execution_live_canary.sql tests/execution-live.test.ts tests/execution-live-migration.test.ts
git commit -m "feat: define live execution ledger (#51)"
```

### Task 2: Charger le secret et fermer la configuration live

**Files:**
- Create: `src/executor-live/config.ts`
- Create: `src/executor-live/keypair-loader.ts`
- Create: `src/ports/execution-transaction-signer.ts`
- Modify: `.env.example`
- Test: `tests/executor-live-config.test.ts`
- Test: `tests/executor-live-keypair.test.ts`

- [x] **Step 1: Write keypair/config failing tests**

Tester l'absence de valeurs implicites, les deux flags exacts, mainnet/genesis,
WSOL seul, chemin absolu, symlink, mauvais mode, propriétaire, taille/JSON,
clé dérivée divergente et redaction. L'API souhaitée :

```ts
const config = parseLiveExecutorConfig(environment);
const signer = await loadLiveTransactionSigner(config, filesystem);
assert.equal(signer.publicKey, config.executorPublicKey);
await signer.close();
```

- [x] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/executor-live-config.test.ts tests/executor-live-keypair.test.ts`

Expected: FAIL because live config and loader are absent.

- [x] **Step 3: Implement minimal config and loader**

Utiliser `open(path, O_RDONLY | O_NOFOLLOW)`, puis `handle.stat()`. Refuser tout
fichier non régulier, `uid !== process.getuid()`, `(mode & 0o077) !== 0`, taille
hors borne ou JSON non canonique. Importer la seed Ed25519, comparer la clé
publique et écraser les buffers dans `finally`. L'implémentation utilise
un `KeyObject` Ed25519 natif opaque afin de ne pas conserver un tableau secret
accessible dans un objet `Keypair`. Le port n'expose que :

```ts
export interface ExecutionTransactionSigner {
  readonly publicKey: string;
  signMessage(messageBytes: Uint8Array): Promise<Readonly<{
    signature: Uint8Array;
  }>>;
  close(): Promise<void>;
}
```

- [x] **Step 4: Run tests and commit**

Run: `npx tsx --test tests/executor-live-config.test.ts tests/executor-live-keypair.test.ts`

Expected: PASS.

```bash
git add .env.example src/executor-live/config.ts src/executor-live/keypair-loader.ts src/ports/execution-transaction-signer.ts tests/executor-live-config.test.ts tests/executor-live-keypair.test.ts
git commit -m "feat: load isolated executor keypair safely (#51)"
```

### Task 3: Produire et simuler la transaction signée exacte

**Files:**
- Create: `src/executor-simulation/message-compiler.ts`
- Create: `src/executor-live/transaction-preparer.ts`
- Create: `src/executor-live/signed-simulation-gateway.ts`
- Create: `src/ports/execution-live-gateway.ts`
- Modify: `src/executor-simulation/solana-simulation-gateway.ts`
- Test: `tests/executor-live-preparer.test.ts`
- Test: `tests/executor-live-signed-simulation.test.ts`
- Modify: `tests/executor-simulation-gateway.test.ts`

- [x] **Step 1: Write compiler/preparer failing tests**

À partir d'un plan inspecté et d'un reçu opaque, exiger le même message hash,
blockhash, limites et transaction zéro-signature que #51-D. Le candidat live
doit être consommable une fois et rester inaccessible au gateway simulation-only.

- [x] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/executor-live-preparer.test.ts`

Expected: FAIL because the live preparer is absent.

- [x] **Step 3: Extract the pure compiler and implement the live preparer**

Extraire sans modifier les validations #51-D :

```ts
compileInspectedV0Message({
  feePayer,
  instructions,
  recentBlockhash,
  maximumTransactionBytes: 1_232,
})
```

Le préparateur réutilise le pipeline quote/route/build existant, obtient la
simulation non signée et retourne uniquement un candidat opaque au worker live.
Le gateway #51-D continue de ne retourner aucun byte.

- [x] **Step 4: Verify simulation-only compatibility**

Run: `npx tsx --test tests/executor-simulation-gateway.test.ts tests/executor-simulation-attempt-evaluator.test.ts tests/executor-live-preparer.test.ts`

Expected: PASS.

- [x] **Step 5: Write signed simulation failing tests**

Exiger `sigVerify=true`, `replaceRecentBlockhash=false`, bytes identiques à
l'artefact, signature valide, deltas identiques ou plus conservateurs et zéro
appel d'envoi.

- [x] **Step 6: Implement signed simulation and commit**

Le port accepte un artefact authentifié relu, jamais un `VersionedTransaction`
mutable. Il désérialise, recalcule hashes/signature, simule et retourne une
preuve fermée.

Run: `npx tsx --test tests/executor-live-preparer.test.ts tests/executor-live-signed-simulation.test.ts tests/executor-simulation-gateway.test.ts`

Expected: PASS.

```bash
git add src/executor-simulation/message-compiler.ts src/executor-simulation/solana-simulation-gateway.ts src/executor-live/transaction-preparer.ts src/executor-live/signed-simulation-gateway.ts src/ports/execution-live-gateway.ts src/ports/execution-live-repository.ts tests/executor-live-preparer.test.ts tests/executor-live-signed-simulation.test.ts
git commit -m "feat: prepare and verify signed transactions (#51)"
```

### Task 4: Persister et verrouiller atomiquement avant envoi

**Files:**
- Create: `src/storage/execution-live.repository.ts`
- Modify: `src/ports/execution-live-repository.ts`
- Test: `tests/execution-live.repository.test.ts`
- Modify: `tests/execution-live-repository-contract.test.ts`

- [x] **Step 1: Write PostgreSQL concurrency tests and verify RED**

Tester deux BUY concurrents, armement expiré/révoqué, qualification périmée,
`ENTRY_STOP`, `HARD_STOP`, risque inconnu, quota supplanté, réservation absente,
lease perdu et replay exact. Le gagnant unique doit produire dans une même
transaction `LOCKED`, l'artefact et `SIGNED_NOT_SUBMITTED`.

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/execution-live.repository.test.ts`

Expected: FAIL because the repository is absent.

- [x] **Step 2: Implement the atomic repository**

Acquérir `pg_advisory_xact_lock(hashtextextended(generation_id, 51005))`,
verrouiller les lignes dans un ordre fixe, relire l'heure PostgreSQL et ne
persister les bytes qu'après toutes les validations. Les opérations retournent
des records domaine, jamais les rows brutes.

- [x] **Step 3: Verify crash/replay and commit**

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/execution-live.repository.test.ts tests/execution-operations.repository.test.ts tests/execution-risk.repository.test.ts`

Expected: PASS.

```bash
git add src/storage/execution-live.repository.ts src/ports/execution-live-repository.ts tests/execution-live.repository.test.ts tests/execution-live-repository-contract.test.ts docs/superpowers/specs/2026-08-31-executor-live-canary-design.md docs/superpowers/specs/2026-08-30-executor-v1-design.md
git commit -m "feat: persist signed execution atomically (#51)"
```

### Task 5: Soumettre uniquement les bytes persistés

**Files:**
- Create: `src/executor-live/submission-gateway.ts`
- Create: `src/executor-live/execution-worker.ts`
- Test: `tests/executor-live-submission-gateway.test.ts`
- Test: `tests/executor-live-execution-worker.test.ts`

- [x] **Step 1: Write exact-byte transport failing tests**

Tester l'ordre `persist -> signed simulate -> beginSubmission -> RPC`, les
options `skipPreflight=true`, `maxRetries=0`, la signature retournée exacte,
timeout/429/réponse divergente et absence de nouvel appel pour des bytes
différents.

- [x] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/executor-live-submission-gateway.test.ts tests/executor-live-execution-worker.test.ts`

Expected: FAIL because transport and worker are absent.

- [x] **Step 3: Implement gateway and worker**

Le gateway reçoit :

```ts
submitPersisted(
  artifact: AuthenticatedPersistedSignedTransaction,
  signal: AbortSignal,
): Promise<Readonly<{ signature: string }>>
```

Le worker fait échouer fermé toute anomalie pré-signature. Après
`SUBMISSION_STARTED`, toute erreur non prouvée sans dispatch enregistre
`AMBIGUOUS`, `UNKNOWN_REQUIRES_RECONCILIATION` et `UNKNOWN_HELD`.

- [x] **Step 4: Run tests and commit**

Run: `npx tsx --test tests/executor-live-submission-gateway.test.ts tests/executor-live-execution-worker.test.ts`

Expected: PASS.

```bash
git add src/executor-live/submission-gateway.ts src/executor-live/execution-worker.ts tests/executor-live-submission-gateway.test.ts tests/executor-live-execution-worker.test.ts
git commit -m "feat: submit persisted transaction bytes once (#51)"
```

### Task 6: Confirmer, réconcilier et autoriser la sortie

**Files:**
- Create: `src/executor-live/confirmation-worker.ts`
- Create: `src/executor-live/reconciliation-worker.ts`
- Create: `src/executor-live/deadline-exit.service.ts`
- Modify: `src/executor-risk/reconciliation-service.ts`
- Test: `tests/executor-live-confirmation.test.ts`
- Test: `tests/executor-live-reconciliation.test.ts`
- Test: `tests/executor-live-deadline-exit.test.ts`

- [x] **Step 1: Write confirmation/reconciliation failing tests**

Tester confirmed puis finalized `MATCHED`, `NO_EFFECT` après hauteur expirée,
reorg, absence courante, mismatch et provider indisponible. Vérifier qu'un BUY
MATCHED crée position + autorisation de sortie, et qu'un SELL MATCHED ferme les
deux et consomme l'armement canary.

- [x] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/executor-live-confirmation.test.ts tests/executor-live-reconciliation.test.ts`

Expected: FAIL because workers are absent.

- [x] **Step 3: Implement priority workers**

Le runtime traite dans cet ordre : réconciliation, confirmation, SELL,
deadline SELL, puis BUY. Chaque observation est provider-affine, bornée et
committée via le repository #51-E/#51-G.

- [x] **Step 4: Write and implement deadline exit TDD**

À `openedAtMs + maximumHoldingMs`, créer une seule intention :

```ts
logicalCommandId = `maximum-holding:${positionId}`;
reasonCode = 'MAXIMUM_HOLDING_REACHED';
side = 'SELL';
venuePolicy = 'CANONICAL_EXIT';
baseAmountRaw = authorizedBaseAmountRaw;
```

Le replay et deux workers concurrents retrouvent la même intention.

- [x] **Step 5: Run tests and commit**

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/executor-live-confirmation.test.ts tests/executor-live-reconciliation.test.ts tests/executor-live-deadline-exit.test.ts`

Expected: PASS.

```bash
git add src/executor-live/confirmation-worker.ts src/executor-live/reconciliation-worker.ts src/executor-live/deadline-exit.service.ts src/executor-risk/reconciliation-service.ts tests/executor-live-confirmation.test.ts tests/executor-live-reconciliation.test.ts tests/executor-live-deadline-exit.test.ts
git commit -m "feat: reconcile canary entries and exits (#51)"
```

### Task 7: Composer l'émission neutre sans capacité live dans le listener

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/application/execution-intent-producer.ts`
- Modify: `src/storage/paper-mvp.repository.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Create: `tests/execution-intent-emission.integration.test.ts`

- [ ] **Step 1: Write disabled-default and atomic emission tests**

Avec le flag absent/false, aucune table executor n'est ouverte. Avec le flag
true en mode paper, la transition source et l'intention déterministe sont
persistées sans doublon. `observe`, une qualification obsolète ou un événement
orphaned refusent l'émission.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/bootstrap-safety.test.ts tests/execution-intent-emission.integration.test.ts`

Expected: FAIL because production composition is absent.

- [ ] **Step 3: Implement the neutral projection**

Ajouter `executionIntentEmissionEnabled: boolean` avec défaut `false`. Injecter
un sink optionnel dans le commit paper, dériver depuis l'événement canonique
déjà verrouillé et utiliser le repository d'intention sans aucun import
`executor-live`, signer, keypair ou transport.

- [ ] **Step 4: Run tests and commit**

Run: `TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/bootstrap-safety.test.ts tests/execution-intent-emission.integration.test.ts tests/execution-intent-producer.test.ts`

Expected: PASS.

```bash
git add src/config/env.ts src/application/production-listener-factory.ts src/application/execution-intent-producer.ts src/storage/paper-mvp.repository.ts tests/bootstrap-safety.test.ts tests/execution-intent-emission.integration.test.ts
git commit -m "feat: project inert live execution intents (#51)"
```

### Task 8: Intégrer le binaire, les rôles, la rétention et le runbook

**Files:**
- Create: `src/executor-live/main.ts`
- Create: `src/executor-live/runtime.ts`
- Modify: `package.json`
- Modify: `scripts/provision-executor-roles.sql`
- Modify: `scripts/purge-retained-data.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Create: `docs/operations/executor-live-canary.md`
- Modify: `README.md`
- Modify: `.env.example`
- Create: `tests/executor-live-main.integration.test.ts`
- Modify: `tests/executor-architecture.test.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/execution-risk-retention.test.ts`

- [ ] **Step 1: Write runtime/architecture failing tests**

Exiger l'ordre prioritaire réconciliation -> confirmation -> SELL -> deadline
-> BUY, shutdown borné, fermeture/effacement signer, graphe source/dist isolé,
rôles sans accès public aux bytes et rétention ne supprimant jamais un cas
ambigu.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/executor-live-main.integration.test.ts tests/executor-architecture.test.ts tests/executor-roles-provisioning.test.ts tests/execution-risk-retention.test.ts`

Expected: FAIL because live entrypoint and grants are absent.

- [ ] **Step 3: Implement runtime and operational wiring**

Ajouter :

```json
{
  "executor:live:start": "node dist/src/executor-live/main.js"
}
```

Le bootstrap valide toute la configuration et le schéma avant de charger le
secret. Il ne modifie jamais `ENTRY_STOP` et ne crée aucun armement. Le runbook
documente préflight, resume, armement TTY, démarrage, status, kill switches,
réconciliation, arrêt et constat du canary.

- [ ] **Step 4: Run targeted integration and commit**

Run: `npm run build && TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npx tsx --test tests/executor-live-main.integration.test.ts tests/executor-architecture.test.ts tests/executor-roles-provisioning.test.ts tests/execution-risk-retention.test.ts`

Expected: PASS with a local scripted RPC and no external submission.

```bash
git add src/executor-live package.json scripts/provision-executor-roles.sql scripts/purge-retained-data.ts scripts/deployment-smoke.mjs docs/operations/executor-live-canary.md README.md .env.example tests/executor-live-main.integration.test.ts tests/executor-architecture.test.ts tests/executor-roles-provisioning.test.ts tests/execution-risk-retention.test.ts
git commit -m "feat: wire isolated live canary executor (#51)"
```

### Task 9: Vérification finale et livraison PR

**Files:**
- Modify: `docs/superpowers/plans/2026-08-31-executor-live-canary.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md` only for review clarifications with patch version bumps

- [ ] **Step 1: Run all quality gates**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm test
npm run deployment:validate-images
git diff --check
```

Expected: every command exits 0; backend and frontend report zero failures.

- [ ] **Step 2: Verify safety inventory**

```bash
rg -n "Keypair|sendRawTransaction|signed_transaction_bytes" src dist
rg -n "EXECUTOR_KEYPAIR_PATH|PRIVATE_KEY|SECRET_KEY" . --glob '!node_modules/**' --glob '!dist/**'
```

Expected: live capability exists only in the allowlisted `executor-live`
boundary; no secret value is tracked; listener/dry-run/simulation-only remain
free of live imports.

- [ ] **Step 3: Open PR and run at most three review cycles**

Push `feat/issue-51g-canary-execution`, open one PR referencing #51 and state
explicitly that #49 is non-executed, live defaults off and no canary was sent.
Request GitHub review at most three times. Apply each cycle with TDD, version
spec patches for normative changes, resolve threads and never start a fourth
cycle.

- [ ] **Step 4: Merge only after green CI and zero unresolved threads**

Verify `quality`, `frontend-e2e`, `deployment-contract`, merge state `CLEAN`,
and zero unresolved review threads. Merge normally without bypassing branch
protection.

- [ ] **Step 5: Prepare, but do not auto-run, the manual canary**

Generate the exact preflight checklist and stop before `live:resume` /
`live:arm` unless the operator has supplied the dedicated wallet, provider,
fresh signed evidence, maximum lamports and explicit final arm command.

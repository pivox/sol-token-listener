# Executor Live Operator Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Rendre le canary CANARY mono-BUY explicitement ciblé et armable sans
charger de secret avant qu'un intent exact, son admission et sa réservation ne
soient durablement valides, puis verrouiller cette autorité avant la signature.

**Architecture:** Le processus opérations vérifie deux attestations Ed25519
hors ligne et persiste en une transaction snapshots, admission, réservation et
armement V2. H2b reste le seul graphe signable ; son claim BUY est ciblé et son
gate `BEFORE_SIGNING` effectue le CAS durable. Un pre-pass PostgreSQL non
signable révoque tout lock abandonné avant le chargement du keypair et avant
chaque tour des quatre lanes existantes.

**Tech Stack:** TypeScript strict ESM, Node.js, PostgreSQL 16, `pg`,
`@solana/web3.js`, tests `node:test`, ESLint.

---

## Task 1: Contrats CANARY V1/V2 et attestation sidecar

**Files:**

- Create: `src/domain/execution-canary.ts`
- Create: `src/domain/execution-canary-attestation.ts`
- Create: `src/domain/execution-wallet-snapshot.ts`
- Modify: `src/domain/execution-operations.ts`
- Test: `tests/execution-canary.test.ts`
- Test: `tests/execution-canary-attestation.test.ts`
- Test: `tests/execution-wallet-snapshot.test.ts`
- Modify: `tests/execution-operations.test.ts`

**Steps:**

1. Écrire les tests rouges pour un payload sidecar exact, immuable et borné :
   qualification ID/fingerprint, target intent ID, policy V1, wallet snapshot
   V1, provider snapshot V1, `allEndpointsUnavailable=false`, capture et expiry.
2. Tester la vérification Ed25519, le rejet des clés inconnues, base64 non
   canonique, signature erronée, tailles excessives et objets/proxies mutables.
3. Définir le constructeur wallet canonique qui recalcule ID/fingerprint sur
   tous les champs ; l'utiliser au décodage et au repository.
4. Définir `ExecutionCanaryEvidenceV1`, son fingerprint de domaine
   `execution-canary-evidence-v1` et le vérificateur d'enveloppe.
5. Écrire les tests rouges de `ExecutionActivationArmamentV2` et
   `ExecutionArmamentRequestV2`. Le request fingerprint couvre uniquement les
   inputs connus avant TTY : qualification, target complet, policy/snapshots,
   limites de phase et limites runtime, timestamps, opérateur et raison.
6. Implémenter les constructeurs stricts ; conserver la validation et la
   reconstruction V1 pour les lignes historiques terminales.
7. Exécuter les tests domain ciblés avec `node --test --import tsx`.

## Task 2: Confirmation TTY et CLI d'armement exact

**Files:**

- Modify: `src/executor-operations/config.ts`
- Modify: `src/executor-operations/terminal.ts`
- Modify: `src/executor-operations/service.ts`
- Modify: `src/executor-operations/main.ts`
- Modify: `src/ports/execution-operations-repository.ts`
- Modify: `tests/execution-operations-config.test.ts`
- Modify: `tests/execution-operator-terminal.test.ts`
- Modify: `tests/execution-operations.service.test.ts`
- Modify: `tests/execution-operations-cli.test.ts`

**Steps:**

1. Conserver le parser opérations commun pour les commandes existantes et
   ajouter un parser arm-only. Tester les nouvelles variables publiques :
   sidecar absolu, lease, quote age, slippage, lag, compute, fee, débit fee
   payer et budget RPC. Réutiliser exactement les bornes H2b et interdire toute
   variable secret. Pour CANARY, refuser un lease supérieur à 120 000 ms dans
   les configs opérations et H2b.
2. Tester la commande `live:arm --intent-id --maximum-lamports --holding-ms
   --reason`, sans valeur permissive et sans option de bypass.
3. Tester une autorisation opérateur V2 et sa phrase TTY complète contenant
   version, wallet non tronqué, target,
   mint, quote mint, montants, expiry, request fingerprint et nonce ; le détail
   préalable contient policy/snapshots et limites runtime.
4. Faire vérifier le sidecar par le CLI, relire qualification et intent via le
   service, contrôler la correspondance des gates snapshot et exiger au moins
   `2 * leaseMs` sur l'expiry effective. Celle-ci est le minimum des expirations
   qualification/intent/sidecar/provider, de `providerMeasuredAt +
   providerUsageMaxAgeMs` et de `walletObservedAt + walletSnapshotMaxAgeMs`.
5. Produire l'autorisation V2 (`payloadVersion=2`, domaine de hash V2) avec
   `contextFingerprint=armamentRequestFingerprint`, puis transmettre une
   commande atomique au repository. Afficher après commit armament, admission et
   reservation IDs sans annoncer de capacité live validée.
6. Exécuter les quatre fichiers de test ciblés.
   Le cap du fichier enveloppe et celui du payload décodé sont distincts et
   testés afin d'accepter l'encodage base64 sans dépasser les bornes.

## Task 3: Migration 039 et admission/armement atomiques

**Files:**

- Create: `migrations/039_execution_canary_operator_binding.sql`
- Modify: `src/storage/execution-risk.repository.ts`
- Modify: `src/storage/execution-operations.repository.ts`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `src/ports/execution-operations-repository.ts`
- Create: `tests/execution-canary-migration.test.ts`
- Modify: `tests/execution-risk-admission.test.ts`
- Modify: `tests/execution-operations.repository.test.ts`
- Modify: `tests/execution-operations-migration.test.ts`
- Modify: `tests/migration-lock.test.ts`

**Steps:**

1. Écrire les tests rouges migration vide, rejeu, upgrade 038 -> 039, V1
   terminal accepté et V1 `ARMED|LOCKED` refusé.
2. Ajouter les colonnes V2 listées par la spec, contraintes exactes, FKs,
   immutable trigger, `payload_version` discriminant, reason code
   système fermé et rétention quatre heures. Créer aussi
   `execution_pre_signature_locks` avec bytes non signés executor-only, machine
   `AUTHORIZED|SIGNED_PERSISTED|REVOKED` et unicités causales.
   Étendre les autorisations avec une branche V2 et les événements de contrôle
   avec `actor_type`, acteur/source causale et CHECK système strictement borné.
3. Extraire les primitives transactionnelles d'append wallet/provider et
   `admitBuyInTransaction(client,input)` du repository risque ; garder les
   méthodes publiques comme wrappers transactionnels. Le repository opérations
   doit appeler `ExecutionAdmissionService` via un adaptateur transaction-bound.
4. Écrire les tests rouges PostgreSQL de l'opération unique : verrou SELL puis
   génération, target PENDING non louée, qualification/sidecar/snapshots frais,
   append des snapshots, admission ADMITTED, réservation et armement V2.
5. Implémenter l'armement atomique. Tout rejet ou conflit doit laisser zéro
   armement, rapport, réservation, compteur provider et delta d'exposition.
6. Tester le rejeu exact, deux armements concurrents, snapshot supplanté,
   admission rejetée, quote non WSOL et target divergente.
7. Exécuter les tests ciblés avec PostgreSQL 16 réel via `TEST_DATABASE_URL`.

## Task 4: Claim BUY ciblé et lock durable avant signature

**Files:**

- Modify: `src/ports/execution-intent-repository.ts`
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `src/ports/execution-live-repository.ts`
- Modify: `src/ports/execution-live-runtime-repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `src/executor-live/fresh-execution.ts`
- Modify: `src/executor-live/transaction-preparer.ts`
- Modify: `src/executor-simulation/attempt-evaluator.ts`
- Modify: `tests/execution-intent-repository-contract.test.ts`
- Modify: `tests/execution-intent.repository.test.ts`
- Modify: `tests/execution-live.repository.test.ts`
- Modify: `tests/executor-live-fresh-execution.test.ts`
- Modify: `tests/executor-live-preparer.test.ts`
- Modify: `tests/executor-simulation-attempt-evaluator.test.ts`

**Steps:**

1. Ajouter `generationId` au claim `LIVE_EXECUTE` BUY et tester qu'il ne claim
   que le target d'un armement V2 ARMED
   avec admission/réservation exactes, en conservant priorité SELL et
   `READ COMMITTED`; aucun autre BUY n'est loué.
2. Étendre le boundary `BEFORE_SIGNING` pour fournir les bytes du message et de
   la transaction non signée ainsi que leurs identités, sans exposer le signer.
3. Remplacer pour BUY la lecture de préparation par
   `authorizeExactSigning`. Tester target revision `+1`, tentative 1, lease,
   runtime, snapshots, quota et expirations restantes `>= leaseMs`.
4. Implémenter dans une transaction le lock `AUTHORIZED`, le CAS
   `ARMED -> LOCKED`, `consumed_buys=1`, champs de lock et événement. Le retour
   n'a lieu qu'après commit et la capability retourne les bytes persistés.
5. Modifier `transaction-preparer` pour signer exclusivement les bytes de la
   capability ; SELL conserve son gate existant sans lock BUY.
6. Modifier `persistSigned` : exiger le lock exact, comparer bytes/message et
   fingerprints, passer le lock à `SIGNED_PERSISTED` et ne plus muter
   l'armement.
   Comparer séparément le snapshot wallet de réservation au target armement et
   le snapshot marché de l'artefact à la simulation non signée.
7. Tester deux workers concurrents, même lease rejoué, autre lease refusé, crash
   après lock, signature jamais appelée si le commit échoue et persistance
   uniquement sous le lock exact.
8. Exécuter les fichiers de test ciblés avec PostgreSQL réel.

## Task 5: Reprise des locks abandonnés et startup sans secret

**Files:**

- Modify: `src/ports/execution-live-repository.ts`
- Modify: `src/ports/execution-live-runtime-repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `src/executor-live/database.ts`
- Modify: `src/executor-live/startup-validator.ts`
- Modify: `src/executor-live/runtime.ts`
- Modify: `src/executor-live/main.ts`
- Modify: `src/executor-live/error-codes.ts`
- Modify: `tests/executor-live-startup.test.ts`
- Modify: `tests/executor-live-main.integration.test.ts`
- Modify: `tests/executor-live-runtime.test.ts`
- Modify: `tests/execution-live-revocation.repository.test.ts`

**Steps:**

1. Tester le pre-pass sans signer : lock sans artefact et lease absent/expiré
   devient atomiquement REVOKED, tentative ABANDONED, intent FAILED/no-send,
   réservation RELEASED, exposition décrémentée et contrôle ENTRY_STOP avec
   raison système. HARD_STOP n'est jamais abaissé.
   Les chemins stop/resume/expiration du repository opérations ne doivent plus
   terminaliser seuls un armement LOCKED ; ils utilisent la même clôture
   couplée ou refusent si une preuve signée/ambiguë exige la reprise normale.
2. Tester qu'un lock avec lease vivant d'une autre instance échoue fermé et
   qu'un artefact existant reste exclusivement dans la reprise H2b normale.
3. Exécuter le pre-pass avant `loadSigner`, puis avant chaque tour des quatre
   lanes sans créer une cinquième lane.
4. Ajouter le probe de travail lié au runtime : target V2 signable, sortie
   ouverte/autorisation SELL ou artefact persisté. Sans travail, fermer la DB et
   retourner un code redacted sans charger le signer ni ouvrir de session RPC.
5. Tester tous les crash boundaries pré-lock, post-lock/pré-signature,
   post-signature/pré-persist, post-persist et post-`SUBMISSION_STARTED`.
6. Tester que toute soumission ambiguë et toute réconciliation inconnue
   inscrivent atomiquement le contrôle système `ENTRY_STOP`, sans abaisser un
   `HARD_STOP` ni révoquer les capacités de sortie nécessaires.
7. Exécuter les tests ciblés avec PostgreSQL réel.

## Task 6: Rôles, runbook et frontières d'architecture

**Files:**

- Modify: `scripts/provision-executor-roles.sql`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`
- Modify: `docs/superpowers/specs/2026-09-04-executor-live-signable-runtime-design.md`
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/executor-architecture.test.ts`
- Modify: `tests/deployment-smoke.test.ts`

**Steps:**

1. Tester d'abord les ACL exactes : opérations peut écrire uniquement les
   colonnes requises pour l'admission/armement ; live peut verrouiller/révoquer
   mais pas armer/resume ; recovery H2a, listener et API ne gagnent aucune
   autorité ni bytes.
2. Ajouter au processus opérations le wrapper `SET ROLE
   sol_token_executor_operations`, la validation de `current_user`,
   `session_user`, search path et réplication, avec éviction sur incohérence.
3. Mettre à jour provisioning, catalogue 039, smoke et inventaires source/dist.
4. Versionner les specs parentes sans réécrire leurs historiques. Documenter
   l'état `READY_FOR_EXTERNAL_PREFLIGHT`, jamais PASS.
5. Réécrire le runbook étape par étape : émission paper temporaire, sélection
   target, arrêt émission, sidecar/preflight, resume, arm exact, H2a, H2b,
   monitoring, ENTRY_STOP/HARD_STOP et collecte de preuve.
6. Garder `.env.example` désarmé : observe/paper par défaut, aucune URL réelle,
   aucun chemin keypair utilisable, aucun montant canary réel.
7. Exécuter les tests architecture/rôles/smoke et `npm run docs:check`.

## Task 7: Validation finale et livraison PR

**Steps:**

1. Exécuter dans un environnement propre : `npm run build`, `npm run check`,
   `npm run lint`, `npm test`, `npm run docs:check`, `git diff --check`.
2. Exécuter les suites PostgreSQL H2c sous les rôles provisionnés sur PostgreSQL
   16 réel et vérifier migration 039 depuis une base vide et depuis 038.
3. Vérifier qu'aucun test, fixture ou documentation ne contient secret, endpoint
   Mainnet réel ou commande d'envoi, et qu'aucun test n'appelle le réseau.
4. Demander une revue locale spécification puis qualité, corriger les findings
   bloquants et rejouer les gates concernées.
5. Pousser la branche, ouvrir une PR liée à #51, demander `@codex review` et
   traiter au maximum trois cycles. Fusionner uniquement avec CI verte, zéro
   thread bloquant et preuves locales fraîches.

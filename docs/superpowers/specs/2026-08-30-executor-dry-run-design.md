# Exécuteur dry-run V1 — conception #51-C

**Version de spécification :** 1.0.1

**Date :** 2026-08-30

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-B fusionnée par la PR #70

## Historique des versions

- **1.0.1 — 2026-08-31 :** ajout du rejet explicite de la variable privée
  listener `SOLANA_PRIVATE_KEY_BASE58` et définition de l'annulation aux
  frontières de statements pendant l'arrêt.
- **1.0.0 — 2026-08-30 :** conception initiale approuvée de l'évaluation annexe
  non consommatrice. Les brouillons antérieurs n'ont jamais été publiés.

## 1. Objectif et preuve produite

#51-C livre un processus executor séparé qui réclame temporairement les
intentions durables et persiste une évaluation dry-run déterministe. Il valide :

- le démarrage d'un processus indépendant du listener ;
- le claim concurrent, le lease, le fencing et la libération atomique ;
- l'idempotence après perte d'accusé de réception ;
- la reprise après crash et après expiration d'un lease ;
- la fermeture propre sans wallet, RPC, signature ou soumission.

Il ne valide ni marché ni transaction Solana. Une évaluation réussie porte :

```text
outcome = FOUNDATION_VALIDATED
coverage = INTENT_AND_LEASE_ONLY
quote_status = NOT_RUN
build_status = NOT_RUN
simulation_status = NOT_RUN
signature_status = NOT_RUN
submission_status = NOT_RUN
```

Cette évaluation n'est jamais présentée comme un `PASS` de trading. Les gates
de quote, build, simulation et sortie restent `NOT_EVALUATED` jusqu'à #51-D.

## 2. Invariant de non-consommation

Le dry-run ne doit pas modifier la machine d'état métier de l'intention :

- seules les intentions `PENDING` et `RETRY_READY` sont éligibles ;
- leur statut, `attempt_count`, `state_revision`, `last_reason_code` et journal
  de transitions restent inchangés ;
- aucune ligne `execution_attempts` ou `execution_intent_transitions` n'est
  créée ;
- `beginAttempt()`, `finishAttempt()` et `transition()` ne sont jamais appelées ;
- après l'évaluation, la même intention reste disponible pour #51-D.

`SIMULATED` conserve son sens existant : une simulation Solana réellement
réussie et justifiée par `SIMULATION_SUCCEEDED`. Aucun nouveau reason code
positif n'est introduit dans #51-C.

Le lease est un verrou technique temporaire, pas une transition métier. Le
claim renseigne uniquement `lease_owner`, `lease_token` et `lease_expires_at`.
Le commit de l'évaluation efface ces trois champs dans la même transaction.

## 3. Processus et configuration

Le point d'entrée ESM est `src/executor/main.ts`. Il compose uniquement la
configuration executor, le logger executor, le worker, les repositories
PostgreSQL et le cycle de vie Node.

Configuration V1 :

```dotenv
EXECUTOR_MODE=dry-run
EXECUTOR_POLL_MS=1000
EXECUTOR_LEASE_MS=30000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=10000
LIVE_TRADING_ENABLED=false
DATABASE_URL=
```

Règles :

- seule la valeur canonique `dry-run` est admise ;
- `LIVE_TRADING_ENABLED` doit être absent ou égal à `false` ;
- les durées sont des entiers décimaux canoniques : poll entre 100 et 60 000
  ms, lease entre 3 000 et 300 000 ms, timeout PostgreSQL entre 100 et 10 000
  ms, et grâce d'arrêt entre 1 000 et 60 000 ms ;
- `poll < lease`, `dbStatementTimeout <= lease / 3` et
  `dbStatementTimeout + 1 000 <= shutdownGrace` ;
- le lease initial couvre toute la passe pure ; #51-C ne le renouvelle jamais ;
- `DATABASE_URL` est obligatoire mais n'est jamais journalisée ;
- une valeur non vide dans `EXECUTOR_PRIVATE_KEY`, `EXECUTOR_SECRET_KEY`,
  `EXECUTOR_KEYPAIR`, `EXECUTOR_KEYPAIR_PATH`, `SOLANA_PRIVATE_KEY`,
  `SOLANA_PRIVATE_KEY_BASE58`, `SOLANA_SECRET_KEY`, `SOLANA_KEYPAIR`,
  `SOLANA_KEYPAIR_PATH`,
  `WALLET_PRIVATE_KEY`, `WALLET_KEYPAIR`, `WALLET_KEYPAIR_PATH` ou
  `ANCHOR_WALLET` fait échouer le bootstrap ;
- aucune URL RPC Solana n'est nécessaire dans #51-C.

L'identifiant propriétaire est généré au démarrage, éphémère et non secret.
La boucle est single-flight par processus. Plusieurs processus peuvent
coexister grâce à `FOR UPDATE SKIP LOCKED` et au fencing par lease token et
`state_revision`.

## 4. Claim, commit et reprise

### 4.1 Claim

Le port des intentions ajoute le but fermé `DRY_RUN`. Son SQL :

1. utilise l'horloge PostgreSQL tronquée à la milliseconde ;
2. sélectionne une intention `PENDING|RETRY_READY` dont l'échéance est
   strictement postérieure à la fin du lease demandé et dont le lease est
   absent ou expiré ;
3. exclut une intention possédant déjà une ligne d'évaluation pour
   `evaluator_version = 1`, qu'elle soit cohérente ou contradictoire ;
4. ordonne par `requested_at, id` ;
5. verrouille avec `FOR UPDATE SKIP LOCKED` ;
6. pose owner, token UUID et expiration sans changer `state_revision`.

Le décodage hostile et les invariants existants de
`PostgresExecutionIntentRepository` restent la source unique de validation de
l'intention réclamée.

### 4.2 Commit atomique

`ExecutionDryRunRepository.complete()` ouvre une transaction et :

1. verrouille l'intention par `id` ;
2. vérifie statut initial, lease owner/token, expiration du lease,
   `expires_at > PostgreSQL now`, `state_revision` et toutes les données
   immuables utilisées par le fingerprint ;
3. insère l'évaluation ; une collision de clé ou de fingerprint échoue fermée ;
4. libère le lease avec le même fencing ;
5. commit les deux mutations ensemble.

Le résultat est `RECORDED`. Une ligne déjà présente, un fingerprint différent,
un lease perdu, une intention expirée ou une reprise ABA échouent de manière
fermée. Aucun renouvellement n'existe dans le chemin #51-C ; une passe qui ne
termine pas dans le lease initial est abandonnée et récupérable après expiration.

Après une erreur de commit ambiguë, le worker appelle séparément
`findExact(intentId, evaluatorVersion, fingerprints)`, en lecture seule et sans
lease. Une correspondance exacte prouve le commit ; une absence laisse le lease
expirer avant reprise ; une ligne contradictoire échoue fermée. Après crash du
processus, aucun replay actif n'est nécessaire : le claim suivant exclut la
ligne durable par `NOT EXISTS`.

### 4.3 Matrice de crash

| Frontière | État durable | Reprise attendue |
| --- | --- | --- |
| avant claim | aucun lease | un worker peut réclamer |
| après claim | lease seul | attente ou reprise après expiration |
| avant commit | lease seul | aucune évaluation partielle |
| commit interrompu | tout ou rien | reprise après expiration si rollback |
| commit réussi, ACK perdu | évaluation + lease libéré | `findExact` prouve le commit ; un autre claim est exclu |
| arrêt pendant traitement | lease éventuellement actif | arrêt borné, puis expiration récupérable |

Au premier `SIGINT` ou `SIGTERM`, le runtime déclenche son `AbortSignal` interne
avant d'attendre la passe single-flight. Le worker observe ce signal avant le
claim, immédiatement après la résolution du claim et avant toute récupération
`findExact`. Une annulation déjà demandée avant le claim retourne `IDLE` sans
statement. Une annulation observée après la résolution du claim et avant
`complete` retourne aussi `IDLE`, ne lance ni `complete`, ni `findExact`, ni
release, renewal, tentative ou transition, et laisse le lease expirer
naturellement.

Chaque vérification d'annulation et l'invocation synchrone du statement suivant
appartiennent au même tour JavaScript : aucun handler de signal ne peut
s'intercaler entre les deux. Un signal reçu pendant un `complete` déjà en vol
ne tente pas de l'annuler ; le runtime attend son issue. Un succès durable reste
`RECORDED`. Si son issue est un commit ambigu après l'annulation, le worker
retourne `IDLE` sans lancer `findExact`, car ce dernier serait un nouveau
statement après le signal. Un seul statement PostgreSQL peut donc être en vol
après l'arrêt. Claim, `findExact` et commit atomique sont chacun un statement
unique. Le pool impose côté client
`query_timeout` et côté serveur `statement_timeout`, tous deux égaux à
`EXECUTOR_DB_STATEMENT_TIMEOUT_MS`; lock et connexion sont également bornés par
une valeur au plus égale. Une erreur ou un timeout évince la connexion.

Le runtime attend l'issue du statement existant avant de fermer le pool. Les
timeouts sont strictement inférieurs à `EXECUTOR_SHUTDOWN_GRACE_MS`. Si la pile
réseau ne rend malgré ces deux timeouts, le point d'entrée évince le client,
journalise un arrêt non propre et termine non-zéro à l'échéance. La transaction
atomique et le timeout serveur empêchent un état partiel ; un commit intervenu
avant l'annulation reste une évaluation durable valide, sans autoriser une
lecture `findExact` pendant cet arrêt. Aucune nouvelle mutation n'est initiée
après le signal ou après perte du lease.

## 5. Évaluation durable

La migration 032 ajoute `execution_dry_run_assessments` :

```text
assessment_id
payload_version = 1
specification_version = 1.4.0
evaluator_version = 1
intent_id
strategy_id
strategy_version
decision_fingerprint
intent_state_revision
intent_status
input_fingerprint
result_fingerprint
outcome = FOUNDATION_VALIDATED
coverage = INTENT_AND_LEASE_ONLY
quote_status = NOT_RUN
build_status = NOT_RUN
simulation_status = NOT_RUN
signature_status = NOT_RUN
submission_status = NOT_RUN
recorded_at
```

La clé `(intent_id, evaluator_version)` est unique. `intent_id` référence
`execution_intents(id)` avec `ON DELETE CASCADE`. Le statut capturé est limité
à `PENDING|RETRY_READY`; `intent_state_revision` est un `BIGINT` positif ou nul.
`strategy_id`, `strategy_version` et `decision_fingerprint` sont conservés
explicitement et doivent correspondre à la ligne parente verrouillée.

`assessment_id`, `input_fingerprint` et `result_fingerprint` sont des SHA-256
hexadécimaux minuscules. Chaque préimage est la concaténation de segments UTF-8
dans l'ordre indiqué ; chaque segment est précédé de sa longueur non signée sur
quatre octets big-endian. Les nombres utilisent leur représentation décimale
canonique sans signe ni zéro initial. Le nullable numérique ou reason code
utilise le segment littéral `~` lorsqu'il est nul.

`assessment_id` est la clé primaire textuelle :

```text
"execution_dry_run_assessment_" + sha256([
  "execution-dry-run-assessment-id-v1",
  intent.id,
  decimal(evaluatorVersion)
])
```

`input_fingerprint = sha256([...])` avec cet ordre exact :

```text
execution-dry-run-input-v1
evaluatorVersion
intent.id
intent.payloadVersion
intent.logicalOrderKey
intent.strategyId
intent.strategyVersion
intent.positionId
intent.logicalCommandId
intent.mint
intent.side
intent.venuePolicy
intent.quoteMint
intent.quoteTokenProgram
intent.quoteDecimals
intent.quoteAmountRaw | ~
intent.baseAmountRaw | ~
intent.minimumAmountOutRaw
intent.decisionEventId
intent.decisionFingerprint
intent.requestedAtMs
intent.expiresAtMs
intent.status
intent.attemptCount
intent.stateRevision
intent.lastReasonCode | ~
```

`result_fingerprint = sha256([...])` avec cet ordre exact :

```text
execution-dry-run-result-v1
inputFingerprint
specificationVersion
evaluatorVersion
outcome
coverage
quoteStatus
buildStatus
simulationStatus
signatureStatus
submissionStatus
```

`recorded_at`, issu de PostgreSQL, n'entre dans aucune identité déterministe.

Les contraintes PostgreSQL limitent toutes les valeurs fermées aux littéraux
ci-dessus. La lecture refuse les colonnes manquantes, supplémentaires, types
inattendus, dates non canoniques et fingerprints invalides.

L'évaluation ne contient ni URL, wallet, signature, transaction, secret,
payload arbitraire ou preuve de marché. Elle n'est pas exposée par l'API
publique dans #51-C.

## 6. Rétention

Une évaluation suit la durée de vie de son intention. La purge explicite
supprime `execution_dry_run_assessments` avant les transitions, tentatives et
intentions de la cohorte terminale déjà éligible selon les invariants #51-B.

La suppression par cascade reste une défense supplémentaire, pas le mécanisme
silencieux principal. Les tombstones anti-rejeu existants ne sont pas modifiés
et survivent à la purge de l'intention conformément à #51-B.

## 7. Frontières de code

- `src/domain/execution-dry-run.ts` : types fermés, fingerprints et assertions ;
- `src/ports/execution-dry-run-repository.ts` : commit atomique de l'évaluation ;
- `src/storage/execution-dry-run.repository.ts` : PostgreSQL et fencing ;
- `src/ports/execution-intent-repository.ts` : but de claim `DRY_RUN` ;
- `src/storage/execution-intent.repository.ts` : claim éligible non évalué ;
- `src/executor/config.ts` : configuration fermée et expurgée ;
- `src/executor/dry-run-worker.ts` : claim, évaluation et commit sans renouvellement ;
- `src/executor/runtime.ts` : polling single-flight, signaux et fermeture ;
- `src/executor/main.ts` : point d'entrée ESM minimal ;
- `src/executor/logger.ts` : logs structurés `sol-token-executor` ;
- `migrations/032_execution_dry_run_assessments.sql` : table annexe ;
- `src/storage/database.ts` : rétention explicite de l'évaluation.

Le listener n'importe aucun fichier `src/executor`. L'executor #51-C n'importe
aucun fichier `src/execution`, adaptateur Solana, SDK, RPC, wallet ou builder.

## 8. Sécurité et observabilité

Des tests du graphe d'import source et compilé refusent depuis
`src/executor/main.ts` :

- `@solana/web3.js`, `@solana/spl-token` et les SDK Pump ;
- `Keypair`, wallet, signer, secret loader ou chemin de keypair ;
- transaction builder, `simulateTransaction`, `sendTransaction` et
  `sendRawTransaction` ;
- tout import du listener ou de `src/execution`.

Les logs n'exposent que l'événement fixe, le mode, l'intent ID déterministe,
le côté, l'outcome et un code d'erreur stable. Les objets d'erreur, URLs,
credentials, montants, mint et contenu de décision ne sont pas journalisés.

L'executor n'accepte aucun contrôle depuis l'API publique. #51-C ne charge
aucun secret et ne possède aucune capacité réseau autre que PostgreSQL.

## 9. Tests et critères d'acceptation

- configuration dry-run et rejet de live, secrets et valeurs ambiguës ;
- évaluation et fingerprints déterministes, y compris aux bornes `bigint` ;
- preuve que statut, tentative, révision et transition restent inchangés ;
- claim concurrent sans double traitement ;
- exclusion d'une évaluation déjà enregistrée ;
- preuve en lecture d'un commit ambigu et rejet d'un conflit immuable ;
- expiration/reprise du lease, perte de lease et ABA fail-closed ;
- absence de renouvellement #51-C et non-régression des renewals
  `CONFIRM|RECONCILE` existants après `expires_at` ;
- atomicité évaluation/libération sur PostgreSQL réel ;
- perte d'ACK après commit sans seconde évaluation ;
- migration 032 sur base vide, upgrade depuis 031 et replay ;
- purge explicite de l'évaluation avec la cohorte exacte ;
- signaux, polling non chevauché et fermeture bornée du pool ;
- architecture source et artefacts compilés sans capacité Solana ;
- `npm run executor:start` fonctionne avec PostgreSQL, sans RPC ni wallet ;
- build, check, lint, docs et tests complets verts.

La réussite de #51-C prouve uniquement le socle dry-run déterministe. Les gates
de quote, build, simulation, sortie et Mainnet restent `NOT_EVALUATED` jusqu'aux
PR suivantes. La rentabilité et la performance de la stratégie restent hors
périmètre de toute la série #51.

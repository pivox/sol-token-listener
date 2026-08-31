# Exécution live et canary Executor V1 — conception #51-G

**Version de spécification :** 1.0.1

**Version de la spécification parente :** 1.7.1

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-F fusionnée par la PR #74

## Historique des versions

- **1.0.1 — 2026-08-31 :** distingue le cycle live du cycle
  `simulation-only` terminal de #51-D : la tentative live reste `STARTED` et la
  persistance atomique journalise `PROCESSING -> SIMULATED ->
  SIGNED_NOT_SUBMITTED` avec la preuve non signée liée à l'artefact.
- **1.0.0 — 2026-08-31 :** conception initiale du graphe live fermé, du
  chargement de secret, de la persistance avant envoi, de la soumission exacte,
  de la confirmation, de la réconciliation et du canary manuel minimal.

## 1. Décision

#51-G introduit la première capacité de signature et de soumission du projet.
Elle réside dans un nouvel exécutable `executor-live`, séparé du listener, de
l'API, du paper, du dry-run, de `simulation-only` et des commandes opérateur.
Ces graphes restent incapables de charger un secret, signer ou envoyer.

```text
listener observe/paper
  -> projection optionnelle d'intentions neutres, désactivée par défaut
  -> PostgreSQL
  -> executor-live fermé, désactivé par défaut
  -> admission + quote + build + simulation non signée
  -> verrouillage atomique de l'armement
  -> signature locale + persistance des bytes exacts
  -> simulation signée exacte
  -> revalidation transactionnelle finale
  -> soumission des seuls bytes persistés
  -> confirmation confirmed
  -> réconciliation finalized
  -> SELL autorisé et clôture technique du canary
```

L'existence du binaire ne constitue pas un armement. Le démarrage live exige
simultanément une configuration explicite, un secret local sûr et tous les
états durables #51-E/#51-F. L'armement reste une décision opérateur distincte.
Aucun test automatisé et aucune CI ne contacte une méthode de soumission
Mainnet réelle.

Le paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Le canary ne prouve
ni rentabilité, ni sellabilité générale, ni sécurité future.

## 2. Approches évaluées

| Approche | Décision | Motif |
| --- | --- | --- |
| Nouvel exécutable live fermé | Retenue | Préserve l'incapacité structurelle des graphes existants et rend le secret, les bytes signés et le transport auditables. |
| Ajouter `live` à l'exécutable simulation-only | Rejetée | Transformerait un graphe explicitement non signable en capacité irréversible et affaiblirait les preuves #51-D. |
| Signer distant ou HSM dès la V1 | Reportée | Bonne évolution, mais ajoute protocole, disponibilité et autorité hors du canary minimal. Le port de signature permet cette substitution future. |

## 3. Périmètre

### 3.1 Inclus

- composition optionnelle du producteur d'intentions neutres dans le listener
  paper, derrière `EXECUTION_INTENT_EMISSION_ENABLED=false` ;
- nouvel entrypoint et nouveau graphe `src/executor-live/` ;
- configuration live fermée et sans valeur permissive implicite ;
- chargeur local de keypair à chemin absolu, fichier régulier non symlink,
  propriétaire du processus et permissions maximales `0600` ;
- signature locale d'un message v0 inspecté avec exactement un signer ;
- artefact signé executor-only persisté avant tout appel d'envoi ;
- simulation avec `sigVerify=true` des bytes exacts persistés ;
- revalidation atomique de qualification, contrôle, armement, risque, quota,
  génération, intention et tentative immédiatement avant soumission ;
- soumission idempotente des bytes persistés, confirmation `confirmed`, puis
  réconciliation `finalized` sur le provider épinglé ;
- autorisation de sortie et position live durables ;
- SELL Pump.fun ou PumpSwap canonique, y compris demande déterministe à la
  deadline de détention ;
- consommation/révocation de l'armement, kill switches et reprise après crash ;
- rétention quatre heures après réconciliation, sans purge des états ouverts,
  ambigus ou non finalisés ;
- tests unitaires, PostgreSQL, intégration RPC locale et architecture.

### 3.2 Exclus

- armement automatique, financement ou création automatique du wallet ;
- stockage d'un secret, seed ou keypair dans `.env`, PostgreSQL ou Git ;
- route HTTP publique d'opération ;
- support live multi-wallet, USDC/USDT, Raydium CPMM ou ALT ;
- rotation de clé avec position ouverte ;
- retry avec un nouveau blockhash après une soumission ambiguë ;
- promotion automatique CANARY vers MICRO_LIVE ou PILOT ;
- exécution réelle pendant les tests, la CI ou la fusion de la PR ;
- déclaration de réussite du canary sans BUY et SELL finalisés et réconciliés.

## 4. Activation fail-closed

Le binaire live accepte uniquement :

```dotenv
EXECUTOR_MODE=live
LIVE_TRADING_ENABLED=true
EXECUTOR_PUBLIC_KEY=<base58>
EXECUTOR_KEYPAIR_PATH=<chemin absolu hors dépôt>
EXECUTOR_RPC_PROVIDER_ID=<identifiant positionnel>
SOLANA_HTTP_RPC_URL=<endpoint mainnet-beta>
SOLANA_EXPECTED_GENESIS_HASH=<hash mainnet-beta>
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
```

Les deux premières valeurs sont toutes deux obligatoires. Elles ne suffisent
jamais à autoriser une dépense. Le démarrage vérifie aussi :

- keypair de 64 octets JSON canoniques, sans nombre non entier ;
- clé publique dérivée égale à `EXECUTOR_PUBLIC_KEY` ;
- fichier ouvert sans suivre de symlink, régulier, propriétaire du processus,
  sans bit groupe/autres et taille bornée ;
- cluster exactement `mainnet-beta` et genesis hash attendu ;
- génération wallet active correspondant au keypair ;
- configuration, build et stratégie correspondant à l'armement ;
- rôle PostgreSQL executor et schéma 036 disponibles.

Le chemin n'est jamais inclus dans les logs ou erreurs. Le buffer lu et le
secret temporaire sont écrasés dans un `finally`. Le keypair reste uniquement
dans la mémoire du processus live et n'est exposé que par un port de signature
minimal. Un signal d'arrêt empêche toute nouvelle signature et laisse la
réconciliation durable reprendre au redémarrage.

## 5. Frontières d'architecture

- `src/app.ts`, l'API, paper, listener, `src/executor/` et
  `src/executor-operations/` n'importent jamais `src/executor-live/` ;
- seul `src/executor-live/keypair-loader.ts` importe `Keypair` ;
- seul `src/executor-live/transaction-signer.ts` reçoit le signer vivant ;
- seul `src/executor-live/submission-gateway.ts` possède une méthode d'envoi ;
- le gateway n'accepte ni plan, ni transaction mutable, ni keypair : seulement
  un artefact signé authentifié et relu depuis PostgreSQL ;
- le listener peut persister une intention neutre mais ne lit jamais
  l'armement, le secret ou les artefacts live ;
- les rôles API/public/operator read-only n'accèdent ni aux bytes signés, ni
  aux détails wallet live ;
- les tests d'intégration injectent un transport RPC local fermé. La chaîne
  `mainnet-beta` et une URL publique sont explicitement interdites dans les
  helpers de test.

## 6. Préparation et signature

Le pipeline live réutilise les adaptateurs purs, la sélection de venue, les
maths, le plan officiel et l'inspection #51-D. La compilation du message est
extraite dans un module pur partagé ; `simulation-only` continue à recevoir
uniquement une preuve et ne reçoit jamais les bytes ou l'objet transaction.

Une autorité opaque locale lie une fois : intention, tentative, snapshot,
quote, plan inspecté, message, blockhash et limites. Le candidat live n'est
utilisable que dans le même processus et la même tentative. Aucun plan ou
fingerprint fourni par la base ne permet de fabriquer une transaction.

Séquence BUY avant signature :

Contrairement à la commande `simulation-only`, le cycle live ne clôture ni la
tentative ni l'intention après la simulation non signée. La preuve est portée
jusqu'au commit live ; sous un même verrou, ce commit journalise les deux
transitions et conserve la tentative `STARTED` pour la soumission et la
réconciliation.

1. claim fenced de l'intention et création d'une tentative `STARTED` ;
2. snapshot wallet/provider finalisé et `admitBuy()` #51-E ;
3. quote, build et simulation non signée sur provider épinglé ;
4. transaction PostgreSQL sous le verrou advisory de génération ;
5. relecture de la qualification fraîche, du contrôle `RUNNING`, de
   l'armement `ARMED`, du risque, du quota et de la réservation ;
6. CAS `ARMED -> LOCKED`, incrément de `consumed_buys` et liaison exclusive à
   l'intention/tentative ;
7. signature locale du message exact ;
8. insertion atomique de l'artefact signé et transition
   `SIMULATED -> SIGNED_NOT_SUBMITTED` avec `SIGNATURE_PERSISTED`.

Si l'étape 8 échoue ou reste indéterminée, aucun envoi n'est permis avant une
relecture exacte. La signature seule n'est pas considérée comme un effet
on-chain, mais les bytes persistés sont une capacité et restent protégés.

Un SELL exige une autorisation de sortie active, la quantité réconciliée de la
position, la même génération et l'absence de `HARD_STOP`. Il ignore
`ENTRY_STOP`, l'expiration de l'armement BUY, le drawdown et les plafonds
d'entrée. Il refait quote, build, inspection et simulations courantes.

## 7. Artefact signé et idempotence

`execution_signed_transactions` contient exactement une ligne par
`(intent_id, attempt_number)` :

```text
artifact_id, payload_version, specification_version
intent_id, attempt_number, generation_id, armament_id, exit_authorization_id
provider_id, wallet_public_key, effective_venue
message_hash, build_fingerprint, snapshot_fingerprint, quote_fingerprint
blockhash, last_valid_block_height, signature
signed_transaction_bytes, signed_transaction_hash
state, state_revision
signed_at, signed_simulated_at, submission_started_at, submitted_at
confirmed_at, reconciled_at, purge_after
```

Les bytes sont `BYTEA`, limités à 1 232 octets et leur SHA-256 est vérifié. La
signature Ed25519 correspond au premier signer du message, au wallet et à la
signature externe calculable depuis les bytes. Les identités sont immuables.

États fermés :

```text
PERSISTED -> SIGNED_SIMULATED -> SUBMISSION_STARTED
SUBMISSION_STARTED -> ACCEPTED | AMBIGUOUS
ACCEPTED -> CONFIRMED -> RECONCILED
PERSISTED | SIGNED_SIMULATED -> REVOKED_NO_SEND
```

Une seule ligne peut être active par intention/tentative. Une soumission ou un
retry charge les bytes depuis PostgreSQL et vérifie à nouveau hash, signature,
wallet, blockhash et état. Il est interdit de reconstruire ou résigner.

`SUBMISSION_STARTED` est persisté avant l'appel RPC. Un crash ou une erreur
après ce point est ambigu par défaut. Tant que le blockhash est valide, seul le
renvoi explicite des mêmes bytes et de la même signature est admissible. Aucun
nouveau blockhash n'est créé pour un BUY ambigu.

## 8. Simulation signée et soumission

Après persistance, les bytes sont relus, désérialisés et simulés avec :

```text
commitment=confirmed
sigVerify=true
replaceRecentBlockhash=false
minContextSlot=snapshotSlot
```

Le message, la signature, les instructions, comptes, montants, frais, compute
units et deltas doivent correspondre à la preuve non signée. Un écart révoque
l'artefact sans envoi et produit un reason code stable.

Immédiatement avant `SUBMISSION_STARTED`, une transaction SQL revalide toutes
les liaisons. Pour un BUY : contrôle `RUNNING`, armement `LOCKED` exact,
qualification fraîche, risque connu, réservation, quota et plafonds. Pour un
SELL : contrôle différent de `HARD_STOP`, autorisation de sortie et quantité
ouverte réconciliée. Les deux exigent wallet, génération, cluster, genesis,
provider, quote, blockhash et lease frais.

Le transport utilise `sendRawTransaction(bytes, {skipPreflight: true,
maxRetries: 0, preflightCommitment: 'confirmed'})`. Le résultat doit égaler la
signature déjà persistée. Une autre signature est une incohérence critique.
Timeout, 429, réponse invalide, crash ou résultat divergent passent
l'intention en `UNKNOWN_REQUIRES_RECONCILIATION`; ils ne déclenchent jamais une
nouvelle transaction.

## 9. Confirmation et réconciliation

Un worker prioritaire réclame `SUBMITTED` et les artefacts `ACCEPTED` ou
`AMBIGUOUS`. Il lit le statut de la signature sur le même provider :

- `confirmed` journalise `SUBMITTED -> CONFIRMED` ;
- timeout ou absence non définitive reste ambiguë ;
- erreur on-chain confirmée passe par réconciliation ;
- aucune absence simple ne devient `NO_EFFECT`.

La réconciliation #51-E utilise ensuite la signature, le blockhash, la hauteur
valide, les fingerprints et plafonds immuables de la tentative. Seule une
preuve `finalized` :

- `MATCHED` applique les deltas réels, termine l'intention et la tentative,
  consomme/libère la réservation et met à jour le capital/position ;
- `NO_EFFECT` après expiration finalisée du blockhash prouve l'absence d'effet
  et libère selon la policy ;
- `MISMATCH` ou `UNKNOWN` conserve `UNKNOWN_HELD`, bloque les BUY et exige une
  intervention.

Le PnL, le montant de position et les frais proviennent uniquement des deltas
réconciliés. La confirmation seule ne rend aucun capital réutilisable.

## 10. Position et autorisation de sortie

`execution_live_positions` contient une position par BUY réconcilié : coût
quote, base reçue, frais, wallet/génération, mint/quote mint, venue d'entrée,
deadline de détention, état `OPEN | EXIT_PENDING | CLOSED | UNKNOWN` et
fingerprints de réconciliation.

`execution_exit_authorizations` est créée atomiquement avec la réconciliation
`MATCHED` du BUY. Elle fixe la quantité base maximale réellement reçue, le
wallet, la génération, le cluster et la position. Elle reste valide jusqu'à
une clôture finalisée ou une révocation explicite sous `HARD_STOP`. Elle ne
peut jamais ouvrir une exposition.

Une décision paper CLOSE produit l'intention SELL canonique. Si aucune décision
n'existe à `opened_at + maximum_holding_ms`, le worker crée une intention SELL
de sécurité déterministe liée à la position et au reason code
`MAXIMUM_HOLDING_REACHED`. La contrainte logique unique rend le réveil et le
restart idempotents. Une seule intention SELL active existe par position.

La clôture est réussie uniquement lorsque le SELL est finalisé, la quantité
restante est nulle selon la policy d'arrondi, aucun résiduel inattendu n'existe
et l'autorisation est `CONSUMED`.

## 11. Armement et canary

Pour `CANARY` :

- exactement un BUY maximal et une position simultanée ;
- exposition maximale 500 bps et plafond lamports fixé manuellement ;
- détention 30 à 900 secondes ;
- `ARMED -> LOCKED` avant la première signature BUY ;
- aucun second BUY, même après crash ou échec ;
- après BUY `MATCHED`, sortie autorisée jusqu'à clôture ;
- après SELL `MATCHED`, `LOCKED -> CONSUMED` et canary terminal ;
- toute ambiguïté conserve l'armement verrouillé et impose `ENTRY_STOP` ;
- aucune promotion automatique.

Un canary n'est techniquement `PASS` que si les deux transactions éventuelles
nécessaires sont finalisées et réconciliées, sans double ordre, résiduel ou
état inconnu. Un BUY refusé, une absence d'opportunité ou une fermeture sans
transaction ne constitue pas un `PASS`.

## 12. PostgreSQL et rétention

La migration 036 ajoute :

- `execution_signed_transactions` ;
- `execution_submission_events` append-only ;
- `execution_live_positions` ;
- `execution_exit_authorizations` ;
- les contraintes, triggers et index nécessaires à la liaison atomique de
  l'armement, de l'intention, de la tentative et de la réconciliation.

Les mutations d'autorité utilisent le même verrou advisory de génération que
#51-E/#51-F. Les triggers SQL refusent une signature sans armement/autorisation,
une soumission sans simulation signée, une transition non journalisée et une
réutilisation de capacité.

Les artefacts, événements, positions closes et autorisations terminales sont
purgés quatre heures après réconciliation finalisée. Les bytes signés ne sont
jamais purgés avant que le blockhash soit irréversiblement expiré et que
l'effet soit `MATCHED` ou `NO_EFFECT`. Les tombstones minimaux de l'ordre
logique restent durables. Aucun état ouvert, ambigu ou inconnu n'est purgé.

## 13. Reason codes append-only

Les codes parent existants restent inchangés. #51-G ajoute :

```text
KEYPAIR_UNAVAILABLE
KEYPAIR_PERMISSIONS_INVALID
SIGNED_SIMULATION_FAILED
SUBMISSION_SIGNATURE_MISMATCH
SUBMISSION_STARTED
MAXIMUM_HOLDING_REACHED
EXIT_AUTHORIZATION_INVALID
CANARY_RECONCILED
```

Les codes ne sont jamais réaffectés. Les erreurs internes restent redacted et
ne remplacent pas un reason code durable lorsqu'un effet peut être ambigu.

## 14. Tests obligatoires

- configuration live absente ou partielle refusée ;
- keypair absent, symlink, mauvais propriétaire, permissions trop larges,
  format invalide et public key mismatch refusés sans fuite ;
- buffers secrets écrasés, aucune sérialisation/log du keypair ;
- architecture source et `dist` isolant tous les imports live ;
- émission d'intentions désactivée par défaut et replay déterministe lorsqu'elle
  est activée en paper ;
- build BUY Pump.fun, SELL Pump.fun et SELL PumpSwap officiel ;
- signature exacte et simulation `sigVerify=true` sur RPC local ;
- bytes et signature persistés avant le premier appel de soumission ;
- crash à chaque frontière, replay exact et aucune double signature logique ;
- timeout/429/réponse invalide après `SUBMISSION_STARTED` deviennent ambigus ;
- aucun nouveau blockhash pour un BUY ambigu ;
- armement absent/expiré/révoqué, `ENTRY_STOP` et `HARD_STOP` ;
- SELL autorisé sous `ENTRY_STOP` mais interdit sous `HARD_STOP` ;
- quota et réservation de sortie protégés ;
- confirmation puis réconciliation finalisée avec deltas réels ;
- deadline de détention créant une seule intention SELL ;
- canary un BUY + un SELL, armement consommé après clôture ;
- migration base vide, replay et upgrade 035 -> 036 ;
- rôles PostgreSQL sans lecture des bytes par listener/API/opérateur ;
- rétention quatre heures et conservation des cas ambigus ;
- aucun test ne peut atteindre un endpoint Mainnet ou une méthode réelle.

## 15. Gates avant canary réel

Après fusion, la capacité reste inactive. Avant tout canary réel, l'opérateur
doit fournir des preuves fraîches pour les onze gates #51-F, puis :

1. déployer le build exact sur un hôte contrôlé ;
2. provisionner le rôle PostgreSQL executor-only ;
3. installer un keypair dédié, faiblement financé, hors dépôt ;
4. fixer manuellement le plafond canary en lamports correspondant au risque
   accepté, sans conversion fiat implicite ;
5. vérifier provider, quota, frais de sortie et genesis hash ;
6. exécuter le preflight sans envoi du binaire déployé ;
7. exécuter `live:resume`, puis `live:arm` depuis un TTY ;
8. démarrer `executor-live` et surveiller état, kill switches et réconciliation ;
9. constater un BUY et un SELL finalisés/réconciliés avant toute conclusion.

Le code et les tests peuvent préparer ces étapes, mais aucune commande ne les
enchaîne automatiquement et aucune PR ne déclenche la transaction réelle.

## 16. Critères d'acceptation

- #51-F reste intact et tous ses graphes restent non signables ;
- le live est désactivé et non armé par défaut ;
- le secret ne quitte jamais le processus live ;
- les bytes exacts sont persistés et authentifiés avant envoi ;
- toute ambiguïté mène à la réconciliation, jamais à un nouvel ordre ;
- BUY et SELL appliquent leurs gates distincts ;
- le canary est borné à un BUY, une position et une sortie ;
- migrations, build, check, lint, docs, tests backend/frontend et smoke sont
  verts ;
- #49 reste `NON_EXECUTED / NON_VALIDATED` ;
- la fusion prépare le canary manuel mais ne l'arme et ne l'exécute pas.

# Exécution live et canary Executor V1 — conception #51-G

**Version de spécification :** 1.2.13

**Version de la spécification parente :** 1.11.15

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-F fusionnée par la PR #74

## Historique des versions

- **1.2.13 — 2026-09-05 :** borne H2i, autorité PostgreSQL du listener paper
  nécessaire à l'émission normale d'une intention sans accès live.

- **1.2.12 — 2026-09-05 :** livre H2g, assemblage offline du draft H2f lié
  aux identités persistées exportées, tout en conservant le canary désarmé.

- **1.2.11 — 2026-09-05 :** livre H2f, packaging hors ligne canonique et
  atomique des deux attestations H2c, sans preuve synthétique, clé Solana,
  armement ou soumission.

- **1.2.10 — 2026-09-05 :** ferme le handoff H2e/H2d par une marge de cinq
  secondes et des chemins externes au checkout résolus canoniquement.

- **1.2.9 — 2026-09-05 :** aligne la génération de clé H2e sur Node.js 22 et
  une création exclusive owner-only portable sur l'hôte cible.

- **1.2.8 — 2026-09-05 :** exige que H2e reste frais après sa signature et
  son écriture avant tout handoff vers H2d.

- **1.2.7 — 2026-09-05 :** livre H2e, producteur externe Helius borné qui
  génère l'attestation provider H2d sans accès wallet, DB ou live.

- **1.2.6 — 2026-09-05 :** livre le producteur H2d non signant des identités
  wallet/provider, atomique et sous rôle PostgreSQL dédié, tout en maintenant
  le canary désarmé.

- **1.2.5 — 2026-09-05 :** référence H2d comme producteur non signable des
  projections publiques wallet/provider requises par le préflight externe,
  sans élargir H2a, H2b ou les commandes opérateur.

- **1.2.4 — 2026-09-05 :** remplace le fence irréalisable d'une lease encore
  entière par le fence causal voulu d'une lease strictement active au moment
  du lock pré-signature.

- **1.2.3 — 2026-09-05 :** ferme la reprise d'un lock autorisé après release
  de lease et valide l'absence de privilèges propres du login opérations à
  chaque checkout PostgreSQL 16.

- **1.2.2 — 2026-09-05 :** rend exécutables sous PostgreSQL 16 les fences H2c
  transitifs de H2a, H2b et opérations, avec une allowlist colonne exacte et
  toujours aucun accès recovery aux bytes signés.

- **1.2.1 — 2026-09-05 :** refuse avant ouverture du signer toute reprise
  dont une limite runtime diffère de l'armement exact autorisé.

- **1.2.0 — 2026-09-05 :** constate H2c prêt pour un préflight externe,
  avec armement exact V2, réservation d'exposition atomique, lock
  pré-signature durable, récupération fail-closed et procédure opérateur
  manuelle. L'état reste `CANARY_NOT_STARTED` et aucun verdict `PASS` n'est
  produit par le code ou la PR.

- **1.1.0 — 2026-09-04 :** constate H2b composé et désarmé avec exactement
  quatre lanes, recover SELL, execute SELL, recover BUY, execute BUY. H2a reste
  le binaire séparé de finalité, confirmation, réconciliation et deadline. H2c
  reste propriétaire de l'armement opérateur et du canary, qui n'a pas démarré.
- **1.0.19 — 2026-09-04 :** exclut les bytes signés des chemins de finalité
  H2a et distingue l'identité réellement observable on-chain des fingerprints
  build/snapshot liés durablement avant la soumission.
- **1.0.18 — 2026-09-04 :** référence #51-H2a, runtime séparé limité à la
  finalité read-only. La reprise signée, la soumission, les lanes SELL/BUY et
  le canary restent hors de ce processus et différés à H2b/H2c.
- **1.0.17 — 2026-09-04 :** étend le verrou de priorité SELL aux
  persistances signées et aux réactivations
  `UNKNOWN_REQUIRES_RECONCILIATION -> RETRY_READY`, notamment la réconciliation
  SELL `NO_EFFECT`, avant tout verrou génération ou métier.
- **1.0.16 — 2026-09-04 :** sérialise la priorité SELL avec un verrou advisory
  partagé par toutes les créations SELL et les claims BUY live. Un BUY ne peut
  plus observer l'absence d'un SELL dont l'insertion concurrente n'est pas
  encore commitée ; son `READ COMMITTED` explicite neutralise aussi un défaut
  de session PostgreSQL configuré en `REPEATABLE READ`.
- **1.0.15 — 2026-09-01 :** durcit les primitives H1 sans composer de runtime :
  identité d'artefact recalculée depuis les champs causaux, valeurs Solana
  décodées canoniquement, matrice d'états fermée et temps de deadline borné par
  une horloge PostgreSQL fraîche avec rejeu stable.
- **1.0.14 — 2026-09-01 :** référence les primitives persistantes #51-H1 :
  claims `LIVE_EXECUTE` par côté, reprise `LIVE_RECOVER`, read-models de
  confirmation et réconciliation, et scan atomique des sorties à deadline.
  Cette fondation ne compose ni RPC, ni signer, ni soumission, ni runtime de
  production ; l'entrypoint et le canary manuel restent différés à #51-H2.
- **1.0.13 — 2026-09-01 :** remplace les verrous de lignes incompatibles avec
  les tables de preuve en lecture seule par les verrous advisory génération et
  provider partagés par leurs writers. La réconciliation BUY revalide aussi le
  propriétaire, le token et l'expiration du lease sous le verrou de l'intention
  et avec une heure PostgreSQL relue après tous les verrous, avant toute nouvelle
  preuve ou mutation. Le rejeu recalcule l'identité causale complète de la preuve
  avant de contourner le fence et ne réapplique pas une transition déjà résolue.
  Une intégration PostgreSQL exécute admission et réconciliation sous le rôle
  live tout en prouvant que les tables de référence restent en lecture seule.
- **1.0.12 — 2026-09-01 :** compare l'intention de sortie persistée au
  contexte verrouillé de la position et refuse toute divergence de mint,
  quote, montant, stratégie ou preuve. La fenêtre persistée doit commencer à
  la deadline observée ou après et conserver exactement un TTL de 120 secondes.
- **1.0.11 — 2026-09-01 :** impose que le rejeu d'une sortie à deadline
  reconstruise l'intention depuis tous ses champs immuables persistés. Une
  observation ultérieure ne peut donc ni renouveler `requestedAt`, ni repousser
  `expiresAt`, ni modifier silencieusement le contrat de l'intention.
- **1.0.10 — 2026-09-01 :** porte à 128 la capacité bornée du journal agrégé
  de rétention et intègre explicitement les preuves de simulation non signée
  et signée dans son contrat canonique. Le worker accepte ainsi les 66
  compteurs réellement produits tout en conservant une limite stricte.
- **1.0.9 — 2026-09-01 :** sépare la rétention dans un rôle PostgreSQL
  `NOLOGIN` dédié, limite sa lecture de l'artefact live aux colonnes de cohorte
  sans bytes signés et sérialise la purge par verrou advisory sans privilège
  `FOR UPDATE` sur les états métier. La reprise découvre aussi l'artefact par
  intent/tentative et réhydrate depuis PostgreSQL ses bytes et sa preuve non
  signée canonique, sans dépendre de la mémoire du processus.
- **1.0.8 — 2026-09-01 :** rend durables et authentifiées les preuves de
  simulation non signée puis signée, fige les baselines d'admission risque,
  drawdown, quota et 429, et définit la reprise exacte de chaque frontière
  persistée. Un crash après `SUBMISSION_STARTED` passe en réconciliation sans
  nouvel appel RPC ; une preuve `MISMATCH` reste fail-closed.
- **1.0.7 — 2026-09-01 :** ferme les écarts du premier cycle de revue : preuve
  transactionnelle du dernier préflight, graphe SQL et journal de transitions
  fermés, révocation durable avant envoi, réconciliation BUY/SELL rejouable,
  privilèges minimaux et rétention terminale par cohorte. La composition RPC
  production reste explicitement reportée au prochain incrément.
- **1.0.6 — 2026-08-31 :** acte le résultat de l'audit d'intégration : cette
  livraison fournit un bootstrap injectable fail-closed et le runtime
  prioritaire, mais ne publie aucun exécutable production tant que les claims
  par côté, read-models live, scan de deadline, gateway RPC borné et pipeline
  quote/build/admission ne sont pas composés dans une PR suivante.
- **1.0.5 — 2026-08-31 :** ferme le volet opérateur livrable sans prétendre
  composer le runtime : rôle PostgreSQL live seul autorisé à lire les bytes
  signés, purge terminale quatre heures conservant tout état ouvert ou ambigu,
  inventaire smoke 036 et runbook explicitement non démarrable.
- **1.0.4 — 2026-08-31 :** compose la projection neutre des décisions paper
  derrière `EXECUTION_INTENT_EMISSION_ENABLED=false`. L'intention et la mise à
  jour canonique de session partagent la même transaction PostgreSQL, le
  mapper refuse observe, orphaned, qualification/quote obsolète et tout quote
  mint autre que WSOL dans cette première allowlist.
- **1.0.3 — 2026-08-31 :** rend la confirmation et la réconciliation live
  reprenables : le slot confirmed est durable, les preuves terminales BUY et
  SELL se rejouent sans nouvel effet, le BUY crée atomiquement position et
  autorisation de sortie, et le SELL clôt position, autorisation, armement et
  exposition dans une seule transaction. La deadline concurrente ne crée
  qu'une intention SELL déterministe.
- **1.0.2 — 2026-08-31 :** fixe la frontière de soumission exacte : simulation
  signée persistée, clôture transactionnelle `SUBMISSION_STARTED` avant RPC,
  `maxRetries=0` et passage durable en réconciliation pour tout résultat
  ambigu. Un commit indéterminé du résultat accepté n'est jamais réécrit par
  une seconde décision concurrente.
- **1.0.1 — 2026-08-31 :** distingue le cycle live du cycle
  `simulation-only` terminal de #51-D : la tentative live reste `STARTED` et la
  persistance atomique journalise `PROCESSING -> SIMULATED ->
  SIGNED_NOT_SUBMITTED` avec la preuve non signée liée à l'artefact.
- **1.0.0 — 2026-08-31 :** conception initiale du graphe live fermé, du
  chargement de secret, de la persistance avant envoi, de la soumission exacte,
  de la confirmation, de la réconciliation et du canary manuel minimal.

## 1. Décision

#51-G introduit les premières capacités de signature et de soumission du projet.
Elles résident dans une nouvelle frontière `executor-live`, séparée du listener, de
l'API, du paper, du dry-run, de `simulation-only` et des commandes opérateur.
Ces graphes restent incapables de charger un secret, signer ou envoyer.

La composition production de cette frontière n'est pas livrée par cette PR.
Le bootstrap injectable valide l'ordre configuration → schéma → secret et le
runtime prouve l'ordre des lanes, mais aucun script `executor:live:start` n'est
publié. Le prochain incrément doit fournir les ports de claim/read-model, le
gateway RPC borné et le pipeline live complet avant tout canary.

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
- nouveau bootstrap injectable et nouveau graphe `src/executor-live/` ;
- configuration live fermée et sans valeur permissive implicite ;
- chargeur local de keypair à chemin absolu, fichier régulier non symlink,
  propriétaire du processus et permissions exactes `0400` ou `0600` ;
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
- composition et publication du binaire production `executor:live:start` ;
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
intent_id, attempt_number, generation_id, armament_id, reservation_id
exit_authorization_id
provider_id, wallet_public_key, effective_venue
message_hash, build_fingerprint, snapshot_fingerprint, quote_fingerprint
quote_observed_at, quote_expires_at
blockhash, last_valid_block_height, signature
signed_transaction_bytes, signed_transaction_hash
state, state_revision
signed_at, signed_simulated_at, submission_started_at, submitted_at
confirmed_at, reconciled_at, revoked_at, purge_after
```

Les bytes sont `BYTEA`, limités à 1 232 octets et leur SHA-256 est vérifié. La
signature Ed25519 correspond au premier signer du message, au wallet et à la
signature externe calculable depuis les bytes. Les identités sont immuables.

États fermés :

```text
PERSISTED -> SIGNED_SIMULATED -> SUBMISSION_STARTED
SUBMISSION_STARTED -> ACCEPTED | AMBIGUOUS
ACCEPTED | AMBIGUOUS -> CONFIRMED -> RECONCILED
AMBIGUOUS -> RECONCILED uniquement avec preuve finalized NO_EFFECT
PERSISTED | SIGNED_SIMULATED -> REVOKED_NO_SEND
```

Une seule ligne peut être active par intention/tentative. Une soumission ou un
retry charge les bytes depuis PostgreSQL et vérifie à nouveau hash, signature,
wallet, blockhash et état. Il est interdit de reconstruire ou résigner.

Deux journaux append-only lient la chaîne de preuve à cet artefact :

- `execution_live_unsigned_simulation_evidence` conserve la simulation non
  signée exacte utilisée pour l'admission live ;
- `execution_signed_simulation_evidence` conserve la simulation des bytes
  signés avec le même artefact, intent, tentative et provider.

Chaque fingerprint est recalculé côté domaine depuis tous les champs
canoniques. Une différence de montant, frais, compute units, delta, provider
ou identité fait échouer la transaction PostgreSQL entière. L'état
`SIGNED_SIMULATED` est impossible sans ces deux preuves cohérentes.

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
units et deltas doivent correspondre à la preuve non signée. Une invalidité ou
une incohérence locale déterministe révoque atomiquement l'artefact sans envoi,
journalise sa preuve et libère les capacités BUY ou rend la même sortie SELL
réessayable. Une annulation ou une panne RPC ne constitue jamais une preuve de
non-envoi et ne déclenche pas cette révocation irréversible.

Immédiatement avant `SUBMISSION_STARTED`, une transaction SQL revalide toutes
les liaisons et écrit une preuve de préflight immuable dans la même transaction.
Pour un BUY : contrôle `RUNNING`, armement `LOCKED` exact,
qualification fraîche, risque connu, réservation, quota et plafonds. Pour un
SELL : contrôle différent de `HARD_STOP`, autorisation de sortie et quantité
ouverte réconciliée. Les deux exigent wallet, génération, cluster, genesis,
provider, quote fraîche, blockhash valide et lease frais.

L'admission BUY fige en plus la révision du risque, le drawdown conservateur,
l'usage provider local après coût d'entrée et le compteur de 429. Le dernier
gate relit les valeurs courantes sous le verrou provider et refuse toute
révision, hausse de drawdown, dépassement de quota ou nouveau 429 depuis
l'admission. Une ancienne admission sans baseline complète échoue fermée.

Le transport utilise `sendRawTransaction(bytes, {skipPreflight: true,
maxRetries: 0, preflightCommitment: 'confirmed'})`. Le résultat doit égaler la
signature déjà persistée. Une autre signature est une incohérence critique.
Timeout, 429, réponse invalide, crash ou résultat divergent passent
l'intention en `UNKNOWN_REQUIRES_RECONCILIATION`; ils ne déclenchent jamais une
nouvelle transaction.

Au redémarrage, le worker relit l'état durable avant tout effet : `PERSISTED`
reprend à la simulation signée, `SIGNED_SIMULATED` au dernier gate,
`ACCEPTED`/`AMBIGUOUS` à la confirmation-réconciliation, et
`REVOKED_NO_SEND` reste terminal. La simple observation de
`SUBMISSION_STARTED` est convertie durablement en `AMBIGUOUS` sans appeler le
transport : l'envoi a pu avoir lieu avant le crash et seul le suivi de la
signature persistée est alors sûr.

Cette reprise part du claim durable `(intent_id, attempt_number)` : le
repository découvre l'unique artefact correspondant, réauthentifie son lease
et relit la preuve non signée canonique avec ses fingerprints. Le worker ne
réutilise donc ni artefact, ni bytes, ni preuve conservés seulement en mémoire.
Les comptes de simulation signée restent reconstruits par le futur pipeline
production depuis le plan canonique inspecté ; ils ne permettent jamais une
résignature.

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

Pour un SELL, `UNKNOWN` gèle la position, l'autorisation et l'armement. Une
preuve finalized `NO_EFFECT` restaure la même sortie en `RETRY_READY` sans
libérer l'exposition ; une preuve `MATCHED` clôt une seule fois position,
autorisation, armement et exposition. Les replays tardifs exacts sont sans
effet supplémentaire.

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

La migration 036 ajoute notamment :

- `execution_signed_transactions` ;
- `execution_live_unsigned_simulation_evidence` ;
- `execution_signed_simulation_evidence` ;
- `execution_submission_preflight_evidence` ;
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

Le job planifié utilise exclusivement un LOGIN de déploiement membre du rôle
`NOLOGIN` `sol_token_retention_worker`. Ce rôle reçoit les `SELECT`, `DELETE`,
`INSERT` de tombstones et quatre listes de colonnes `UPDATE` strictement
requises par `purgeExpiredFoundationData`; il ne reçoit ni privilège cluster,
ni table-wide `UPDATE`. Sur `execution_signed_transactions`, son `SELECT` est
limité à `artifact_id`, `state`, `purge_after` et `exit_authorization_id` : les
bytes signés restent inaccessibles. Un verrou advisory transactionnel global
sérialise les cohortes et remplace les verrous de ligne qui auraient exigé un
droit de mutation sur les états métier.

## 13. Reason codes append-only

Les codes parent existants restent inchangés. #51-G ajoute :

```text
KEYPAIR_UNAVAILABLE
KEYPAIR_PERMISSIONS_INVALID
SIGNED_SIMULATION_FAILED
SIGNED_SIMULATION_SUCCEEDED
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
- reprise de `SUBMISSION_STARTED` sans second appel de soumission ;
- preuve non signée et signée append-only, fingerprints recomputés et rollback
  sur altération d'un seul champ ;
- dérive de révision risque, drawdown, quota ou compteur 429 refusée au dernier
  gate ;
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
- purge complète exécutable sous le rôle de rétention isolé, sans lecture des
  bytes signés ni `FOR UPDATE` ;
- rétention quatre heures et conservation des cas ambigus ;
- aucun test ne peut atteindre un endpoint Mainnet ou une méthode réelle.

## 15. Gates avant canary réel

Après fusion de H2b, la capacité signable est composée mais reste inactive et
désarmée. H2b exécute uniquement recover SELL, execute SELL, recover BUY,
execute BUY. H2a reste le binaire distinct responsable de la finalité, de la
confirmation, de la réconciliation et de la deadline. Ensuite seulement, dans
H2c et avant tout canary réel, l'opérateur doit fournir
des preuves fraîches pour les onze gates #51-F, puis :

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
- la fusion publie le binaire H2b sans l'armer ni l'exécuter ; H2c conserve
  l'armement et la préparation manuelle du canary.

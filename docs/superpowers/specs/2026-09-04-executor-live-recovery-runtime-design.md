# Runtime live de finalité en lecture seule — conception #51-H2a

**Version de spécification :** 1.0.0

**Version de la spécification parente :** 1.8.0

**Version de l'orchestration persistante :** 1.0.5

**Date :** 2026-09-04

**Statut :** APPROUVÉ — recommandation V1 appliquée conformément à la décision
opérateur de poursuivre les choix recommandés sans pause intermédiaire.

## Historique des versions

- **1.0.0 — 2026-09-04 :** sépare la composition live en deux capacités. H2a
  publie un runtime de finalité strictement incapable de signer ou soumettre ;
  H2b restera propriétaire de la reprise signée et des lanes d'exécution.

## 1. But et frontière

#51-H2a rend exécutables les traitements sans dépense déjà fermés par #51-H1 :

```text
PostgreSQL
  ├─ RECONCILE -> lectures RPC finalized -> preuve durable
  ├─ CONFIRM   -> lecture du statut de signature -> preuve durable
  └─ échéance  -> intention SELL déterministe en PostgreSQL
```

Le processus est publié sous une commande distincte
`executor:live:recovery:start`. Ce nom décrit une récupération de finalité, pas
une capacité d'exécution. L'état livré est :

```text
LIVE_RECOVERY_RUNTIME_COMPOSED
LIVE_EXECUTION_RUNTIME_NOT_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

Le runtime H2a n'importe ni keypair loader, ni signer, ni transaction signée,
ni simulation signée, ni transport de soumission. Il n'appelle jamais
`beginSubmission`, `sendRawTransaction`, `LIVE_EXECUTE` ou `LIVE_RECOVER`.
Il ne lit jamais `signed_transaction_bytes`.

## 2. Approches étudiées

### 2.1 Composer immédiatement tout le live

Relier dans la même PR le secret, la signature, la reprise, les cinq lanes et
le transport rendrait difficile la preuve qu'une voie de finalité ne peut pas
dépenser. Cette approche est différée à H2b.

### 2.2 Réutiliser le gateway live combiné avec un transport inerte

Un objet qui expose `sendRawTransaction`, même injecté avec une implémentation
inerte, élargit inutilement le graphe d'autorité. Une erreur d'injection ou un
appel après `beginSubmission` créerait un état ambigu sans envoi réel. Approche
rejetée.

### 2.3 Runtime finalité à ports étroits — retenue

H2a compose uniquement des ports RPC de lecture. Les tests d'architecture
inspectent le graphe source et compilé. H2b ajoutera plus tard un exécutable
séparé pour la reprise et l'exécution signables.

## 3. Invariants de sécurité

1. Aucun module accessible depuis l'entrypoint H2a ne charge un secret ou ne
   possède de méthode de signature ou de soumission.
2. Aucun claim H2a n'utilise `LIVE_EXECUTE` ou `LIVE_RECOVER`.
3. Une passe traite au plus une unité, dans l'ordre réconciliation,
   confirmation, échéance.
4. Les read-models proviennent exclusivement des claims atomiques H1.
5. Le provider du read-model est identique au provider RPC configuré.
6. La réconciliation utilise des lectures `finalized`; la confirmation est une
   observation et ne fabrique jamais un statut.
7. Le lease est renouvelé avant et après toute séquence RPC. Si le
   renouvellement échoue, aucune écriture métier n'est tentée.
8. Toute mutation revalide le claim dans le repository H1 avec l'heure
   PostgreSQL.
9. Le genesis hash est vérifié au démarrage avant le lancement des lanes.
10. Les slots, hauteurs, réserves, deltas et frais restent des `bigint`.
11. Une erreur RPC, un timeout, un 429 ou une réponse non canonique produit un
    résultat fermé et rejouable ; jamais une donnée synthétique.
12. Les logs ne contiennent ni URL RPC, ni signature, ni mint, ni montant, ni
    octets de transaction, ni secret.
13. Le démarrage ne modifie ni armement, ni contrôle, ni génération wallet.
14. Aucun endpoint HTTP public n'est ajouté.

## 4. Configuration fermée

La configuration H2a est distincte de `LiveExecutorConfig`. Elle accepte
exactement les paramètres publics nécessaires :

- `EXECUTOR_LIVE_RECOVERY_ENABLED=true` ;
- `EXECUTION_MODE=live` ;
- `SOLANA_CLUSTER=mainnet-beta` ;
- `DATABASE_URL` ;
- `EXECUTOR_LIVE_PROVIDER_ID` ;
- `EXECUTOR_LIVE_HTTP_RPC_URL` ;
- `EXECUTOR_LIVE_EXPECTED_GENESIS_HASH` ;
- `EXECUTOR_LIVE_RECOVERY_OWNER_ID` ;
- intervalles, timeouts, lease et budget d'appels bornés.

Les noms d'environnement liés aux secrets (`KEYPAIR`, `PRIVATE_KEY`,
`SECRET`) sont refusés s'ils sont présents, même vides. L'URL RPC est validée
mais jamais journalisée. Les clés inconnues du processus ne sont pas
interdites ; seul l'objet de configuration normalisé est fermé et immuable.

## 5. Validation de démarrage

L'ordre est obligatoire :

1. parser la configuration ;
2. ouvrir PostgreSQL avec des timeouts bornés ;
3. vérifier le rôle courant attendu ;
4. vérifier que l'historique de migrations correspond exactement au catalogue
   versionné jusqu'à `037_execution_live_orchestration.sql` ;
5. vérifier la génération wallet et les bindings provider, build,
   configuration et stratégie déjà persistés pour les travaux ouverts ;
6. créer le client RPC de lecture ;
7. vérifier le genesis hash ;
8. créer les lanes puis lancer la boucle.

Une divergence ferme le processus avant toute mutation métier. H2a n'applique
pas les migrations et ne provisionne pas les rôles au démarrage.

Le catalogue de migrations associe chaque nom au SHA-256 de son contenu. Cette
preuve détecte aussi une migration historique modifiée après déploiement. Le
schéma existant `migration_history(version, applied_at)` ne stockant pas les
checksums, H2a vérifie le catalogue logiciel et l'ensemble exact des versions
appliquées ; l'ajout durable des checksums historiques nécessiterait une
migration séparée et n'est pas simulé implicitement.

## 6. Gateway RPC de lecture

Le gateway concret utilise JSON-RPC HTTP avec `AbortSignal`, timeout par appel,
taille maximale de réponse, budget par passe et parsing fermé.

Méthodes autorisées :

- `getGenesisHash` au démarrage ;
- `getSignatureStatuses` avec historique pour la confirmation ;
- `getBlockHeight` avec engagement `finalized` ;
- `getSignatureStatuses` avec historique pour la présence finalized ;
- `getTransaction` avec engagement `finalized`, encodage JSON et version 0 ;
- lectures de comptes/balances finalized strictement nécessaires aux deltas
  wallet définis par `ExecutionReconciliationGateway`.

Les quatre lectures de réconciliation doivent représenter une observation
cohérente. Si la transaction ou les deltas ne peuvent pas être prouvés au
niveau attendu, le résultat reste `UNKNOWN` ou la lane est rejouée. Aucune
lecture `processed` ne produit une preuve durable.

Chaque réponse doit être JSON-RPC 2.0, correspondre à l'identifiant de requête,
respecter les bornes de taille et les types entiers. Les nombres Solana au-delà
de la précision sûre sont lus depuis des chaînes décimales ou refusés.

## 7. Lanes

### 7.1 Réconciliation

La lane appelle `claim(... purpose: 'RECONCILE')`, puis
`readReconciliationWork(claim)`. Elle refuse une divergence de `providerId`,
renouvelle le lease, collecte les preuves finalized via le gateway, renouvelle
à nouveau et appelle `commitReconciliation` avec le claim original.

`SIGNED_NOT_SUBMITTED` n'est pas éligible. La reprise exacte de cet état reste
réservée à H2b via `LIVE_RECOVER`.

### 7.2 Confirmation

La lane appelle `claim(... purpose: 'CONFIRM')`, puis
`readConfirmationWork(claim)`. Elle observe uniquement la signature fournie par
le read-model, renouvelle le lease avant et après l'appel puis persiste avec
`recordConfirmation`. `NOT_FOUND`, erreur ou statut non confirmé ne provoque
aucune transition terminale et sera rejoué.

### 7.3 Échéance

La lane appelle le scanner atomique H1 `createNextDeadlineExitIntent`. Elle ne
consulte pas le réseau et ne réclame pas l'intention SELL créée. Le fence de
présence SELL protège toujours les BUY concurrents.

## 8. Boucle, logs et arrêt

La boucle appelle les lanes dans l'ordre strict et attend l'intervalle de poll
après une passe. Une erreur est journalisée sous un code typé puis la boucle
continue, sauf erreur de démarrage ou signal d'arrêt.

Événements structurés minimaux :

- `executor_live_recovery.started` ;
- `executor_live_recovery.lane_completed` ;
- `executor_live_recovery.lane_failed` ;
- `executor_live_recovery.stopping` ;
- `executor_live_recovery.stopped`.

Les champs autorisés sont `lane`, `result`, `errorCode`, `providerPosition`,
`executionMode` et durées bornées. Les identifiants métier sensibles ne sont
pas journalisés.

`SIGINT` et `SIGTERM` interrompent les appels RPC, empêchent une nouvelle
passe, ferment PostgreSQL et terminent dans un délai borné. Au dépassement, la
connexion DB est évincée puis le processus sort avec code 1. Aucun signer
n'existe à fermer.

## 9. Tests d'acceptation

H2a est livrable uniquement si :

- config exacte, bornes, secrets interdits et défaut fail-closed sont testés ;
- le démarrage valide rôle, migrations, bindings et genesis dans l'ordre ;
- chaque lane utilise son claim/read-model H1 et traite une seule unité ;
- la priorité réconciliation → confirmation → échéance est prouvée ;
- provider affinity et perte de lease échouent fermées ;
- timeout, abort, 429, réponse RPC invalide et genesis divergent sont testés
  avec un serveur RPC local ;
- aucune suite de tests ou CI ne joint un endpoint Solana public ;
- les tests d'architecture source et `dist` prouvent l'absence de keypair,
  signer, bytes signés, simulation signée, `beginSubmission` et
  `sendRawTransaction` ;
- PostgreSQL réel valide les claims, commits, concurrence et reprise ;
- build, check, lint, tests backend/frontend, migrations vides/rejouées et
  documentation passent ;
- aucun test existant ne régresse.

## 10. Non-objectifs et suite

H2a ne signe, ne simule signé, ne soumet, ne reprend
`SIGNED_NOT_SUBMITTED`, ne réclame BUY/SELL, n'arme pas et ne démarre aucun
canary. Il ne change pas l'API publique, la stratégie ou les plafonds.

#51-H2b composera dans un autre exécutable les lanes de reprise signée, SELL,
deadline SELL et BUY, avec gateway de soumission isolé, leases renouvelés,
gates transactionnels, exact bytes et `maxRetries=0`. #51-H2c restera la
validation opérateur puis la préparation manuelle du canary minimal.

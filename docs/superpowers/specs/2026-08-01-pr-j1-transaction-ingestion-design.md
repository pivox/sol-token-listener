# PR J1 — Ingestion transactionnelle Pump.fun opérationnelle

## Objet

PR J1 rend le backend réellement capable d'observer le réseau au démarrage.
`npm start` ne sert plus seulement des projections PostgreSQL existantes : il
s'abonne aux programmes Pump.fun et PumpSwap, conserve chaque notification
avant traitement, localise la transaction exacte dans son bloc, puis exécute
les pipelines passifs déjà présents.

Cette PR ne crée aucun chemin de transaction réelle. Les seuls modes restent
`observe` et `paper`, aucune clé privée n'est acceptée et le mode `paper`
n'ouvre aucune position tant que la qualification conserve une preuve
obligatoire inconnue.

## Périmètre

PR J1 ajoute :

- une inbox PostgreSQL durable pour les signatures Solana ;
- un abonnement WebSocket Pump.fun et PumpSwap ;
- un rattrapage HTTP borné après démarrage ou reconnexion ;
- la résolution déterministe de `transactionIndex` depuis le bloc ;
- une implémentation PostgreSQL de `LaunchpadEventSink` ;
- un pipeline ordonné qui compose launchpad, preuves de financement,
  analytics I1, graphe I2 et PumpSwap ;
- la réconciliation `confirmed`, `finalized` et `orphaned` ;
- des checkpoints et heartbeats correspondant à l'état réel ;
- un cycle de démarrage et d'arrêt propre dans `src/app.ts`.

PR J1 n'ajoute pas :

- de vérification sociale ;
- d'API X ou Telegram ;
- d'historique antérieur à la détection ;
- de recherche récursive de funders ;
- d'activation des blockers de cluster ;
- d'entrée paper avec une qualification `WATCHLISTED` ;
- de signature, simulation live ou envoi de transaction ;
- de composition de Raydium CPMM.

Les métadonnées automatiques, la preuve sociale, la qualification persistée
et le déclenchement paper complet constituent PR J2.

## Principes

1. Une notification réseau est persistée avant tout décodage métier.
2. Le WebSocket accélère la détection mais n'est pas la source unique de
   reprise.
3. Le rattrapage HTTP ne saute jamais silencieusement une fenêtre trop large.
4. Un message n'est `PROCESSED` qu'après toutes ses étapes obligatoires.
5. Chaque étape est idempotente ; un crash provoque un replay complet sûr.
6. L'index de transaction n'est jamais inventé ou dérivé de l'ordre d'arrivée.
7. Les erreurs persistées sont structurées et ne contiennent ni secret ni
   payload RPC complet.
8. Le checkpoint n'avance qu'après une collecte complète et durable.
9. Une absence temporaire de statut ne suffit jamais à déclarer `orphaned`.
10. L'état `/health` décrit le runtime réel, pas les capacités compilées.

## Architecture

```text
Solana HTTP health ───────────────────────────────────────────────┐
                                                                 │
Pump logs WS ─────┐                                              │
                  ├─> SolanaProgramSubscriber                    │
PumpSwap logs WS ─┘        │                                     │
                            v                                     │
                    PostgresTransactionInbox <──── CatchUpScanner │
                            │                                     │
                            v                                     │
                    TransactionInboxWorker                        │
                            │                                     │
                  SolanaTransactionLocator                        │
                            │                                     │
                            v                                     │
                 ObservedTransactionPipeline                      │
                    │       │       │       │                     │
                    │       │       │       └─ PumpSwap pipeline  │
                    │       │       └─ I1 puis I2                 │
                    │       └─ preuves de financement             │
                    └─ launchpad sink PostgreSQL                  │
                            │                                     │
                            v                                     │
                  checkpoint + heartbeat <────────────────────────┘
```

Le runtime possède ces composants par ports. `src/app.ts` ne connaît pas les
détails du décodage Pump.fun ou PumpSwap ; il crée un `ListenerRuntime`, lui
demande de démarrer, puis compose l'API avec l'état du runtime.

## Inbox durable

### Identité

Une entrée représente une signature Solana unique. La même transaction peut
être observée par les deux abonnements ou être redécouverte par le rattrapage.
La clé primaire reste donc `signature`.

La ligne conserve :

- `signature` ;
- premier et dernier slot signalés ;
- source de découverte : `WEBSOCKET`, `CATCH_UP` ou les deux ;
- confirmation cible la plus élevée observée ;
- statut de travail ;
- nombre de tentatives ;
- lease et prochain instant de tentative ;
- snapshot normalisé immuable après première récupération ;
- fingerprint du snapshot ;
- code et nom d'erreur structurés ;
- dates de création, mise à jour et traitement.

Les statuts sont :

```text
PENDING -> PROCESSING -> PROCESSED
             │
             └────────> FAILED -> PENDING
```

Une entrée `PROCESSING` dont le lease a expiré est réclamable. Une entrée
`PROCESSED` repasse à `PENDING` lorsqu'une finalité supérieure ou un orphaning
doit être réconcilié.

### Concurrence

Le claim utilise `FOR UPDATE SKIP LOCKED`. La V1 démarre un worker séquentiel
pour préserver le quota RPC et simplifier l'ordre. Le contrat permet une
concurrence bornée ultérieure sans changer le schéma.

Le lease est renouvelé entre les appels externes longs. Si le processus meurt,
un autre démarrage reprend la ligne après expiration.

### Erreurs et retry

Les erreurs sont classées :

- `RPC_TRANSIENT` : retry avec backoff borné ;
- `TRANSACTION_NOT_AVAILABLE` : retry tant que la finalité cible permet encore
  une apparition ;
- `BLOCK_NOT_AVAILABLE` : retry sans inventer `transactionIndex` ;
- `TRANSACTION_INDEX_NOT_FOUND` : échec conservateur ;
- `NORMALIZATION_FAILED` : échec déterministe, sans boucle rapide ;
- `PIPELINE_STAGE_FAILED` : replay complet après délai ;
- `FINALITY_INCONSISTENT` : état dégradé et intervention visible.

Le message public ne contient que le code, l'étape et le nom de l'erreur. Le
logger structuré peut inclure signature et slot, jamais une URL RPC complète.

## Abonnement WebSocket

`SolanaProgramSubscriber` ouvre deux abonnements `onLogs` :

- programme Pump.fun officiel ;
- programme PumpSwap officiel.

Une transaction mentionnant les deux programmes peut produire deux callbacks.
L'upsert de l'inbox fusionne les notifications sans doubler le traitement.

Le démarrage n'est réussi qu'après :

1. health check HTTP RPC ;
2. connexion PostgreSQL ;
3. installation confirmée des deux abonnements ;
4. démarrage du scanner de rattrapage ;
5. démarrage du worker.

Une erreur de démarrage ferme les composants déjà ouverts dans l'ordre inverse.
Une perte WebSocket fait passer le pipeline à `DEGRADED`, déclenche une
réinstallation bornée des abonnements et exécute un rattrapage avant de revenir
à `RUNNING`.

## Rattrapage HTTP et checkpoints

Le rattrapage utilise `getSignaturesForAddress` pour Pump.fun et PumpSwap, puis
fusionne les résultats par signature. Il remonte jusqu'au checkpoint durable
de chaque programme. Cette stratégie évite de télécharger chaque bloc du
réseau tout en couvrant les notifications perdues.

Les règles sont :

- pagination explicite, sans page tronquée ignorée ;
- nombre maximal de signatures et de pages configurable ;
- si le checkpoint n'est pas atteint avant la borne, le démarrage échoue avec
  `CATCH_UP_WINDOW_EXCEEDED` ;
- les signatures sont persistées avant l'avancement du checkpoint ;
- un checkpoint distinct est conservé pour Pump.fun et PumpSwap ;
- l'ordre de traitement final utilise slot, `transactionIndex`, puis signature.

Le checkpoint mesure une collecte durable. Le backlog et l'âge du plus ancien
message exposent séparément le retard de traitement.

## Localisation et normalisation

Le callback WebSocket fournit signature et slot mais pas
`transactionIndex`. `SolanaTransactionLocator` :

1. récupère la transaction au niveau de confirmation cible ;
2. vérifie que son slot correspond à l'inbox ;
3. récupère les signatures du bloc ;
4. recherche exactement la signature et utilise sa position comme
   `transactionIndex` ;
5. appelle la normalisation existante avec cet index ;
6. persiste le snapshot normalisé et son fingerprint.

Une signature absente du bloc n'est jamais placée arbitrairement à l'index
zéro. Les instructions externes et internes, `stackHeight`, balances, Token
Program et Token-2022 restent préservés par `TransactionFetcher`.

Le snapshot normalisé sert aux replays de finalité et à l'orphaning, lorsque
le RPC ne retourne plus la transaction.

## Sink launchpad PostgreSQL

`PostgresLaunchpadEventSink` implémente `LaunchpadEventSink`. Son opération
`record` utilise une seule transaction PostgreSQL et :

1. verrouille la signature par advisory lock ;
2. insère ou réconcilie `raw_chain_events` ;
3. insère ou réconcilie les `domain_events` ;
4. crée ou met à jour `token_launches` ;
5. persiste les `launch_trades` ;
6. applique ou rétracte les transitions initiales ;
7. vérifie les fingerprints immuables avant commit ;
8. retourne un résultat dans l'ordre exact des événements d'entrée.

Une première observation `orphaned` conserve la preuve brute mais ne crée pas
de projection active. Une montée de confirmation conserve l'identité. Une
contradiction de payload provoque un rollback typé.

Le repository expose ensuite les événements actifs d'une signature. Le
pipeline utilise cette lecture durable, plutôt qu'un état mémoire du callback,
pour alimenter les étapes suivantes après un replay.

## Pipeline d'une transaction

`ObservedTransactionPipeline.process` reçoit un snapshot normalisé et exécute :

1. création de l'enveloppe Solana observée ;
2. chargement des mints déjà suivis nécessaires au décodage des trades ;
3. `LaunchpadObservationService.observe` ;
4. relecture des événements launchpad actifs de la signature ;
5. `WalletEvidenceObservationService.observe` pour les BUY ;
6. reconstruction I1 pour chaque mint affecté, dans l'ordre lexical ;
7. reconstruction I2 pour les mêmes mints ;
8. `PumpSwapObservationPipeline.observe` ;
9. retour d'un résultat borné contenant les compteurs par étape.

Chaque service garde sa propre transaction et son idempotence. L'atomicité
globale est obtenue par l'inbox : le message n'est marqué `PROCESSED` qu'après
la dernière étape. Un crash intermédiaire rejoue toutes les étapes ; aucune ne
doit dépendre d'un état mémoire éphémère.

Pour un événement `orphaned`, le même ordre s'applique. Les repositories
rétractent les projections dépendantes avant que l'inbox ne valide la révision.

Une transaction sans instruction Pump.fun ou PumpSwap est validée puis marquée
sans écriture métier. Le scanner ne devrait normalement pas en produire, mais
ce comportement rend le port robuste.

## Finalité et orphaning

Le reconciler sélectionne les signatures non finalisées déjà traitées et
appelle `getSignatureStatuses` avec recherche d'historique.

- `confirmed` devient `finalized` dès preuve RPC explicite ;
- un statut inférieur n'entraîne pas de régression ;
- une réponse `null` isolée reste inconnue ;
- l'orphaning exige que le slot finalisé ait dépassé le slot observé et que la
  signature soit absente pendant trois polls consécutifs ;
- le nombre de polls est configurable et ne peut être inférieur à deux ;
- une contradiction après `finalized` produit `FINALITY_INCONSISTENT` et ne
  rétracte rien silencieusement.

La révision réutilise le snapshot normalisé avec le nouveau statut, repasse par
le pipeline complet puis met à jour l'inbox.

## Runtime et bootstrap

`ListenerRuntime` expose :

```ts
interface ListenerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
}
```

Les états publics sont `STARTING`, `RUNNING`, `DEGRADED`, `STOPPING` et
`STOPPED`. Ils sont convertis vers le contrat health existant sans annoncer un
pipeline actif avant la fin du démarrage.

`src/app.ts` suit cet ordre :

1. charger et valider la configuration ;
2. ouvrir PostgreSQL et exécuter les migrations si demandé ;
3. construire le runtime sans capacité de signature ;
4. démarrer le runtime ;
5. démarrer l'API avec l'état réel ;
6. attendre un signal ;
7. arrêter l'abonnement et le scanner ;
8. laisser finir ou expirer le lease du travail engagé ;
9. fermer l'API ;
10. fermer PostgreSQL.

Le listener est activé par défaut. Une option explicite de diagnostic peut le
désactiver, mais ce mode est exposé comme `STOPPED` et ne doit pas être présenté
comme opérationnel.

Si l'API est désactivée, le listener continue de fonctionner. Si le listener
ne peut pas démarrer, l'application entière échoue, même si l'API pourrait
servir des données anciennes.

## Configuration

Les nouvelles variables sont sûres et bornées :

- `LISTENER_ENABLED=true` ;
- `LISTENER_WORKER_LEASE_SECONDS=120` ;
- `LISTENER_CATCHUP_MAX_PAGES=20` ;
- `LISTENER_CATCHUP_PAGE_SIZE=100` ;
- `LISTENER_RETRY_MAX_ATTEMPTS=5` ;
- `LISTENER_RETRY_BASE_DELAY_MS=500` ;
- `LISTENER_FINALITY_MISSING_POLLS=3` ;
- `LISTENER_SHUTDOWN_TIMEOUT_MS=30000`.

Les bornes invalides empêchent le démarrage. Les URL RPC restent requises.
`EXECUTION_MODE=live`, les clés privées et les actions dashboard restent
refusés.

## Heartbeat et santé

Le heartbeat PostgreSQL est mis à jour périodiquement avec :

- instant de démarrage et dernière mise à jour ;
- dernier slot HTTP ;
- dernier slot WebSocket ;
- dernier slot finalisé ;
- dernière signature ;
- taille du backlog ;
- nombre de messages loués ;
- état du subscriber, scanner, worker et reconciler.

`/api/v1/health` retourne :

- `OK` lorsque PostgreSQL et RPC sont accessibles, le runtime est `RUNNING`,
  le heartbeat est frais et le rattrapage est dans ses bornes ;
- `DEGRADED` lors d'une reconnexion, d'un backlog excessif ou d'un heartbeat
  périmé ;
- HTTP 503 lors d'une dépendance indisponible déjà représentée comme telle par
  le contrat existant.

Les checkpoints `launchpad` et `market` reflètent les collectes Pump.fun et
PumpSwap. Aucune valeur n'est fabriquée avant la première collecte complète.

## Arrêt

L'arrêt est idempotent et borné :

1. refuser de nouveaux claims ;
2. supprimer les abonnements WebSocket ;
3. arrêter catch-up et reconciler ;
4. attendre le message engagé jusqu'au timeout ;
5. laisser son lease récupérable si le timeout expire ;
6. écrire un dernier heartbeat `STOPPED` ;
7. fermer API puis PostgreSQL.

Les erreurs primaire et de nettoyage sont conservées dans un `AggregateError`
dans leur ordre d'apparition.

## Migrations

Une migration versionnée crée :

- `chain_transaction_inbox` ;
- ses index de claim, retry, finalité et purge ;
- les contraintes de statut et de compteurs ;
- les colonnes de heartbeat nécessaires au runtime ;
- les checkpoints séparés Pump.fun et PumpSwap.

Elle doit être rejouable sur une base vide et compatible avec les migrations
001–008. Elle ne supprime ni ne renomme aucune donnée existante.

Les entrées d'inbox finalisées ou orphaned suivent la rétention de quatre
heures. Les entrées encore nécessaires à une réconciliation ne sont pas
purgées.

## Tests

### Unitaires

- fusion de notifications WebSocket Pump.fun/PumpSwap ;
- claim, lease expiré, retry et backoff ;
- ordre slot/index/signature ;
- résolution exacte de `transactionIndex` ;
- refus d'un bloc ou index incohérent ;
- classification d'erreurs sans fuite d'URL ;
- orchestration des étapes et arrêt au premier échec ;
- ordre lexical des mints affectés ;
- montée de finalité, null temporaire et seuil d'orphaning ;
- démarrage et arrêt partiels avec nettoyage inverse ;
- configuration sûre et bornée.

### Intégration PostgreSQL

- migration 001–009 sur base vide et replay ;
- deux claims concurrents d'une même signature ;
- reprise d'un lease après crash simulé ;
- sink launchpad atomique et idempotent ;
- rollback sur contradiction ;
- crash simulé après chaque étape puis replay complet ;
- checkpoint avancé seulement après persistance de toute la page ;
- purge sans suppression d'un travail non terminal.

### Intégration Solana assainie

- notification dupliquée par les deux programmes ;
- transaction avec plusieurs instructions Pump.fun externes et internes ;
- création et achat initial dans la même transaction ;
- migration et `create_pool` PumpSwap dans la même transaction ;
- bloc contenant plusieurs transactions pertinentes avec index distincts ;
- disparition conservatrice avant orphaning.

### Sécurité

- aucun import des modules wallet, transaction builder, confirmer ou queue
  depuis le runtime ;
- aucune clé privée acceptée ;
- aucun mode live ;
- `paper` ne contourne jamais `WATCHLISTED` ;
- logs exempts d'URL RPC et de payload complet.

## Critères d'acceptation

PR J1 est acceptable lorsque :

- `npm start` démarre par défaut l'observation et échoue si elle est
  indisponible ;
- une création Pump.fun observée remplit durablement les projections launchpad,
  I1 et I2 ;
- une migration observée alimente le pipeline PumpSwap canonique ;
- les notifications dupliquées ne doublent aucun événement ;
- un crash à n'importe quelle étape est récupéré sans perte silencieuse ;
- les checkpoints ne masquent aucun trou de collecte ;
- `confirmed`, `finalized` et `orphaned` sont réconciliés ;
- `/health` correspond au runtime réel ;
- `observe` ne crée aucune position ;
- `paper` ne crée aucune position sans `QUALIFIED` ;
- aucune transaction réelle ne peut être signée ou envoyée ;
- `npm install`, build, check, lint et tous les tests réussissent ;
- les migrations fonctionnent sur une base vide et en replay ;
- tous les tests existants restent verts.

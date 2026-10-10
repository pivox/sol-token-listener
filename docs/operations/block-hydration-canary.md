# Canary Mainnet post-merge d’hydratation et admission Pump.fun — 15 minutes

> **Stack de référence.** Les commandes de ce runbook visent la stack d'observation antérieure au
> 2026-10-09 (services `app`, `frontend`, `retention`). Dans la stack actuelle
> (`docs/operations/deployment.md`), le listener est le programme `listener` du conteneur `back` :
> `sol ctl stop listener` remplace `stop app`, et sa configuration vit dans Vault, entrée
> `sol/config/listener`.

Version : 1.7.0 — 2026-10-03 — issues #114, #142, #143, #146, #148, #151, #153, #155, #163, #169, #170, #177, #209 et #218.

Cette procédure post-merge est opérateur-only et observe-only et ne confère
aucune autorité wallet, signer ou submit : elle ne connecte ni ne lit aucun
wallet ou clé privée, ne compose aucun executor, n'arme, ne signe et ne soumet
aucune transaction. Elle est séparée de ce merge : aucune
readiness Mainnet n'est déclarée avant que cette fenêtre ait passé. Utiliser une
seule réplique avec `LISTENER_INGESTION_SCOPE=launchpad-only`, en mode `observe`.
Archiver le health, les compteurs inbox, le RSS et le tableau fournisseur avant
activation.

## Diagnostic des phases d’hydratation #218

Le heartbeat durable et `/api/v1/health` peuvent exposer le sidecar optionnel
`blockHydrationPhaseEvidence.v1`. Il mesure séparément les phases physiques
`rpc` (`getBlockTransactions`, y compris transfert, JSON et conversion SDK) et
`snapshot` (normalisation et encodage local). Chaque phase publie des compteurs
de tentatives et dix classes de latence agrégées ; aucune identité, URL ou
réponse RPC n’y figure. L’absence historique, le mode désactivé ou l’absence
de premier fetch se projette en `null`.

Capturer ce sidecar séparément du manifeste canary V1 : **ne jamais** l’ajouter
aux snapshots `T0`/`T+5`/`T+15`/`FINAL_PRESTOP` ni au `stoppedHeartbeat` remis à
`canary:evaluate`. Ce manifeste reste fermé et comporte exactement 19 gates ;
un champ supplémentaire donne `INVALID_EVIDENCE`. Une valeur `overflowed=true`
ou `epochInvalidations>0` limite l’interprétation des distributions ; les
mesures agrégées ne sont pas appariées requête par requête avec les latences
HTTP. Ce diagnostic ne constitue ni un gain de débit prouvé ni une readiness
Mainnet, et ne change aucun verdict ou seuil du canary.

## Activation bornée #177

Les exemples et Compose doivent conserver
`LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false`. L'opérateur ne peut
mettre cette valeur à `true` dans son environnement externe qu'après la
livraison #177 fusionnée et une CI post-merge verte. Le flag est restart-only :
un changement exige un arrêt propre puis un nouveau processus. Cette activation
est limitée à cette fenêtre Mainnet observe-only de quinze minutes.

Capturer le health complet et expurgé aux cinq frontières exactes `T0`, `T+5`,
`T+15`, `FINAL_PRESTOP` puis dans le heartbeat PostgreSQL durable `STOPPED`.
Chacune porte un objet exact `workerAdmission.v1` et son sidecar exact
`workerAdmissionClock` (`version=1`, `sampledAtMs`); l'absence, une forme
malformée, `enabled=false`, une fenêtre différente de 45 secondes ou une
chronologie non monotone donne `INCONCLUSIVE`. Depuis T+5 : non croissant pour
classification puis backlog claimable jusqu'à `STOPPED`. La dette la plus
ancienne à 44 999 ms reste éligible à `PASS`; 45 000 ms exactement produit
`FAIL`. À chaque relevé, `claimableBacklogCount <= backlogCount` et la somme
avec `classificationPendingCount` reste inférieure ou égale au backlog legacy.
Le compte claimable `STOPPED` doit correspondre au compte SQL post-stop dédié
`postStopWorkerAdmissionClaimableCount` et à
`postStopWorkerAdmissionClaimableProof.claimableBacklogCount`. Le clock de la
preuve doit égaler exactement celui du heartbeat `STOPPED`, sinon le verdict
est `INCONCLUSIVE`.
Le champ distinct `postStopActionableCount` reste exclusivement la preuve du
gate shutdown legacy et doit toujours égaler le `backlogCount` arrêté.

## Preuve d'admission d'hydratation #209

Capturer `heartbeat.blockHydrationAdmission` aux mêmes cinq frontières et
conserver l'objet exact dans chaque snapshot du manifeste V1 et dans
`stoppedHeartbeat`. Ce champ optionnel ne remplace pas `blockHydration.v1`.
Le gate séparé `blockHydrationAdmission` classe une absence historique
`INCONCLUSIVE` (`BLOCK_HYDRATION_ADMISSION_EVIDENCE_MISSING`), sans invalider le
parsing ni réécrire les anciens gates. Toute preuve présente malformée ou
hors bornes est `FAIL` (`BLOCK_HYDRATION_ADMISSION_EVIDENCE_MALFORMED`).
Chaque preuve doit avoir `version=1` et `enabled=true` pour attester le contrat ;
`enabled=false` reste `INCONCLUSIVE` (`BLOCK_HYDRATION_ADMISSION_DISABLED`).

Les champs exacts sont `version`, `enabled`, `registeredWorkers`,
`pendingWorkers`, `maximumPendingWorkers`, `pendingClassifierGroups`,
`maximumPendingClassifierGroups`, `unboundReservations`, `activeGroups`,
`maximumAdmitted`, `worker` et `classifier`. Chaque rôle contient uniquement
`grants`, `cancellations`, `oldestWaitMs`, `lastWaitMs` et `maximumWaitMs`.
Voir [le contrat JSON API](../api/v1.md) pour les formes et la sémantique.
À chaque frontière, `pendingWorkers <= registeredWorkers` et
`pendingWorkers <= maximumPendingWorkers`, tandis que
`pendingClassifierGroups <= maximumPendingClassifierGroups <= 1`.
La somme `unboundReservations + activeGroups` est inférieure ou égale au maximum
historique `maximumAdmitted <= 1`. Au heartbeat arrêté, les quatre jauges
`pendingWorkers`, `pendingClassifierGroups`, `unboundReservations` et
`activeGroups` doivent toutes être zéro, sinon `FAIL`
(`BLOCK_HYDRATION_ADMISSION_NOT_DRAINED`). Une preuve conforme donne
`BLOCK_HYDRATION_ADMISSION_BOUNDED`, indépendamment des autres gates.

`registeredWorkers` compte les handles encore ouverts, pas un maximum de
configuration : zéro après fermeture reste compatible avec un
`maximumPendingWorkers` historique positif. Les grants et annulations comptent
les consommateurs par rôle, y compris les joins, pas les fetches physiques.
L'attente upstream en cours reste visible via `oldestWaitMs` et peut dépasser
le `maximumWaitMs` des attentes déjà terminées. Le backlog durable, l'âge de
classification et la latence détection → traitement restent les preuves de
capacité ; les seuils queue, oversize, p95, backlog et finalité sont inchangés.
Ni ce gate ni cette livraison ne déclarent une readiness Mainnet.

## Indépendance des gates

Le gate `workerAdmission` reste indépendant de `catchUpAdmission`,
`firstProcessing`, `http429`, `finality`, `idempotence`, `retention`, `rss` et
`shutdown`, ainsi que de runtime, backlog, erreurs terminales, quarantaine,
hydratation, affinité provider, PumpSwap, replay de versions et cleanup. Tous
doivent passer : un score ou un gate vert n'en compense jamais un autre.

En cas de `FAIL`, `INCONCLUSIVE`, dérive de ressources ou arrêt incomplet,
effectuer le rollback vers
`LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false`, redémarrer en
observe-only et archiver le verdict échoué. Ne jamais supprimer de lignes pour
fabriquer un backlog nul. Aucun wallet, aucun signer, aucun executor, aucune
submission et aucun trade ne sont autorisés par ce canary ; il ne lit aucune
clé, n'arme aucune intention et ne soumet aucune transaction.

## Verdict V1 versionné et attribution terminale

Après capture des quatre snapshots et du heartbeat arrêté, construire uniquement
le manifeste agrégé expurgé V1. Arrêter proprement le listener et vérifier le
heartbeat `STOPPED`, mais conserver PostgreSQL actif. Capturer alors l'attribution
terminale dans le snapshot en lecture seule, avant toute purge ou teardown :

```bash
npm run canary:capture-terminal-attribution -- /absolute/path/to/mainnet-terminal-attribution.v1.json
```

Le fichier est créé exclusivement en mode `0600` et reste un artefact local
owner-only. Ne jamais afficher, journaliser, publier ni envoyer ses
représentants de provenance. L'évaluateur reçoit ensuite les deux fichiers :

```bash
npm run canary:evaluate -- /absolute/path/to/redacted-canary-input.v1.json /absolute/path/to/mainnet-terminal-attribution.v1.json
```

L'ordre opérateur est strict : arrêt du listener en gardant la base active,
capture, évaluation, copie des artefacts owner-only vers le stockage local
protégé, puis seulement purge et teardown. Un artefact d'attribution manquant,
malformé, non réconcilié ou avec overflow donne `INCONCLUSIVE`; il ne peut
jamais produire `PASS`. Un compteur d'attribution incomplète ou une preuve
`UNAVAILABLE` a le même effet.

Un nouveau `FAILED` réellement terminal, une exhaustion ou une nouvelle
`QUARANTINED` prouvée produit `FAIL`, même si un autre regroupement est
incomplet. Un `FAILED` encore `RETRY_PENDING` reste compté mais n'est pas
étiqueté terminal. Le gate décodeur produit `FAIL` devant un diagnostic
`PUMP_BORSH_INVALID` ou une quarantaine catch-up dont la cause fermée est
`PUMP_DECODER`; ce gate ne peut jamais produire `PASS` dans ces cas et aucun
d'eux ne peut être compensé par un autre gate vert.

Cette attribution est uniquement diagnostique : elle n'autorise ni changement
du décodeur, ni changement de retry, ni transaction live. Toute correction de
comportement exige une PR séparée fondée sur une reproduction assainie. Cette
procédure ne lit aucune clé, n'arme aucun executor et ne soumet aucun ordre.

Le verdict est fail-closed. `FAIL` et `INCONCLUSIVE` bloquent tous deux la
readiness Mainnet et tout accès wallet ; seul un `PASS` de chaque gate permet de
poursuivre la procédure opérateur distincte. Le manifeste ne doit contenir ni
URL RPC, signature, mint, wallet, transaction brute, message d'erreur libre ou
secret.

Les règles provider-affines corrigées sont les suivantes :

- `scanActive=true` et `workerClaimReady=true` constituent une phase valide
  quand le même provider public sert le scanner et le worker. Chaque partition
  par source et chaque partition par priorité doit totaliser exactement le
  backlog actionnable ; une preuve absente ou incohérente est `INCONCLUSIVE` ;
- `epochInvalidations` est un compteur diagnostique entier et monotone, pas un
  verdict de mélange provider. Seule une preuve positive de réutilisation entre
  providers produit `FAIL`; un changement sans preuve suffisante reste
  `INCONCLUSIVE` ;
- les diagnostics finality `degraded` et `recovered` sont appariés
  structurellement et chronologiquement. Un incident finality rétabli pendant
  la fenêtre est compatible avec `PASS` lorsque tous les snapshots conservent
  le réconciliateur `RUNNING` et qu'aucune contradiction ne subsiste ; un
  incident ouvert est `FAIL` et une paire malformée est `INCONCLUSIVE` ;
- un backlog durable peut rester après le shutdown. Les cinq composants doivent
  être `STOPPED`, tandis que leases, admission scan, admission worker,
  `queuedFetches`, fetches `in-flight` et cache mémoire doivent être à zéro ;
- le compte SQL frais post-stop doit être égal au backlog du heartbeat et aux
  deux partitions du backlog, par source et par priorité. Un désaccord est
  `INCONCLUSIVE`; il ne faut jamais supprimer les lignes durables pour obtenir
  artificiellement zéro.

Le manifeste V1 applique en plus les invariants fail-closed suivants :

- `terminalEvidence` conserve les totaux `failed`, `quarantined` et `exhausted`
  dans `baseline` et `final`. Les groupes sont réconciliés séparément pour
  `FAILED` et `QUARANTINED`, avec des taxonomies fermées issues des reason codes
  de classification et des error codes d'ingestion. Tout delta expliqué est
  `FAIL`, `exhausted` est prioritaire, et tout groupe absent, incomplet, nul ou
  inconnu est `INCONCLUSIVE` ;
- la preuve first-processing doit appartenir au même processus et à la même
  cohorte ; les `sampledAtMs` sont strictement croissants de T0 au heartbeat
  `STOPPED`, lequel doit être postérieur à T+15 et au snapshot final, mais
  strictement antérieur à la frontière de rétention ;
- pour chaque provider, `http429Responses <= attempts`; un provider non
  configuré doit rester exactement à `0/0`, et un delta HTTP 429 positif prouvé
  est prioritaire sur l'insuffisance de trafic ou une dérive de membership ;
- les compteurs cumulatifs de `blockHydration` sont contrôlés sur chaque
  snapshot et sur `STOPPED`; toute régression produit `INCONCLUSIVE` ;
- une pause périodique authentifiée par un motif fermé, le même provider et le
  même instant produit `INCONCLUSIVE`; une dégradation générique reste `FAIL` ;
- `recoveryStatus=NOT_REQUIRED` exige `recoveryReasonCode=null`, si et seulement
  si aucune récupération n'est requise. Tout autre statut exige un reason code
  fermé non nul.

La révision finale V1 fixe aussi les limites sans entrée opérateur :

- `stoppedAt` de l'artefact devient `stoppedHeartbeat.observedAtMs`; il est
  strictement postérieur au snapshot final. Chaque observation et chaque
  `sampledAtMs` appartient au même processus, précède sa frontière de rétention
  et ne peut jamais transformer une vieille cohorte en `PASS` ;
- la limite RSS n'est pas fournie dans le manifeste. Elle est dérivée de
  `rssBytes` à T+5 en ajoutant le maximum entre 25 % arrondi à l'entier supérieur
  et 128 MiB. Un overflow entier produit `INCONCLUSIVE` ;
- chaque snapshot de `blockHydration` accepte au plus `retainedEntries=64` et
  `retainedBytes=67 108 864`; tout dépassement prouvé produit `FAIL` ;
- le membership RPC T0 est exactement `primary`, `fallback-1`, `fallback-2`,
  `fallback-3`, dans cet ordre. Les relevés suivants acceptent au plus huit
  providers afin qu'un delta HTTP 429 commun reste prioritaire sur une dérive ;
- les diagnostics finality sont bornés à 1024 entrées et ne peuvent dépasser le
  heartbeat STOPPED. Une récupération postérieure ne ferme pas un incident
  encore ouvert à l'arrêt ; les groupes terminaux sont bornés à 128 entrées ;
- le lecteur CLI ouvre le manifeste en lecture seule, sans suivi de symlink et
  sans blocage. Il vérifie deux fois, en entiers bigint, identité, taille et
  timestamps du fichier, puis rejette FIFO, symlink et mutation avec l'erreur
  fixe sans refléter de chemin ou de contenu.

## Quarantaine du décodeur Pump.fun

Le champ public `heartbeat.decoderQuarantine` expose uniquement `version: 1` et
`unresolvedCount`. Une absence historique est `null`, jamais un zéro déduit. Un
compteur non nul identifie un travail d'observation incompatible conservé, sans
exposer signature, mint, payload, URL, message d'erreur ou donnée de wallet.

L'opérateur doit d'abord déployer et vérifier le décodeur corrigé. Si le
compteur est non nul, il identifie les signatures candidates avec la requête
locale suivante, exécutée avec le rôle PostgreSQL dédié au listener :

```sql
SELECT signature
FROM chain_transaction_inbox inbox
WHERE processing_status = 'FAILED'
  AND decoder_quarantine_eligible_at IS NOT NULL
  AND purge_after > clock_timestamp()
ORDER BY terminal_at, signature;
```

Cette liste reste un artefact opérateur local et ne doit pas être publiée. Le
repository pose le marqueur après validation canonique du snapshot et de son
fingerprint lors de la quarantaine ; le compteur ne lit que ce marqueur et
toute dérive ultérieure l’invalide. La commande ci-dessous effectue à nouveau
la validation sous verrou.
Une seule récupération explicite est autorisée par signature en V1. Pour chaque
signature exacte encore retenue, lancer localement :

```bash
npm run inbox:recover-decoder -- --signature=<SIGNATURE> --confirm=<SIGNATURE>
```

La confirmation répétée est obligatoire. Les cinq résultats métier sont
`DECODER_RECOVERY_SCHEDULED`, `DECODER_RECOVERY_ALREADY_SCHEDULED`,
`DECODER_RECOVERY_NOT_FOUND`, `DECODER_RECOVERY_EXPIRED` et
`DECODER_RECOVERY_NOT_ELIGIBLE`. Les erreurs de commande restent redacted.

La récupération n'est possible que pendant les quatre heures suivant la mise
en quarantaine originale. L'heure est réévaluée après verrouillage de la ligne :
une commande commencée avant la limite mais déverrouillée après la limite est
`DECODER_RECOVERY_EXPIRED`. Le reçu d'audit a sa propre purge quatre heures
après la récupération et ne conserve aucune transaction brute.
Un marqueur booléen monotone reste sur la ligne inbox jusqu'à sa purge : il
empêche un second rejeu après expiration du reçu ou après une révision de
finalité. Une commande répétée répond donc
`DECODER_RECOVERY_ALREADY_SCHEDULED` tant que cette ligne est retenue.

Cette commande programme uniquement un rejeu normal du snapshot immuable. Elle
ne prouve ni succès du décodage, ni qualification, ni sellabilité, ni profit.
Elle n'est jamais une autorisation de trade, n'arme aucun executor et ne lit,
ne signe ni ne soumet aucune transaction avec un wallet.

## Diagnostic du réconciliateur de finalité

Une transition causée par un échec de passe vers `DEGRADED` produit le log
structuré `listener.finality_reconciler_degraded` au niveau `warn`. La première
défaillance est journalisée immédiatement ; si l'incident continue, un résumé
borné est journalisé une fois toutes les douze défaillances, jamais une fois par
tentative. Le log ne contient que le diagnostic V1 fermé : horodatages,
`durationMs`, compteurs et reason code. Il ne contient ni erreur brute, stack,
URL, signature, payload, mint, wallet ou secret.

Les reason codes ont le sens opérateur suivant :

- `PROVIDER_UNAVAILABLE` : aucun provider promu exploitable n'est disponible ;
- `PROVIDER_CHANGED` : le provider ou sa révision a changé pendant la passe ;
- `FINALITY_LIST` : la liste des candidats à réconcilier a échoué ;
- `FINALITY_PASS` : la passe globale de réconciliation a échoué ;
- `FINALITY_HISTORY` : la lecture d'historique de signature a échoué ;
- `FINALITY_ROOT` : la lecture du slot racine/finalisé a échoué ;
- `FINALITY_POLL` : l'observation de finalité d'une transaction a échoué ;
- `FINALITY_BLOCK` : la preuve de bloc nécessaire n'est pas disponible ;
- `FINALITY_REVISION` : la révision atomique d'un candidat a échoué ;
- `FINALITY_CLOCK` : l'horloge métier du réconciliateur est invalide ;
- `FINALITY_CONTRADICTION` : les preuves de finalité se contredisent ;
- `UNKNOWN` : un rejet non reconnu a été contenu sans en journaliser la valeur.

La première passe réussie qui suit l'incident produit
`listener.finality_reconciler_recovered` au niveau `info`. Son `durationMs`
indique la durée non régressive entre le début de la dégradation et la reprise,
et ses compteurs décrivent l'incident complet.

Ces événements expliquent le heartbeat ; ils ne le remplacent pas. Tout état
`DEGRADED` n'autorise jamais un verdict `PASS`, même si un log de diagnostic est
présent. Il faut observer la reprise, un heartbeat `RUNNING` cohérent et tous les
autres gates indépendants avant de conclure.

## Population worker-éligible de la cohorte first-processing

La cohorte first-processing mesure uniquement la latence entre la détection
durable d'une transaction worker-éligible et son premier traitement métier
réussi. Une décision d'ingestion qui conclut de façon cohérente qu'aucune
admission worker n'est requise ne constitue pas un échec de traitement. Avant
le tri, la limite de 50 000 lignes et le calcul d'overflow, seules les trois
combinaisons exactes, versionnées lorsqu'un reçu catch-up existe, et non admises
suivantes sont exclues de cette cohorte :

- `IGNORED / SOLANA_TRANSACTION_FAILED` avec `catch_up_enqueued=false` ;
- `IGNORED / NO_SUPPORTED_PUMP_ACTION` avec `catch_up_enqueued=false` ;
- `DEFERRED / PUMP_TRADE_UNTRACKED`, sans reçu catch-up pour une décision
  WebSocket seule ou avec `catch_up_enqueued=false` lorsqu'un reçu catch-up V1
  cohérent existe.

Les deux résultats `IGNORED` exigent une provenance exclusivement `CATCH_UP`
et un reçu V1 complet. Le résultat `DEFERRED / PUMP_TRADE_UNTRACKED` accepte
soit la provenance exacte `WEBSOCKET` sans aucun reçu catch-up, soit les
provenances exactes `WEBSOCKET, CATCH_UP` avec un reçu V1 deferred complet et
cohérent pour le même mint. Toute autre combinaison de provenance reste
worker-éligible et fail-closed.

Cette exclusion exige également la preuve complète que la ligne n'a jamais été
touchée par le worker : aucun essai, lease présent ou historique, snapshot,
fingerprint immuable, traitement, récupération, retry, erreur, preuve de
finalité ou priorité d'admission. Une ligne différée ensuite promue par
`syncTrackedMint()` redevient worker-éligible avec son `first_detected_at`
original, même si son reçu historique conserve `catch_up_enqueued=false`.

Tout `QUARANTINED` reste une preuve bloquante. Tout état malformé, partiel,
inconnu ou contradictoire reste lui aussi worker-éligible et bloquant ; il ne
peut jamais bénéficier d'une exclusion large fondée uniquement sur son statut.
Les trois exclusions retirent seulement des résultats de classification
attendus du calcul de latence : les lignes et leurs reçus restent visibles et
soumis à la rétention normale.

Les gates backlog, finalité, oversize, rétention et HTTP 429 restent strictement
indépendants de cette correction et doivent tous satisfaire leurs propres
critères. Le canary Mainnet échoué du 2026-09-24 doit être rejoué intégralement
sur une base fraîche après fusion ; aucune preuve de cette fenêtre échouée ne
peut être réutilisée pour déclarer un `PASS`.

## Déroulement

1. Copier `deploy/env.example` hors du dépôt et vérifier une baseline saine avec
   `LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false`. Vérifier le genesis
   canonique du cluster et une paire HTTP/WebSocket valide pour chaque provider.
   Puis configurer exactement le profil suivant :

   ```dotenv
   EXECUTION_MODE=observe
   LISTENER_ENABLED=true
   LISTENER_INGESTION_SCOPE=launchpad-only
   LISTENER_CATCH_UP_POLICY=live-edge
   LISTENER_WORKER_COUNT=2
   LISTENER_BLOCK_HYDRATION_ENABLED=true
   LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true
   LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED=true
   LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=true
   LISTENER_PUMPFUN_TRACKING_WINDOW_SECONDS=45
   ```

   `LISTENER_WORKER_COUNT=2` est la première valeur de canary. Le pool reste
   borné à `1..4`; ne tester `3` ou `4` qu'après une fenêtre conforme à `2`.
   Toute valeur supérieure à `1` exige aussi `launchpad-only`. Les fetches bloc
   et les lectures PumpSwap utilisent toujours un seul gate HTTP.
   Le préflight de démarrage doit confirmer l'absence de travail PumpSwap non
   terminal conservé d'un déploiement précédent; sinon le listener refuse de
   démarrer ses workers.
   Le rollback du pool consiste à remettre `LISTENER_WORKER_COUNT=1` puis à
   redémarrer la réplique.

   Compose transmet ce flag restart-only uniquement à `app`; contrôler la
   configuration résolue avant le démarrage.
2. Redémarrer exactement une réplique. Aucun flag n'est modifiable à chaud.
3. Capturer l’état health, le backlog/les échecs terminaux, le RSS et
   `workerAdmission`, `workerAdmissionClock` et `blockHydrationAdmission` à T0,
   T+5 min et T+15 min,
   puis une dernière fois dans
   `FINAL_PRESTOP` immédiatement avant l'arrêt. Ces quatre relevés viennent de
   l’API pendant que l’application tourne. Capturer ensuite `STOPPED` depuis le
   heartbeat PostgreSQL persistant après l’arrêt borné de la seule application :
   l’API du même processus est alors fermée et ne peut pas servir ce relevé. Les
   cinq relevés appartiennent au même processus : un redémarrage entre deux
   relevés invalide la fenêtre. Pour compatibilité des artefacts historiques,
   le fichier HTTP `final` reste l'alias de `FINAL_PRESTOP`, jamais de `STOPPED`.

   Dans chaque artefact, conserver exactement les neuf champs V1
   `version`, `enabled`, `trackingWindowSeconds`, `claimableBacklogCount`,
   `classificationPendingCount`, `oldestClassificationPendingAgeMs`,
   `freshMintCount`, `extendedMintCount` et `demotedCount`. Le manifeste ne
   doit contenir aucun identifiant, signature, mint, wallet ou label. Le CLI
   `canary:evaluate` réapplique le snapshotter domaine exact et rejette toute
   absence, clé additionnelle, valeur non entière ou relation zéro/null invalide.
   Conserver le sidecar exact `workerAdmissionClock` indépendamment de ces neuf
   champs. Ajouter au niveau racine le compte SQL indépendant
   `postStopWorkerAdmissionClaimableCount` et sa preuve liée
   `postStopWorkerAdmissionClaimableProof`; ne jamais les déduire de
   `postStopActionableCount`, qui conserve la population legacy du shutdown.
   Pour l’artefact séparé consacré à la preuve HTTP RPC, archiver uniquement la
   projection fixe suivante de la réponse health :

   `heartbeat.rpcHttpRoleEvidence` est un diagnostic additif pour #218,
   distinct de `rpcHttpEvidence` V1. Ne jamais l'ajouter aux snapshots ou au
   heartbeat STOPPED du manifeste `canary:evaluate` : celui-ci refuse les
   clés supplémentaires avec `INVALID_EVIDENCE` et doit conserver ses 19 gates
   inchangés. Si cet agrégat par rôle est conservé pour une analyse séparée,
   utiliser uniquement ses compteurs et buckets bornés, sans réponse health
   brute, URL, clé, signature ni donnée de wallet ; sa présence ou un zéro 429
   ne prouve ni le plafond RPS propre au projet ni une réserve RPC pour la
   sortie réelle. Une preuve absente ou overflowed reste `INCONCLUSIVE` pour
   #218. La rétention locale de ces diagnostics est limitée à quatre heures
   après la fin de leur utilité.

   ```text
   jq 'def counter: type == "number" and . >= 0 and floor == . and . <= 9007199254740991; def provider: type == "object" and (keys | sort == ["attempts", "configured", "http429Responses", "providerId"]) and (.providerId | type == "string") and (.configured | type == "boolean") and (.attempts | counter) and (.http429Responses | counter) and (.http429Responses <= .attempts) and (.configured or (.attempts == 0 and .http429Responses == 0)); . as $root | {startedAt: (try $root.data.heartbeat.startedAt catch null), rpcHttpEvidence: (try ($root.data.heartbeat.rpcHttpEvidence | if (. == null or (type != "object") or ((keys | sort) != ["overflowed", "providers", "version"]) or .version != 1 or (.overflowed | type) != "boolean" or (.providers | type) != "array" or (.providers | length) != 4 or (any(.providers[]; provider | not)) or ([.providers[].providerId] != ["primary", "fallback-1", "fallback-2", "fallback-3"]) or (any(.providers[]; .http429Responses > .attempts))) then null else {version: .version, overflowed: .overflowed, providers: [.providers[] | {providerId, configured, attempts, http429Responses}]} end) catch null)}' health.json
   ```

   Pour l'artefact first-processing séparé, appliquer à chacun des trois health
   API le filtre fermé ci-dessous. Il reconstruit exclusivement les champs V1
   autorisés et transforme toute absence, clé supplémentaire, entier dangereux,
   total incohérent ou verdict impossible en `null`; il ne fabrique jamais un
   zéro passant. Répéter la commande en remplaçant `health.json`, puis archiver
   exactement `T0.firstProcessingCanary`, `T+5.firstProcessingCanary` et
   `T+15.firstProcessingCanary`; l'extraction PostgreSQL produira ensuite
   `final.firstProcessingCanary` avec le même filtre.

   ```text
   jq 'def integer: type == "number" and . >= 0 and floor == . and . <= 9007199254740991 and tostring != "-0";
   def evidence:
     type == "object"
     and (keys | sort == ["atOrAboveThresholdCount", "cohortCapacity", "cohortEndsAtMs", "cohortStartedAtMs", "completedCount", "eligibleCount", "invalidDurationCount", "overflowed", "p95Ms", "pendingCount", "rightCensoredCount", "sampledAtMs", "tailCensoredCount", "terminalCount", "thresholdMs", "unavailableCount", "underThresholdCount", "verdict", "version"])
     and .version == 1 and .thresholdMs == 45000 and .cohortCapacity == 50000
     and (.cohortStartedAtMs | integer) and .cohortStartedAtMs <= 9007199240340991
     and (.cohortEndsAtMs | integer) and .cohortEndsAtMs == (.cohortStartedAtMs + 900000)
     and (.sampledAtMs | integer) and .sampledAtMs >= .cohortStartedAtMs
     and (.overflowed | type == "boolean")
     and (.eligibleCount | integer) and .eligibleCount <= .cohortCapacity
     and ((.overflowed | not) or .eligibleCount == .cohortCapacity)
     and (.completedCount | integer) and (.underThresholdCount | integer)
     and (.atOrAboveThresholdCount | integer) and (.pendingCount | integer)
     and (.rightCensoredCount | integer) and (.tailCensoredCount | integer)
     and (.terminalCount | integer) and (.unavailableCount | integer)
     and (.invalidDurationCount | integer)
     and (.completedCount == (.underThresholdCount + .atOrAboveThresholdCount))
     and (.pendingCount == (.rightCensoredCount + .tailCensoredCount))
     and (.eligibleCount == (.completedCount + .pendingCount + .terminalCount + .unavailableCount + .invalidDurationCount))
     and (if .p95Ms == null then .completedCount == 0 else
       (.p95Ms | integer) and .completedCount > 0
       and (((95 * .completedCount + 99) / 100 | floor) as $rank
         | (($rank <= .underThresholdCount and .p95Ms < .thresholdMs)
           or ($rank > .underThresholdCount and .p95Ms >= .thresholdMs)))
     end)
     and (.verdict == (if (.invalidDurationCount > 0 or (.p95Ms != null and .p95Ms >= .thresholdMs)) then "FAIL" elif (.sampledAtMs >= (.cohortStartedAtMs + 14400000) or .sampledAtMs < (.cohortEndsAtMs + .thresholdMs) or .eligibleCount == 0 or .overflowed or .pendingCount > 0 or .terminalCount > 0 or .unavailableCount > 0) then "INCONCLUSIVE" else "PASS" end));
   . as $root
   | {startedAt: (try $root.data.heartbeat.startedAt catch null), firstProcessingCanary: (try ($root.data.heartbeat.firstProcessingCanary | if evidence then {version, thresholdMs, cohortCapacity, cohortStartedAtMs, cohortEndsAtMs, sampledAtMs, overflowed, eligibleCount, completedCount, underThresholdCount, atOrAboveThresholdCount, pendingCount, rightCensoredCount, tailCensoredCount, terminalCount, unavailableCount, invalidDurationCount, p95Ms, verdict} else null end) catch null)}' health.json > first-processing
   ```

   Vérifier que les trois projections portent le même `startedAt` et le même
   `cohortStartedAtMs`. Attendre que le relevé T+15 prouve
   `sampledAtMs >= cohortEndsAtMs` : la cohorte fixe se ferme naturellement à
   T+15. Aucune nouvelle ligne n'est admise dans cette cohorte pendant le drain,
   même si l'application continue à observer et traiter du trafic ultérieur.

   Après cette fermeture naturelle à T+15, attendre le drain complet de 45
   secondes, arrêter uniquement `app`, laisser PostgreSQL actif, puis extraire
   exactement la ligne `STOPPED` persistée. La requête fabrique une enveloppe
   temporaire limitée à `startedAt`, `rpcHttpEvidence` et
   `firstProcessingCanary`; les mêmes filtres fermés valident ensuite les deux
   preuves indépendantes. Une ligne absente, multiple ou invalide fait échouer
   la commande et interdit un verdict `PASS`. Le heartbeat `STOPPED` doit être
   plus récent que T+15 et porter exactement la même cohorte :

   ```bash
   set -euo pipefail
   : "${DEPLOY_ENV:?DEPLOY_ENV must reference the external operator environment file}"
   final_source="$(mktemp)"
   trap 'rm -f "$final_source"' EXIT
   sleep 45
   docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 app
   docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener exec -T postgres sh -c 'exec psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --tuples-only --no-align' <<'SQL' > "$final_source"
   SELECT jsonb_build_object(
     'data', jsonb_build_object(
       'heartbeat', jsonb_build_object(
         'startedAt', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'rpcHttpEvidence', payload -> 'rpcHttpEvidence',
         'firstProcessingCanary', payload -> 'firstProcessingCanary',
         'workerAdmission', payload -> 'workerAdmission',
         'workerAdmissionClock', payload -> 'workerAdmissionClock',
         'blockHydrationAdmission', payload -> 'blockHydrationAdmission'
       )
     )
   )
   FROM listener_heartbeats
   WHERE service_key = 'transaction-listener'
     AND runtime_state = 'STOPPED';
   SQL
   test "$(wc -l < "$final_source")" -eq 1
   jq -e 'def counter: type == "number" and . >= 0 and floor == . and . <= 9007199254740991; def provider: type == "object" and (keys | sort == ["attempts", "configured", "http429Responses", "providerId"]) and (.providerId | type == "string") and (.configured | type == "boolean") and (.attempts | counter) and (.http429Responses | counter) and (.http429Responses <= .attempts) and (.configured or (.attempts == 0 and .http429Responses == 0)); . as $root | {startedAt: (try $root.data.heartbeat.startedAt catch null), rpcHttpEvidence: (try ($root.data.heartbeat.rpcHttpEvidence | if (. == null or (type != "object") or ((keys | sort) != ["overflowed", "providers", "version"]) or .version != 1 or (.overflowed | type) != "boolean" or (.providers | type) != "array" or (.providers | length) != 4 or (any(.providers[]; provider | not)) or ([.providers[].providerId] != ["primary", "fallback-1", "fallback-2", "fallback-3"]) or (any(.providers[]; .http429Responses > .attempts))) then null else {version: .version, overflowed: .overflowed, providers: [.providers[] | {providerId, configured, attempts, http429Responses}]} end) catch null)} | select(.startedAt != null and .rpcHttpEvidence != null)' "$final_source" > final
   jq -e 'def integer: type == "number" and . >= 0 and floor == . and . <= 9007199254740991 and tostring != "-0";
   def evidence:
     type == "object"
     and (keys | sort == ["atOrAboveThresholdCount", "cohortCapacity", "cohortEndsAtMs", "cohortStartedAtMs", "completedCount", "eligibleCount", "invalidDurationCount", "overflowed", "p95Ms", "pendingCount", "rightCensoredCount", "sampledAtMs", "tailCensoredCount", "terminalCount", "thresholdMs", "unavailableCount", "underThresholdCount", "verdict", "version"])
     and .version == 1 and .thresholdMs == 45000 and .cohortCapacity == 50000
     and (.cohortStartedAtMs | integer) and .cohortStartedAtMs <= 9007199240340991
     and (.cohortEndsAtMs | integer) and .cohortEndsAtMs == (.cohortStartedAtMs + 900000)
     and (.sampledAtMs | integer) and .sampledAtMs >= .cohortStartedAtMs
     and (.overflowed | type == "boolean")
     and (.eligibleCount | integer) and .eligibleCount <= .cohortCapacity
     and ((.overflowed | not) or .eligibleCount == .cohortCapacity)
     and (.completedCount | integer) and (.underThresholdCount | integer)
     and (.atOrAboveThresholdCount | integer) and (.pendingCount | integer)
     and (.rightCensoredCount | integer) and (.tailCensoredCount | integer)
     and (.terminalCount | integer) and (.unavailableCount | integer)
     and (.invalidDurationCount | integer)
     and (.completedCount == (.underThresholdCount + .atOrAboveThresholdCount))
     and (.pendingCount == (.rightCensoredCount + .tailCensoredCount))
     and (.eligibleCount == (.completedCount + .pendingCount + .terminalCount + .unavailableCount + .invalidDurationCount))
     and (if .p95Ms == null then .completedCount == 0 else
       (.p95Ms | integer) and .completedCount > 0
       and (((95 * .completedCount + 99) / 100 | floor) as $rank
         | (($rank <= .underThresholdCount and .p95Ms < .thresholdMs)
           or ($rank > .underThresholdCount and .p95Ms >= .thresholdMs)))
     end)
     and (.verdict == (if (.invalidDurationCount > 0 or (.p95Ms != null and .p95Ms >= .thresholdMs)) then "FAIL" elif (.sampledAtMs >= (.cohortStartedAtMs + 14400000) or .sampledAtMs < (.cohortEndsAtMs + .thresholdMs) or .eligibleCount == 0 or .overflowed or .pendingCount > 0 or .terminalCount > 0 or .unavailableCount > 0) then "INCONCLUSIVE" else "PASS" end));
   . as $root
   | {startedAt: (try $root.data.heartbeat.startedAt catch null), firstProcessingCanary: (try ($root.data.heartbeat.firstProcessingCanary | if evidence then {version, thresholdMs, cohortCapacity, cohortStartedAtMs, cohortEndsAtMs, sampledAtMs, overflowed, eligibleCount, completedCount, underThresholdCount, atOrAboveThresholdCount, pendingCount, rightCensoredCount, tailCensoredCount, terminalCount, unavailableCount, invalidDurationCount, p95Ms, verdict} else null end) catch null)}
   | select(.startedAt != null and .firstProcessingCanary != null)' "$final_source" > final.firstProcessingCanary
   test -s final
   test -s final.firstProcessingCanary
   jq -e --slurpfile t15 T+15.firstProcessingCanary '($t15 | length == 1) and (.startedAt == $t15[0].startedAt) and (.firstProcessingCanary.cohortStartedAtMs == $t15[0].firstProcessingCanary.cohortStartedAtMs) and (.firstProcessingCanary.sampledAtMs > $t15[0].firstProcessingCanary.sampledAtMs)' final.firstProcessingCanary > /dev/null
   rm -f "$final_source"
   trap - EXIT
   ```

   Après l'arrêt de tous les writers du périmètre et avant toute purge, exécuter
   la requête SQL post-stop suivante avec le rôle PostgreSQL dédié au listener.
   Lier `$1` à l'entier `workerAdmissionClock.sampledAtMs` enregistré dans le
   heartbeat durable `STOPPED`, jamais à l'heure d'exécution de cette requête.
   Elle reprend exactement la population claimable et les
   cinq preuves d'autorité utilisées par le repository avec la fenêtre V1 de
   45 secondes. Sa sortie agrégée contient l'instant lié et
   `postStopWorkerAdmissionClaimableCount`; elle ne révèle aucune signature,
   aucun mint, wallet, identifiant ou label :

   ```sql
   WITH database_clock AS MATERIALIZED (
     SELECT to_timestamp($1::NUMERIC / 1000) AS at
   ), fresh_launch AS MATERIALIZED (
     SELECT DISTINCT launch.mint
     FROM token_launches AS launch
     JOIN domain_events AS launch_event
       ON launch_event.type = 'TokenLaunchDetected'
      AND launch_event.mint = launch.mint
      AND launch_event.signature = launch.created_signature
      AND launch_event.slot = launch.created_slot
      AND launch_event.transaction_index = launch.created_transaction_index
      AND launch_event.instruction_index = launch.created_instruction_index
      AND launch_event.inner_instruction_index IS NOT DISTINCT FROM
        launch.created_inner_instruction_index
     CROSS JOIN database_clock
     WHERE launch.current_state <> 'RETRACTED'
       AND launch_event.confirmation_status <> 'orphaned'
       AND launch.detected_at + (45 * INTERVAL '1 second') > database_clock.at
   ), extended_mint AS MATERIALIZED (
     SELECT candidate.mint
     FROM trading_candidates AS candidate
     JOIN domain_events AS source_event
       ON source_event.event_id = candidate.source_event_id
     CROSS JOIN database_clock
     WHERE candidate.superseded_at IS NULL
       AND candidate.state = 'ELIGIBLE'
       AND candidate.confirmation_status <> 'orphaned'
       AND source_event.confirmation_status <> 'orphaned'
       AND candidate.eligible_until > database_clock.at
     UNION SELECT session.mint FROM paper_strategy_sessions AS session
       WHERE session.state IN ('BUY_PENDING', 'PAPER_HOLDING',
         'WAITING_EXTERNAL_BUYS', 'EXIT_PENDING_QUOTE', 'SELL_PENDING')
     UNION SELECT position.mint FROM paper_positions AS position
       WHERE position.status = 'PAPER_HOLDING'
     UNION SELECT intent.mint FROM execution_intents AS intent
       WHERE intent.terminal_at IS NULL
         AND intent.status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
     UNION SELECT live.mint FROM listener_worker_tracking_live_mints AS live
   )
   SELECT (SELECT (EXTRACT(EPOCH FROM at) * 1000)::BIGINT
     FROM database_clock) AS "sampledAtMs", COUNT(*) FILTER (
     WHERE (
       (inbox.processing_status = 'PENDING'
         AND inbox.attempts_in_cycle < inbox.retry_max_attempts)
       OR (inbox.processing_status = 'FAILED'
         AND inbox.error_retryable = TRUE
         AND inbox.retry_exhausted_at IS NULL
         AND inbox.next_attempt_at <= database_clock.at
         AND inbox.attempts_in_cycle < inbox.retry_max_attempts)
       OR (inbox.processing_status = 'PROCESSING'
         AND inbox.lease_expires_at <= database_clock.at
         AND inbox.attempts_in_cycle < inbox.retry_max_attempts)
     )
     AND inbox.worker_admitted_at IS NOT NULL
     AND (
       NOT (inbox.ingestion_priority = 'TRACKED_TRADE'
         AND inbox.ingestion_hint = 'PUMPFUN_TRADE')
       OR NOT (
         inbox.processing_status = 'PENDING'
         AND inbox.ingestion_priority = 'TRACKED_TRADE'
         AND inbox.ingestion_hint = 'PUMPFUN_TRADE'
         AND inbox.ingestion_hint_mint IS NOT NULL
         AND inbox.worker_admitted_at IS NOT NULL
         AND inbox.attempts = 0 AND inbox.attempts_in_cycle = 0
         AND inbox.lease_token IS NULL AND inbox.lease_expires_at IS NULL
         AND inbox.normalized_transaction IS NULL
         AND inbox.immutable_fingerprint IS NULL
         AND inbox.error_code IS NULL AND inbox.error_name IS NULL
         AND inbox.error_retryable IS NULL AND inbox.next_attempt_at IS NULL
         AND inbox.retry_exhausted_at IS NULL AND inbox.processed_at IS NULL
         AND inbox.missing_finality_polls = 0
         AND inbox.last_missing_finality_provider_id IS NULL
         AND inbox.finality_evidence_version = 0
         AND inbox.manual_recovery_count = 0
         AND inbox.last_manual_recovery_at IS NULL
         AND inbox.first_processed_at IS NULL
         AND inbox.first_processing_evidence_unavailable = FALSE
         AND inbox.decoder_quarantine_eligible_at IS NULL
         AND inbox.decoder_recovery_used = FALSE
       )
       OR EXISTS (
         SELECT 1 FROM fresh_launch
         WHERE fresh_launch.mint = inbox.ingestion_hint_mint
       )
       OR EXISTS (
         SELECT 1 FROM extended_mint
         WHERE extended_mint.mint = inbox.ingestion_hint_mint
       )
     )
   ) AS "postStopWorkerAdmissionClaimableCount"
   FROM chain_transaction_inbox AS inbox
   CROSS JOIN database_clock;
   ```

   Archiver le compte historique `postStopWorkerAdmissionClaimableCount` et la
   preuve exacte `postStopWorkerAdmissionClaimableProof` de forme
   `{version: 1, sampledAtMs, claimableBacklogCount}` dans le manifeste V1.
   Les trois comptes (métriques `STOPPED`, entier historique et preuve SQL)
   doivent être identiques, tout comme les instants de la preuve et du clock
   `STOPPED`. Conserver également le vrai `workerAdmissionClock` de chacun des
   quatre snapshots : entier positif représentable en date, compris entre
   l'ancre du processus et son `observedAtMs`; les samples doivent être
   non décroissants (un heartbeat répété peut conserver le même sample).
   Ne jamais reconstruire un clock à partir d'un timestamp d'observation.

   Cette requête lit les lignes actuelles de la base arrêtée, pas un snapshot
   historique ni un voyage dans le temps. Des écritures pertinentes intervenues
   après le sample restent visibles et peuvent produire un désaccord. L'égalité
   de comptes ne prouve ni l'identité des lignes ni l'absence de mutations qui
   se compensent. Une preuve absente, échouée, malformée, de clock différent ou
   capturée avant `STOPPED` vaut `INCONCLUSIVE`; ne jamais substituer le compte
   legacy `postStopActionableCount`. Les anciens manifestes sans clock/preuve
   restent lisibles mais ne peuvent pas obtenir `PASS` au gate worker admission.
   Déployer ensemble readers et writers compatibles : les anciens binaires à
   allowlist stricte ne comprennent pas ces nouveaux champs optionnels V1.

   Nommer les quatre fichiers HTTP `T0`, `T+5`, `T+15` et `final`, et les quatre
   fichiers de latence `T0.firstProcessingCanary`,
   `T+5.firstProcessingCanary`, `T+15.firstProcessingCanary` et
   `final.firstProcessingCanary`. Cette projection
   ne contient aucune URL, clé, signature, mint ou corps de requête/réponse.
   Cet artefact est uniquement la preuve HTTP RPC de #142. Les autres gates
   conservent leurs propres snapshots et artefacts (blockHydration, pipeline,
   backlog, RSS et métriques de latence); cette projection ne les remplace pas.
4. Calculer entre T0 et `final` le delta agrégé `attempts` et le delta agrégé
   `http429Responses`. Le delta `attempts` doit être strictement positif et le
   delta HTTP 429 doit être exactement égal à zéro. Vérifier à chaque relevé le
   même `startedAt`, la même membership des providers configurés (identifiants
   et booléens; état `configured` stable) et `overflowed=false`.
5. Classer la fenêtre `PASS`, `FAIL` ou `INCONCLUSIVE` avec la matrice ci-dessous.
   Un trafic insuffisant pour produire un delta `attempts` strictement positif
   rend le test `INCONCLUSIVE`, jamais `PASS` implicite.
6. Pour chaque fenêtre, conserver une preuve RPC publique expurgée de lecture
   réussie : slot public, identifiant de provider non sensible (jamais une URL,
   un host privé ou un alias secret), statut HTTP, catégorie RPC, version de
   transaction et nombre agrégé de transactions. Ne jamais conserver d'URL
   signée, de clé, de corps de bloc complet ni de signature. Le jeu supporté par
   cette release est strictement `legacy`, v0 (`version=0`) et v1 (`version=1`);
   il ne doit pas être déduit des seules versions actuellement observées sur le
   cluster. Pour chacune de ces trois versions, lire avec le provider configuré
   un bloc public connu et conserver la preuve de succès correspondante. Un
   fixture public expurgé peut seulement compléter la preuve de normalisation
   hors réseau; il ne remplace jamais la preuve RPC.
7. Rejouer la preuve sur une base fraîche, créée pour cette fenêtre et sans
   checkpoint, inbox, receipt ou cache antérieur. Le replay doit hydrater et
   normaliser les trois versions sans aucune écriture, signature ou soumission
   on-chain, sans wallet. Les écritures PostgreSQL observe-only nécessaires
   (inbox, checkpoints, snapshots, receipts, health et cache durable) sont
   attendues, isolées sur cette base fraîche et incluses dans le résultat du
   replay. Archiver ce résultat avec la preuve RPC publique expurgée.

## Continuation bornée de la tête catch-up

`CATCH_UP_REFRESH_REQUIRED` signifie qu'une reprise durable vient d'atteindre
sa tête gelée H1 et qu'un second scan doit couvrir la tête fraîche H2 vers H1.
Le listener autorise exactement un scan supplémentaire sur le même provider,
la même session WebSocket et le même signal d'arrêt. Il ne ferme ni ne rouvre la
session entre ces deux passes et ne promeut jamais un candidat avant la réussite
de la seconde passe. Une session déjà promue continue son ingestion durable
pendant cette continuation périodique sérialisée.

Un deuxième `CATCH_UP_REFRESH_REQUIRED` dans la même opération, un
`CATCH_UP_PAGE_BUDGET_EXHAUSTED`, un provider différent, une erreur malformée,
une fin de session ou un arrêt ne sont jamais assimilés à un succès. Un deuxième
refresh ou une pause ferme la session puis applique le jitter. Une erreur
transitoire ou une fin de session publie `DEGRADED` et déclenche la récupération
existante ; l'incumbent peut rester ouvert jusqu'à son remplacement borné. Un
arrêt ferme les ressources, publie `STOPPING` puis `STOPPED` et ne programme
aucun retry. Tous ces chemins restent fail-closed. Toute répétition pendant la
fenêtre rend le gate backlog/finalité
`FAIL` ou `INCONCLUSIVE` selon les preuves disponibles ; elle ne peut jamais
constituer un `PASS`. Ce comportement ne modifie ni la concurrence RPC, ni la
cadence d'hydratation, ni les gates oversize, rétention ou HTTP 429.

## Gates PASS

### Verdict de la preuve HTTP RPC

| Observation sur les relevés T0/T+5/T+15/`final` | Verdict |
| --- | --- |
| Même `startedAt`, membership/configuration stable, `overflowed=false`, delta `attempts` strictement positif et delta HTTP 429 exactement zéro | `PASS` pour le gate HTTP 429 |
| Delta HTTP 429 strictement positif prouvé par les relevés | `FAIL` |
| Redémarrage (restart), relevé `final` manquant, trafic nul (trafic zéro), métrique absente ou malformée, compteur régressif, relation impossible (`http429Responses > attempts`), `overflowed=true` ou changement de membership des providers configurés | `INCONCLUSIVE` |

Le `FAIL` est réservé à un delta HTTP 429 positif prouvé par les relevés. Un
changement de membership reste `INCONCLUSIVE`, sauf si un delta HTTP 429 positif
est observé indépendamment et le prouve. Une métrique absente, malformée ou en
overflow ne devient jamais zéro par défaut. Un `final` absent ne permet jamais
de conclure `PASS`, même si T+15 est propre. Le delta `attempts` nul est un
trafic nul et reste `INCONCLUSIVE`.
Un restart, un `final` manquant, un trafic zéro, une métrique absente ou
malformée, ou `overflowed=true` classe la fenêtre `INCONCLUSIVE`.
Un delta HTTP 429 positif entraîne `FAIL`.
Un changement de membership des providers configurés entraîne
`INCONCLUSIVE`, sauf lorsqu’un delta HTTP 429 positif est prouvé
indépendamment.
Le #142 prouve uniquement le gate HTTP 429; le #143 reste nécessaire pour la
latence first-processing et son p95.

### Verdict de latence first-processing

Le verdict du gate de latence se lit uniquement dans le
`firstProcessingCanary` du heartbeat PostgreSQL `STOPPED`, après contrôle des
quatre snapshots. Le `startedAt` et le `cohortStartedAtMs` doivent être
identiques dans T0, T+5, T+15 et `final`; la valeur finale
`sampledAtMs` doit être strictement supérieure à celle de T+15. Le verdict est
exactement celui-ci :

| Observation first-processing finale | Verdict |
| --- | --- |
| Après fermeture et drain, cohorte non vide et non overflowée, toutes les lignes complétées, aucun censored/terminal/unavailable/invalide, p95 de 44 999 ms au plus | `PASS` |
| p95 de 45 000 ms exactement ou davantage, ou durée invalide | `FAIL` |
| Ligne right-censored ou tail-censored, cohorte vide, overflow, restart, `final` manquant/absent, preuve absente ou malformée, cohorte ou `startedAt` changé | `INCONCLUSIVE` |
| `sampledAtMs` atteint le premier instant de purge, exactement quatre heures après `cohortStartedAtMs` | `INCONCLUSIVE` |

Une ligne censored n'est jamais assimilée à une réussite :
`pendingCount = rightCensoredCount + tailCensoredCount` doit rester nul pour
passer. Un terminal, une preuve historique `unavailable`, une métrique manquante
ou malformée, un overflow ou une cohorte sans trafic restent fail-closed en
`INCONCLUSIVE`. Un `invalidDurationCount > 0` ou un p95 à partir de 45 000 ms
produit `FAIL`; ce `FAIL` est prioritaire et précède `INCONCLUSIVE` même si une
autre catégorie rend aussi la cohorte incomplète. Un résultat interne `PASS`
ne sauve jamais une fenêtre où l'un des quatre snapshots prouve un restart ou
où le heartbeat final n'est pas postérieur à T+15 avec la même cohorte. Dès le
premier instant de purge possible, à quatre heures du début de cohorte, une
suppression partielle peut avoir amputé l'échantillon : le verdict devient donc
`INCONCLUSIVE`. Un p95 en échec ou une durée invalide reste toutefois `FAIL`.
Le purgeur conserve toute ligne post-migration depuis son `first_detected_at`
durable pendant au moins quatre heures avant suppression, même si
`classifiedAtMs` et `purge_after` sont antérieurs. Les lignes historiques où
`first_detected_at` est `NULL` conservent la règle `purge_after` existante.
Cette protection borne le premier instant de purge sans remplacer le verdict
fail-closed ci-dessus.

Le gate HTTP 429 reste indépendant et distinct du gate de latence
first-processing : l'un ne peut compenser l'autre. Les autres gates backlog,
RSS, finalité, idempotence, rétention, affinité provider et shutdown restent
eux aussi indépendants, avec leurs snapshots et critères propres.

- zéro HTTP 429 dans les métriques fournisseur ou les logs;
- `heartbeat.blockHydration.enabled=true`, `version=1` et
  `callerConcurrency=1` à chaque relevé T0, T+5 min et T+15 min; une valeur
  conforme prouve que le chemin activé est observé. Toute autre valeur entraîne
  `FAIL`;
- `pipeline.pumpswap=IDLE` à chaque relevé confirme que le scope effectif est
  `launchpad-only`; toute autre valeur entraîne `FAIL`;
- `queuedFetches <= 1` et `inFlightFetches <= 1` à chaque relevé, avec backlog
  inbox non croissant;
- `heartbeat.blockHydrationAdmission` exact et activé aux cinq frontières,
  pending borné et somme groupes/réservations au plus un ; au `STOPPED`, zéro
  pending worker/classifier, réservation et groupe actif. Une ancienne preuve
  sans ce champ ne peut pas donner `PASS` au nouveau contrat d'admission ;
- aucun nouvel échec terminal inexpliqué;
- le runtime lit et normalise le jeu strictement supporté par cette release :
  `legacy`, v0 (`version=0`) et v1 (`version=1`), chacun démontré par un bloc
  public connu lu avec le provider configuré; une réponse JSON-RPC contenant
  l'erreur `-32015` est un `FAIL` bloquant, même si le transport HTTP répond
  `200`;
- la preuve RPC publique expurgée et le replay sur base fraîche sont présents et
  concordants; une preuve partielle, un fixture hors réseau présenté comme
  preuve RPC, un replay contaminé par un état antérieur ou une version supportée
  non couverte est `FAIL`;
- delta `fetches` strictement positif sur la fenêtre; un delta nul dû à un
  trafic insuffisant classe la fenêtre `INCONCLUSIVE` tant qu’aucun autre gate
  n’a échoué;
- delta `fetches` moyen inférieur ou égal à 4/s (nominal attendu ~2,5/s);
- p95 détection → traitement strictement inférieur à 45 s;
- aucun oversize récurrent (au plus un pendant la fenêtre);
- `retainedEntries <= 64`, `retainedBytes <= 67 108 864` et queue bornée;
- RSS final inférieur ou égal au RSS T+5 min augmenté du plus grand de 25 % ou
  128 MiB.
- `heartbeat.catchUpAdmission.version=1`, `enabled=true`, un `providerId` public
  cohérent et `workerClaimReady`/`scanActive` cohérents avec la phase observée;
  les catégories de backlog source sont disjointes et les priorités totalisent
  le backlog actionnable;
- `heartbeat.workerAdmission.version=1`, `enabled=true` et
  `trackingWindowSeconds=45` aux cinq frontières ; depuis T+5, dette de
  classification et backlog claimable non croissants, aucun âge pending à
  45 000 ms ou davantage ; à chaque frontière, le claimable et la somme
  claimable + pending restent inférieurs ou égaux au backlog legacy, et le
  claimable `STOPPED` égale le compte SQL dédié
  `postStopWorkerAdmissionClaimableCount` et celui de la preuve
  `postStopWorkerAdmissionClaimableProof`, liée exactement au clock `STOPPED`.
  Les cinq clocks sont présents, valides, non décroissants et compris entre
  le démarrage du processus et leur observation. Le compte distinct
  `postStopActionableCount` reste la preuve du shutdown legacy;
- l'affinité provider est conservée pendant chaque scan strict : aucun résultat
  ou cache d'un provider remplacé n'est réutilisé, et le cache unique reste à
  quatre fetches démarrés/s ou moins globalement;
- finalité et idempotence restent correctes sur les chevauchements
  WebSocket/catch-up; `DEFERRED`, `IGNORED` et `QUARANTINED` restent visibles et
  les receipts/admissions se conservent quatre heures;
- le shutdown arrête les nouvelles admissions, draine dans le délai borné et
  laisse le health final propre, sans fuite de file ou de cache.

Diagnostic additionnel #216 : archiver séparément, avant le nettoyage du
canary, `mainnet-scanner-attribution.v1.json` (T0, T+5, T+15,
FINAL_PRESTOP, STOPPED). Chaque échantillon porte `VALID`, `MISSING`,
`MALFORMED` ou `OVERFLOW`. Le sidecar provient du heartbeat public et de
l'agrégat final PostgreSQL ; son constructeur fermé élimine toute identité
de transaction et tout message libre. Le manifeste et les 19 gates V1 restent
inchangés. Un sidecar manquant n'est pas un PASS. Un probe observe-only court
peut comparer les deltas source/hydratation/admission/front avec l'âge de la
dette, mais ne remplace jamais le canary complet de 15 minutes.

Pour le gate HTTP 429, seul un delta positif prouvé est `FAIL`; les autres
observations de la matrice restent `INCONCLUSIVE`. Les gates opérationnels
distincts ci-dessus conservent leurs propres critères. Deux niveaux de rollback
existent. Avant ces deux niveaux, le rollback isolé #146 consiste à remettre
`LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED=false` puis redémarrer :
l'admission B3b reste active et toutes les signatures reprennent le chemin
d'hydratation complet.

0. **Rollback #177 admission worker bornée.** Remettre
   `LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false`, conserver la
   fenêtre à `45`, puis redémarrer la réplique. Les métriques bornées repassent
   au contrat OFF et aucun état durable n'est effacé.

1. **Rollback B3b admission-only.** Remettre
   `LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false` puis redémarrer la
   réplique. La métrique brute `catchUpAdmission` est alors omise du heartbeat et
   l'API projette `heartbeat.catchUpAdmission: null`; l'hydratation bloc legacy
   reste active avec `LISTENER_BLOCK_HYDRATION_ENABLED=true`. Vérifier que la file
   revient à zéro et que le backlog reprend sa tendance de baseline.
2. **Rollback complet d'hydratation bloc.** Remettre
   `LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false` et
   `LISTENER_BLOCK_HYDRATION_ENABLED=false`, puis redémarrer la réplique. Vérifier
   `heartbeat.blockHydration.enabled=false`, la file à zéro et le retour à la
   baseline legacy.

Ne jamais supprimer checkpoint ou donnée durable pour masquer un échec : les
receipts historiques restent retenus quatre heures.

# Canary Mainnet post-merge d’hydratation et admission Pump.fun — 15 minutes

Version : 1.2.7 — 2026-09-25 — issues #114, #142, #143, #146, #148, #151, #153 et #155.

Cette procédure post-merge est opérateur-only et observe-only et ne confère
aucune autorité wallet, signer ou submit : elle ne connecte ni ne lit aucun
wallet ou clé privée, ne compose aucun executor, n'arme, ne signe et ne soumet
aucune transaction. Elle est séparée de ce merge : aucune
readiness Mainnet n'est déclarée avant que cette fenêtre ait passé. Utiliser une
seule réplique avec `LISTENER_INGESTION_SCOPE=launchpad-only`, en mode `observe`.
Archiver le health, les compteurs inbox, le RSS et le tableau fournisseur avant
activation.

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
réussi. Une classification catch-up qui conclut de façon cohérente qu'aucune
admission worker n'est requise ne constitue pas un échec de traitement. Avant
le tri et la limite de 50 000 lignes, seules les trois combinaisons exactes,
versionnées et non admises suivantes sont exclues de cette cohorte :

- `IGNORED / SOLANA_TRANSACTION_FAILED` avec `catch_up_enqueued=false` ;
- `IGNORED / NO_SUPPORTED_PUMP_ACTION` avec `catch_up_enqueued=false` ;
- `DEFERRED / PUMP_TRADE_UNTRACKED` avec `catch_up_enqueued=false`.

Cette exclusion exige également la preuve complète que la ligne n'a jamais été
touchée par le worker : aucun essai, lease présent ou historique, snapshot,
fingerprint immuable, traitement, récupération, retry, erreur, preuve de
finalité ou priorité d'admission. La provenance doit être exclusivement
`CATCH_UP` et le reçu V1 complet doit être cohérent ; une provenance mêlant
`WEBSOCKET` et `CATCH_UP`, ou tout champ de reçu absent ou contradictoire,
reste worker-éligible et fail-closed. Une ligne différée ensuite promue par
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
   LISTENER_BLOCK_HYDRATION_ENABLED=true
   LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true
   LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED=true
   ```

   Compose transmet ce flag restart-only uniquement à `app`; contrôler la
   configuration résolue avant le démarrage.
2. Redémarrer exactement une réplique. Aucun flag n'est modifiable à chaud.
3. Capturer l’état health, le backlog/les échecs terminaux et le RSS à T0, T+5
   min et T+15 min. Les trois premiers relevés viennent de l’API pendant que
   l’application tourne. Capturer ensuite un relevé `final` depuis le heartbeat
   PostgreSQL persistant après l’arrêt borné de la seule application : l’API du
   même processus est alors fermée et ne peut pas servir ce relevé. Les quatre
   relevés appartiennent au même processus : un redémarrage entre deux relevés
   invalide la fenêtre.
   Pour l’artefact séparé consacré à la preuve HTTP RPC, archiver uniquement la
   projection fixe suivante de la réponse health :

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
         'firstProcessingCanary', payload -> 'firstProcessingCanary'
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
une fin de session ou un arrêt ne sont jamais assimilés à un succès : le chemin
fail-closed existant ferme la session, publie `DEGRADED` et applique le jitter.
Toute répétition de ce cas pendant la fenêtre rend le gate backlog/finalité
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
- l'affinité provider est conservée pendant chaque scan strict : aucun résultat
  ou cache d'un provider remplacé n'est réutilisé, et le cache unique reste à
  quatre fetches démarrés/s ou moins globalement;
- finalité et idempotence restent correctes sur les chevauchements
  WebSocket/catch-up; `DEFERRED`, `IGNORED` et `QUARANTINED` restent visibles et
  les receipts/admissions se conservent quatre heures;
- le shutdown arrête les nouvelles admissions, draine dans le délai borné et
  laisse le health final propre, sans fuite de file ou de cache.

Pour le gate HTTP 429, seul un delta positif prouvé est `FAIL`; les autres
observations de la matrice restent `INCONCLUSIVE`. Les gates opérationnels
distincts ci-dessus conservent leurs propres critères. Deux niveaux de rollback
existent. Avant ces deux niveaux, le rollback isolé #146 consiste à remettre
`LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED=false` puis redémarrer :
l'admission B3b reste active et toutes les signatures reprennent le chemin
d'hydratation complet.

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

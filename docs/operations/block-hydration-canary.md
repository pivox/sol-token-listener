# Canary Mainnet post-merge d’hydratation et admission Pump.fun — 15 minutes

Version : 1.0.1 — 2026-09-20 — issues #114 et #142.

Cette procédure post-merge est opérateur-only et observe-only. Elle ne connecte
ni ne lit aucun wallet ou clé privée, ne compose aucun executor, n'arme, ne
signe et ne soumet aucune transaction. Elle est séparée de ce merge : aucune
readiness Mainnet n'est déclarée avant que cette fenêtre ait passé. Utiliser une
seule réplique avec `LISTENER_INGESTION_SCOPE=launchpad-only`, en mode `observe`.
Archiver le health, les compteurs inbox, le RSS et le tableau fournisseur avant
activation.

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

   Après T+15, arrêter uniquement `app`, laisser PostgreSQL actif, puis extraire
   exactement la ligne `STOPPED` persistée. La requête fabrique une enveloppe
   temporaire limitée à `startedAt` et `rpcHttpEvidence`; le même filtre fermé
   valide ensuite la preuve. Une ligne absente, multiple ou invalide fait
   échouer la commande et interdit un verdict `PASS` :

   ```bash
   set -euo pipefail
   : "${DEPLOY_ENV:?DEPLOY_ENV must reference the external operator environment file}"
   final_source="$(mktemp)"
   trap 'rm -f "$final_source"' EXIT
   docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 app
   docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener exec -T postgres sh -c 'exec psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --tuples-only --no-align' <<'SQL' > "$final_source"
   SELECT jsonb_build_object(
     'data', jsonb_build_object(
       'heartbeat', jsonb_build_object(
         'startedAt', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'rpcHttpEvidence', payload -> 'rpcHttpEvidence'
       )
     )
   )
   FROM listener_heartbeats
   WHERE service_key = 'transaction-listener'
     AND runtime_state = 'STOPPED';
   SQL
   test "$(wc -l < "$final_source")" -eq 1
   jq -e 'def counter: type == "number" and . >= 0 and floor == . and . <= 9007199254740991; def provider: type == "object" and (keys | sort == ["attempts", "configured", "http429Responses", "providerId"]) and (.providerId | type == "string") and (.configured | type == "boolean") and (.attempts | counter) and (.http429Responses | counter) and (.http429Responses <= .attempts) and (.configured or (.attempts == 0 and .http429Responses == 0)); . as $root | {startedAt: (try $root.data.heartbeat.startedAt catch null), rpcHttpEvidence: (try ($root.data.heartbeat.rpcHttpEvidence | if (. == null or (type != "object") or ((keys | sort) != ["overflowed", "providers", "version"]) or .version != 1 or (.overflowed | type) != "boolean" or (.providers | type) != "array" or (.providers | length) != 4 or (any(.providers[]; provider | not)) or ([.providers[].providerId] != ["primary", "fallback-1", "fallback-2", "fallback-3"]) or (any(.providers[]; .http429Responses > .attempts))) then null else {version: .version, overflowed: .overflowed, providers: [.providers[] | {providerId, configured, attempts, http429Responses}]} end) catch null)} | select(.startedAt != null and .rpcHttpEvidence != null)' "$final_source" > final
   test -s final
   rm -f "$final_source"
   trap - EXIT
   ```

   Nommer les quatre fichiers `T0`, `T+5`, `T+15` et `final`. Cette projection
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
existent :

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

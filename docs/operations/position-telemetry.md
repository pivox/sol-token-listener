# Collecte de mesure microtrade — position_telemetry.v1

## Périmètre et état de préparation

Le collecteur est un **processus indépendant**. Il ne charge ni signer, ni Connection Solana, ni moteur de trading ; il ne lance pas le runner. Il lit les journaux du runner r7 et les projections PostgreSQL. Les runners, les critères d'entrée, le montant, le take-profit, la limite de 5 minutes et la récupération SELL ne sont pas modifiés. Aucun stop-loss n'est ajouté.

**Coût RPC supplémentaire de la télémétrie : 0 requête HTTP, 0 abonnement WebSocket.** Les quotes déjà calculées par le runner sont réutilisées. L'ingestion habituelle du listener conserve son coût et ses limites propres ; démarrer un listener qui était arrêté rétablit cette consommation habituelle.

Attention à la préparation de la source : au contrôle du 4 octobre, la base locale ne contenait que quatre launches et son dernier événement datait du 12 septembre. Le collecteur ne peut pas reconstituer rétrospectivement les buyers/clusters manquants. Il faut une ingestion observe effective avant le prochain run. La commande de contrôle ci-dessous ne passe aucun ordre et ne bloque pas le runner.

```bash
node --import tsx scripts/check-position-telemetry.ts
```

`RECENT_TRADES_OBSERVED` est une condition nécessaire, pas une preuve de couverture exhaustive. Vérifier pendant l'observation que les mints vus ont une activité ingérée et que les profils participant/I1/I2 progressent. Un décodage rejeté ou un listener absent doit être traité comme une lacune de mesure. Ne pas interpréter un dataset sans participants comme une absence de buyers.

## Fichiers et architecture

- `src/telemetry/position.ts` : calcul pur des snapshots, fenêtres et extrema.
- `src/telemetry/runner.ts` : normalisation des preuves r7, whitelist des champs, BUY confirmé et récupération SELL.
- `src/telemetry/postgres.ts` : lecture atomique READ ONLY des trades Pump.fun/PumpSwap, du créateur et des preuves I2.
- `src/telemetry/journal.ts` : append-only, fsync, identifiants idempotents, verrou d'écriture et récupération d'une dernière ligne déchirée.
- `src/telemetry/dataset.ts` : rejeu des versions persistées.
- `src/telemetry/report.ts` : comparaison WIN/LOSS et simulations descriptives offline.
- `scripts/collect-position-telemetry.ts`, `scripts/report-position-telemetry.ts`, `scripts/check-position-telemetry.ts` : commandes opérateur.
- `tests/position-telemetry*.test.ts` : calcul, causalité, orphan, reprise et test CLI isolé sans signer/RPC.

Pas de migration SQL, de nouvelle règle de trading ou de dépendance npm.

## Données durables et identité

Un répertoire de collecte contient :

- `inputs.v1.jsonl` : manifeste de run, versions des positions et observations sources normalisées ; source du rapport offline.
- `position_telemetry.v1.jsonl` : snapshots, versions des résumés terminaux et compteurs de santé.
- fichiers `.lock` : un seul écrivain par journal. Après crash, le verrou n'est repris que si son PID n'existe plus.

`runId` vient du manifeste, `positionId` du run/mint/signature BUY. Le timestamp du BUY confirmé définit T0 ; une position dont le coût n'est pas encore connu reste présente avec des champs null. Une récupération SELL conserve l'identité du BUY. Un redémarrage avec le même `--out` rejoue les sources et conserve le run. Choisir un **nouveau** `--out` pour une nouvelle collecte. Les anciens BUY r7 sont exclus par défaut grâce à la date du manifeste.

Chaque snapshot contient run, position, mint, signature BUY, identifiant de snapshot, cutoff en millisecondes et slot de quote s'il existe. Plusieurs versions peuvent avoir le même `snapshotId` : les lignes restent immuables, leur `id` est le hash du contenu. Le résumé terminal contient l'entrée, la sortie, le motif, le PnL réalisé et la dernière vue `final` (activité, créateur, clusters, extrema, temps associés). Les frais/ordres échoués et une position incertaine ne deviennent pas un PnL nul : la classification reste UNKNOWN tant qu'un résultat n'est pas établi.

L'écriture est fsync avant acquittement. Une dernière ligne incomplète est conservée et suivie d'un marqueur de récupération avec son hash ; une corruption au milieu provoque une erreur. Il existe nécessairement un intervalle entre ingestion DB, capture et fsync : un crash peut créer une lacune, jamais une donnée rétrodatée. Les journaux du runner sont relus, les anciennes projections DB perdues ne sont pas inventées.

## Causalité et population

Snapshots à T+5/10/20/30/60/120/300 : reconstruction **as-of** au cutoff exact, produite au prochain tour du collecteur sans attente du trading. Les événements du runner utilisent leur timestamp persisté. Les projections mutables DB deviennent disponibles à la fin de la capture, jamais à un ancien timestamp de transaction. Une information reçue à T+21 ne remplit donc pas T+20.

Les BUY/SELL externes sont comptés une fois par identifiant canonique, uniquement finalisés, dans le même quote asset, observés depuis T0 et dans un slot strictement postérieur au BUY. Notre propre wallet est exclu. Le runner ne persiste pas l'index transaction du BUY : les trades du même slot sont exclus comme ambigus et dénombrés dans `ambiguousSameSlotTrades`. La latence de finalisation signifie qu'à T+5 une activité récente peut ne pas être encore admissible. Les timestamps du premier SELL creator sont les timestamps d'observation, pas une précision d'exécution blockchain inventée.

L'activité est **celle observée**, pas une preuve d'exhaustivité. `activity=null`, `clusters=null`, `creator=null` représentent l'inconnu. Une source lisible avec aucun événement admissible peut produire zéro ; une source absente produit UNAVAILABLE. `activityObservedAtMs` expose l'âge de la projection. Les wallets distincts ne sont jamais fusionnés. I2 conserve séparément buyers en clusters, nombre de clusters, plus grand cluster parmi les buyers, indicateur SHARED_FUNDER_CLUSTER, relations STRONG et couverture de l'analyse.

Le ratio est `floor(buyCount * 10000 / sellCount)` en bps ; `NO_SELL` est un état explicite, exclu de la moyenne du ratio et compté séparément. Le volume BUY moyen est `floor(buyVolumeQuoteRaw / uniqueBuyers)`. Il est inconnu sans buyer identifié ou si un BUY a un trader inconnu. Tous les calculs financiers sont bigint ; les moyennes/médianes du rapport sont des fractions exactes.

Les deltas comparent les cumuls de deux snapshots disponibles. Le premier snapshot n'a pas de delta fabriqué. Les tailles de fenêtres diffèrent : la simulation de ralentissement compare les **taux** de volume entre fenêtres par produits croisés bigint.

Après fermeture, les échéances restantes sont POSITION_CLOSED, avec une quote indisponible. Elles ne sont pas remplies avec le dernier prix. Le rapport affiche ces populations pour rendre visible le biais de survie.

## Quotes et formule financière

Sources actuelles : `price_progress` et `sell_quote`, SDK officiel déjà exécuté par r7. Une quote doit être antérieure au cutoff et avoir au plus 10 secondes d'âge ; sinon NO_CAUSAL_QUOTE/STALE_QUOTE. Les champs source non persistés sont explicitement `null` avec reason codes dans `metadataUnavailable` : **slot exact, détail des frais de venue, price impact**. Aucun RPC n'est ajouté pour les remplir. Les anciens journaux et le runner actuel ne permettent donc pas une analyse fiable de ces trois dimensions. PumpSwap est couvert pour les événements de participants ; faute de quote SELL PumpSwap persistée par r7, le collecteur ne crée pas de quote de migration.

Pour `sell_quote`, le minimum persisté est utilisé. Pour `price_progress`, le minimum est reconstruit avec les politiques déjà présentes : minimum absolu `requiredSellQuoteLamports` si la quote atteint le take-profit ; sinon `floor(amountOutRaw * 90 / 100)`, comme la sortie normale du runner. La récupération utilise son minimum effectivement persisté (85 % dans r7). Un minimum absolu ne devient pas artificiellement un slippage bps : ce champ peut être null avec ABSOLUTE_MINIMUM_NOT_BPS. Il s'agit d'une estimation conservatrice de quote, pas d'une promesse d'inclusion ou de remplissage d'ordre.

```text
buyEconomicCostRaw = BUY walletBefore - BUY walletAfter - retainedTokenAccountRent
buyAmountInRaw     = buyEconomicCostRaw - buyNetworkFeeRaw

grossPnlRaw = sellAmountOutRaw - buyAmountInRaw

netExecutablePnlRaw = sellMinimumAmountOutRaw
                    - buyEconomicCostRaw
                    - sellNetworkFeeEstimateRaw
```

Le coût économique BUY contient déjà les frais BUY de venue ET de réseau. La quote SELL du SDK est déjà nette de frais de venue. **Aucune deuxième déduction des frais de venue ni des frais réseau BUY.** La réserve réseau SELL est celle persistée par r7 (50 000 lamports). Le loyer récupérable du compte token est exclu, conformément au runner. Un coût absent reste inconnu.

Le PnL réalisé reprend la convention r7 : `finalWalletLamports - initialWalletLamports + retainedTokenAccountRent`. Ce rapprochement wallet peut inclure des tentatives échouées et suppose l'absence de transferts externes concurrents sur ce wallet. Il n'est pas une comptabilité auditée par instruction. La conversion SOL/USDT est secondaire, figée au prix Kraken persisté lors du BUY ; seules les simulations de seuil USDT utilisent cette représentation. Les données de référence restent en quote raw, jamais additionnées entre quote assets différents.

`observedMfeRaw`/`observedMaeRaw` sont le meilleur/pire net exécutable sur **toutes les quotes runner persistées** pendant la position, plus fines que les sept checkpoints. Aucun appel RPC par trade. Pas de zéro initial ajouté : une position toujours négative peut avoir un observedMfe négatif. Temps absolus et durées depuis le BUY sont conservés.

## Reorg et limites de reconstruction

Les révisions de statut DB sont capturées, y compris orphaned, jusqu'à 120 secondes après la fermeture. Les snapshots originaux restent append-only. Le rapport offline retire les événements finalement orphaned des vues réconciliées, sans importer de faits positifs ultérieurs. Un BUY orphaned est exclu des groupes WIN/LOSS. En cas d'orphan touchant une position, les preuves de clusters et quotes dont la provenance de branche n'est pas vérifiable sont rendues indisponibles plutôt que de reconstruire une fausse cotation.

Une réconciliation arrivée après l'arrêt du collecteur ne peut pas être devinée. Laisser la collecte active au moins deux minutes après la dernière sortie et conserver les preuves sources. La capture pollée ne remplace pas une archive complète de toutes les révisions DB entre deux polls.

## Charge

Une connexion PostgreSQL indépendante, transactions REPEATABLE READ READ ONLY, `statement_timeout=750ms`, `lock_timeout=50ms`, poll toutes les deux secondes, 15 positions récentes maximum, 10 000 lignes maximum par lecture. Les changements sont persistés ; les projections identiques ne sont pas dupliquées. Une indisponibilité DB n'est jamais propagée au runner. Pas de backpressure, de callback ni d'IPC vers le processus de trading. Une contention système générale reste possible ; surveiller les compteurs `dbCaptures`, `dbErrors` et arrêter le collecteur si nécessaire. `additionalRpcRequests` reste zéro.

Les clés privées, URL RPC, DATABASE_URL, stack traces et erreurs brutes ne sont jamais recopiées dans ces artefacts. Les fichiers sont créés en 0600, les répertoires en 0700.

## Vérification sans micro-live

Tests déterministes avec positions synthétiques, sans accès réseau ni clé :

```bash
npx tsx --test tests/position-telemetry*.test.ts
```

Rejeu historique, aucune connexion DB/RPC, aucun ordre :

```bash
node --import tsx scripts/collect-position-telemetry.ts \
  --source docs/operations/evidence/2026-10-03-mainnet-microtrade-r7 \
  --out /tmp/position-telemetry-r7-replay --history --no-db
node --import tsx scripts/report-position-telemetry.ts \
  --input /tmp/position-telemetry-r7-replay/inputs.v1.jsonl \
  --out /tmp/position-telemetry-r7-replay/report.md
```

Ce rejeu vérifie quotes/PnL/reprise mais ne recrée pas les participants historiques absents. Le test CLI utilise un wallet fictif, un chemin de clé inexistant, un endpoint RPC injoignable et vérifie que les preuves source restent inchangées.

Pour vérifier l'ingestion en observe (commande opérateur, pas exécutée dans cette implémentation) :

```bash
EXECUTION_MODE=observe PAPER_STRATEGY_ENABLED=false npm start
node --import tsx scripts/check-position-telemetry.ts
```

Le runtime paper du projet et r7 sont deux chemins distincts. Le collecteur attend ici le format des preuves r7 ; le test synthétique vérifie la mesure sans argent réel. Ne pas prétendre que les sessions paper DB sont automatiquement exportées au format r7.

## Prochaine collecte proposée — exécution opérateur seulement

Après validation de l'ingestion observe, dans un terminal dédié, démarrer d'abord la collecte :

```bash
node --import tsx scripts/collect-position-telemetry.ts \
  --source docs/operations/evidence/2026-10-03-mainnet-microtrade-r7 \
  --out docs/operations/evidence/2026-10-04-position-telemetry-r8 \
  --follow
```

Dans un autre terminal, **uniquement lors de la décision explicite de lancer le Mainnet**, lever le STOP précédent puis lancer le runner inchangé :

```bash
rm -f docs/operations/evidence/2026-10-03-mainnet-microtrade-r7/STOP
SESSION_DURATION_MINUTES=240 CANARY_MIN_NET_PROFIT_USDT=0.01 \
  node docs/operations/evidence/2026-10-03-mainnet-microtrade-r7/session.mjs
```

Cette commande conserve le plafond existant de 15 BUY, l'engagement existant d'environ 1 USDT en SOL hors frais et toutes les limites du runner. Ne pas réutiliser le répertoire de collecte r8 pour un nouveau run indépendant. Un CTRL-C du collecteur n'arrête pas le trading ; le STOP du runner demeure son mécanisme opérateur existant.

Après la dernière sortie, laisser au moins deux minutes de réconciliation, arrêter le collecteur et générer le rapport uniquement à partir des preuves :

```bash
node --import tsx scripts/report-position-telemetry.ts \
  --input docs/operations/evidence/2026-10-04-position-telemetry-r8/inputs.v1.jsonl \
  --out docs/operations/evidence/2026-10-04-position-telemetry-r8/report.md
```

Le compagnon `report.md.json` conserve tous les détails par position. Le Markdown compare WIN/LOSS à chaque échéance et présente médiane, moyenne, min, max, population et absences. Les simulations -0,03/-0,05/-0,08/-0,10 USDT, flux négatif et ralentissement de volume restent contrefactuelles. Elles indiquent notamment combien de gagnants auraient été coupés ; aucun meilleur seuil n'est sélectionné et aucun réglage live n'est modifié.

## Vérifications effectuées le 4 octobre 2026

- 15 tests ciblés de télémétrie réussis, dont le test CLI de rejeu/restart avec RPC injoignable et sans signer.
- `npm test` : 1 233 tests backend découverts, 1 126 réussis, 107 ignorés par la suite, aucun échec ; 140 tests frontend réussis.
- `npm run check`, `npm run lint`, `npm run build` : réussis.
- Lecture réelle PostgreSQL validée en READ ONLY : source non disponible pour une nouvelle mesure live, faute de trades récents (dernier trade ingéré retourné par le contrôle : 14 août ; dernier événement tous types : 12 septembre).
- Rejeu local des preuves r7 et génération du rapport sans DB ni RPC : exécutés. Les participants historiques absents restent inconnus.
- Aucune commande de lancement Mainnet, de suppression du STOP ou de démarrage du listener n'a été exécutée.

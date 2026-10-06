# Contre-vérification de l’audit r8

**Périmètre :** seconde passe ciblée sur l’audit du 4 octobre 2026, dossier de session `2026-10-04-mainnet-microtrade-r8`. Cette passe repart des `canary.jsonl`, captures de découverte, `status.json` et scripts archivés. Elle ne reprend ni ne modifie les conclusions des sessions r1–r7. Aucun RPC, wallet, fichier d’environnement ou secret n’a été lu ; aucun service de trading n’a été lancé.

**Sources de référence :** [rapport initial](../2026-10-04T1128Z/rapport.md), [statut de session](../../evidence/2026-10-04-mainnet-microtrade-r8/status.json), [runner de session](../../evidence/2026-10-04-mainnet-microtrade-r8/session.mjs#L69), [canary et confirmations RPC recopiées](../../evidence/2026-10-04-mainnet-microtrade-r8/canary.mjs#L74), [règle de sélection](../../evidence/2026-10-04-mainnet-microtrade-r8/selection-policy.mjs#L1), [détection et suivi d’activité](../../evidence/2026-10-04-mainnet-microtrade-r8/discover.mjs#L38). Les six fichiers canary bruts sont liés depuis le tableau comptable.

## A. Verdicts

| Conclusion examinée | Verdict | Résultat de contre-vérification |
|---|---|---|
| 135 créations observées, toutes sur des mints distincts | **CONFIRMÉE** | 9 vagues × 15 créations ; 135 mints uniques, aucune répétition. Le code maintient un `Set` de mints dans chaque vague. |
| 6 achats et 6 ventes confirmés ; 5 timeouts et 1 sortie-profit | **CONFIRMÉE** | Les six sources originales contiennent chacune `buy_submitted`, `buy_confirmed`, `sell_submitted`, `sell_confirmed`, `sell_result`, `complete`; une seule contient `profit_target_reached`. Les signatures concordent avec le statut. |
| `failed=1` signifie une transaction échouée | **RÉFUTÉE** | L’échec comptabilisé est la découverte interrompue de la vague 9 (`code:null`, arrêt STOP), pas une transaction. Aucune transaction on-chain échouée n’apparaît dans les six journaux ; les métadonnées RPC brutes manquent pour exclure tout événement non archivé. |
| PnL r8 de −1,0726 USDT | **CONFIRMÉE SOUS CONDITIONS** | Le chiffre se reproduit en partant des variations brutes du wallet et du loyer post-vente relu par le runner. C’est un résultat économique estimé en SOL converti au taux Kraken SOL/USDT d’entrée, pas un résultat réalisé en USDT. |
| PnL r8 natif de −8 839 119 lamports | **CONFIRMÉ SOUS CONDITION DE LOYER** | Le delta wallet est −17 922 159 lamports ; le statut reflète 9 083 040 lamports de loyer présent dans les six ATA après les ventes. Somme : −8 839 119. Pas de remboursement compté. |
| Frais réseau comptés une seule fois | **CONFIRMÉE** | Les 12 événements `*_confirmed` donnent 45 000 lamports chacun. Ces frais sont déjà inclus dans les variations pré/post du fee payer ; les soustraire séparément les compterait deux fois. |
| Chaque position était déjà déficitaire au premier snapshot post-achat | **CONFIRMÉE SUR LES QUOTES OBSERVÉES** | Recalcul indépendant `quote pleine position − coût BUY hors ATA − réserve SELL de 50 000` : les six premiers marks sont négatifs. Cela ne prouve pas un fill exécutable à ce mark. |
| Une stratégie à timeout de 30/60/120 s aurait réduit la perte selon les montants du premier audit | **NON VÉRIFIABLE COMME CONTREFACTUEL** | Les échantillons choisis sont à T+31/62/124 s pour plusieurs cas : ils suivent l’instant où une sortie hypothétique aurait été due. Ce sont des observations descriptives postérieures, pas un replay causal ni un prix de vente disponible à l’échéance. |
| L’écart quote/exécution de `2Uc6…ppump` est un meilleur remplissage | **NON VÉRIFIABLE** | Le crédit net du wallet dépasse la quote de 629 160 lamports après réintégration du frais réseau. Sans `meta` complet, instructions internes et balances résolues, la source de l’écart est inconnue. |
| L’entonnoir et les motifs détaillés de non-achat sont intégralement prouvés | **PARTIELLEMENT CONFIRMÉE** | Les 135 créations, les 120 candidats avec fenêtre et décision, les 7 admissibles consignés, 6 choix et 6 achats se retrouvent dans les données primaires. Les classes exclusives 57/31/11/etc. viennent d’une seconde application des règles de sélection ; elles n’ont pas été toutes recalculées indépendamment dans cette passe. |

## B. Vérifications et calculs

### Session, version et séparation des sources

La configuration étudiée est la session r8 : `SESSION_DURATION_MINUTES=240`, seuil demandé `CANARY_MIN_NET_PROFIT_USDT=0.05`, plafond de 15 créations par vague, activité observée 45 s et détention maximale 5 min. L’identité de version rapportée par l’audit initial est confirmée par les imports absolus dans `discover.mjs` et `canary.mjs` vers `.worktrees/unissued-work-inventory` et par le `HEAD` de ce worktree : `a2cd6abee7b9071860185dd2d012ca1071095a41`. Le worktree est propre. Le hash du `dist/` exécuté, l’environnement historique exact hors seuil documenté et les paramètres historiques du programme ne sont pas scellés avec les preuves.

Les six fichiers source `wave-*/canary.jsonl` sont des JSONL propres. Leurs enregistrements JSON sont identiques aux lignes JSON des six `canary-runner.log` ; ces derniers ont une ligne de démarrage non JSON, ignorée uniquement pour cette comparaison. Comptages bruts : 6 préflights, 6 BUY soumis/confirmés, 6 SELL soumis/confirmés, 6 `sell_result`, 6 `complete`, 297 `price_progress`, un déclenchement profit. Les ventes indiquent `remainingTokenRaw="0"` ; le runner de session relit aussi le solde token après vente et n’accepte que `0`.

Les vagues 1–8 ont chacune 15 créations, 15 candidats, une fin d’activité et une décision. La vague 9 a 15 créations/candidats, mais aucune ligne `activity_stopped` ni sélection. Il y a donc 120 candidats avec fenêtre/décision et 15 dont la fenêtre est incomplète. Les journaux de création ne montrent pas de mint répété ; `discover.mjs` déduplique également par mint à l’intérieur d’une vague. L’activité ignore les logs d’échec, déduplique par signature et compte les BUY/SELL et wallets BUY, mais n’enregistre ni montants de quote, ni preuve de couverture après reconnexion, ni financement commun. Le nombre de wallets reste un proxy, pas une preuve d’acteurs indépendants.

### Rapprochement natif indépendant

Le script de cette passe n’importe pas `analyze-r8.mjs`. Il somme d’abord les changements bruts du fee payer, puis les compare au delta entre le premier préflight et le solde final. Les montants sont des entiers de lamports.

| Vague / mint complet | Delta wallet BUY | Delta wallet SELL | Résultat wallet du trade | Loyer observé à l’ouverture | Résultat si loyer identique après vente | PnL au cours d’entrée |
|---:|---:|---:|---:|---:|---:|---:|
| 1 [`HKEZKN1ev8hD2utDdefpcujufTwALCsVvdRcJXwGpump`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-001/canary.jsonl) | −9 548 954 | +7 113 008 | −2 435 946 | 1 513 840 | −922 106 | −0,11194366840 USDT |
| 2 [`Bvh9xjVqTWA2AAM7HE2Lt11fbhsdAf3WyEALQwHMgSut`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-002/canary.jsonl) | −9 552 905 | +5 324 731 | −4 228 174 | 1 513 840 | −2 714 334 | −0,32935728756 USDT |
| 3 [`3bqjGQ7HQC7JxG6fq8K6U3QYGKNMWEYsfAGn1HWc27yY`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-003/canary.jsonl) | −9 154 496 | +8 321 273 | −833 223 | 1 513 840 | +680 617 | +0,08253842359 USDT |
| 4 [`2Uc6S4C5aQ5NH1J5Co4HPwdSuZCS8QGmBPd5SRxppump`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-004/canary.jsonl) | −9 557 519 | +6 222 858 | −3 334 661 | 1 513 840 | −1 820 821 | −0,22081096267 USDT |
| 7 [`BQgvrXhbCgTG94DG4UToJY4Ggv1mmXRKw72z4eb9pump`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-007/canary.jsonl) | −9 549 612 | +5 776 718 | −3 772 894 | 1 513 840 | −2 259 054 | −0,27422656506 USDT |
| 8 [`Cbq36xHU7ynVrrwcAN75SDYkvCmLZRX5cwUPYmUJpump`](../../evidence/2026-10-04-mainnet-microtrade-r8/wave-008/canary.jsonl) | −9 564 179 | +6 246 918 | −3 317 261 | 1 513 840 | −1 803 421 | −0,21884513835 USDT |
| **Total** |  |  | **−17 922 159** | **9 083 040** | **−8 839 119** | **−1,07264519845** |

Contrôles :

- Le delta session `402 939 765 − 420 861 924 = −17 922 159` lamports égale exactement la somme des six deltas wallet des transactions. Les soldes pré-achat des vagues successives reprennent le solde final de la vague précédente.
- Les frais `meta.fee` consignés valent 45 000 par transaction, soit 540 000 au total. Les variations BUY/SELL les incluent déjà. Le PnL ci-dessus n’effectue aucune seconde déduction de ces frais et ne déduit pas la réserve de 50 000 du PnL exécuté.
- `session.mjs:69–74` relit l’ATA après le trade et retourne son `account.lamports`; `session.mjs:145–151` vérifie le solde token puis calcule le PnL avec ce loyer final. Cette lecture n’est pas écrite dans `status.json`. En inversant les six `pnlUsdt` persistés avec leur taux d’entrée et leurs deltas wallet, on retrouve 1 513 840 lamports par ATA, à l’erreur d’arrondi flottant près. Le total des loyers finaux est donc fortement corroboré par le résultat persisté et le code, mais non archivé comme six champs bruts de fin.
- Les comptes étaient encore lisibles avec zéro token après chaque vente ; aucun remboursement n’est constaté. L’estimation traite leur loyer comme actif récupérable/immobilisé, non comme revenu encaissé. Aucune fermeture future n’est comptée.
- Les taux sont `krakenSolUsdt` lus avant achat : 121,27–121,40 USDT/SOL. Ils fournissent une conversion indicative de résultat SOL, pas un montant d’USDT réalisé ni un taux exact à l’heure d’exécution de chaque transaction.
- Pour le trade 4, `sell_wallet_delta + frais − quote` vaut +629 160 lamports. Pour les cinq autres, cet écart vaut zéro. L’écart du trade 4 est conservé sans attribution causale.

**Montant à retenir :** −17 922 159 lamports de variation de trésorerie est directement reproduit. Le meilleur PnL économique estimé est −8 839 119 lamports (−0,008839119 SOL), soutenu par la réconciliation post-vente du runner et les PnL par trade persistés. La conversion en −1,07264519845 USDT est arithmétiquement reproductible au cours d’entrée, mais ce n’est pas un règlement USDT. Les frais réseau bruts sont directement inscrits dans les événements de confirmation ; les commissions de protocole/créateur, le destinataire exact des flux et la composition complète des transactions restent non vérifiés sans les réponses RPC complètes.

### Sorties, seuil et snapshots

Le code historique passe à `getSellSolAmountFromTokenAmount` la quantité entière de l’ATA (`canary.mjs:224–230`), avec le `global`, `feeConfig`, supply et état de bonding curve relus. La quote vise donc la liquidation de toute la position, avec le calcul de frais du SDK ; elle demeure une estimation. Le seuil est net dans son intention : coût économique BUY + réserve réseau SELL de 50 000 lamports + `targetProfitLamports` converti du SOL/USDT préflight (`profit-policy.mjs` et `canary.mjs:196–212`). Le snapshot `price_progress` soustrait le coût et la réserve fixe, puis le déclencheur compare à `requiredSellQuoteLamports`. Il s’agit du profit estimé d’une liquidation pleine position, pas du prix unitaire ni du montant brut encaissé.

La reconstruction des marks utilise indépendamment `expectedSellQuoteLamports − buyEconomicCostLamports − 50 000`. Premiers marks des vagues 1/2/3/4/7/8 : −140 025 / −1 554 444 / −485 245 / −551 882 / −287 909 / −292 665 lamports. Il n’y a aucun mark non négatif avant le T+16 s du trade 3 ; seul celui-ci franchit ensuite le seuil de rentabilité estimé, atteint la cible de +0,05 USDT à T+16 et déclenche une vente confirmée. Les cinq autres ne montrent aucun mark de liquidation net positif pendant leur échantillonnage. **La conclusion “les pertes étaient déjà présentes juste après l’achat” est confirmée en tant que quote observée**, sans prouver que ces quotes étaient fraîches au slot, immédiatement exécutables ou qu’aucune fenêtre n’a existé entre deux mesures. Les snapshots ne journalisent ni slot ni âge de la quote.

Le CSV de timeouts du premier audit est descriptif, comme son champ `basis` l’indique, mais son libellé de contre-factuel peut être lu comme une estimation de vente au timeout. Pour 30/60/120 s, la sélection `first progress elapsedSeconds >= timeout` retient notamment 31/62/124 s. Or le code de suivi vérifie l’échéance avant de relire le marché après son attente (`canary.mjs:213–236`). Ces quotes postérieures ne pouvaient pas servir à la décision hypothétique déjà due. Elles ne prouvent ni un prix disponible au timeout, ni un gain capturable. Les agrégats de scénarios du premier audit ne doivent pas guider le choix d’un timeout. Les extrêmes observés restent rétrospectifs et sont limités par l’échantillonnage de cinq secondes.

### Sélection et scripts/tests précédents

Les faits de haut niveau sont confirmés depuis les enregistrements primaires : 135 créations uniques ; vagues 1–8 : 120 candidats et huit décisions ; sept admissibles consignés au total ; six choisis/achetés ; vague 9 incomplète. La politique source exige notamment au moins trois wallets BUY distincts sur la fenêtre et des bornes de réserve, de programme token, de quote et d’état de courbe (`selection-policy.mjs:1–9`). Elle classe ensuite les admissibles par wallets puis réserve (`discover.mjs:106–119`). Les événements n’ont pas les montants BUY/SELL nécessaires pour tester une sélection par flux net ou volume. Les motifs exhaustifs attribués aux 120 non-choisis dans le premier audit sont plausibles et concordent avec ses règles, mais proviennent du même parcours de règles ; cette seconde passe n’en fait pas une reproduction indépendante ligne par ligne.

L’analyseur initial ne lit que les preuves locales et ne fait pas de RPC. Ses quatre tests passent. Toutefois, son test de rapprochement r8 appelle `buildReport()` puis compare les totaux produits par cette même implémentation ; il s’agit d’un test de non-régression, pas d’un oracle indépendant. Les deux tests synthétiques de comptabilité ont des valeurs attendues fixes utiles, mais ne modélisent pas les métadonnées `meta` brutes, erreurs on-chain, comptes propriétaires, transaction partielle ou mouvement externe. Cette limite ne révèle pas un calcul faux : notre script séparé, en Python/`Decimal`, repart des seuls `canary.jsonl` originaux et reproduit les mêmes totaux natifs et conversions.

Un point déjà correctement signalé par le premier audit est important pour l’interprétation : aucun export complet des 12 transactions n’est présent. Les logs conservent `fee`, `preBalances[0]`, `postBalances[0]`, slot et signatures, mais pas `meta.err`, les clés d’adresses résolues, `pre/postTokenBalances`, instructions internes, loaded addresses ou détails complets de destinataire. On ne peut donc pas distinguer à partir du seul journal les flux associés au trade de tout crédit/débit non standard dans la transaction. L’événement `sendSimulated` vérifie le statut d’inclusion et remonte les erreurs de statut, mais ne persiste pas le corps complet de `meta`.

## C. Nouveaux problèmes matériels

Aucune nouvelle anomalie de code ou erreur de comptabilité n’est démontrée dans cette seconde passe. Les corrections de qualification ci-dessus portent sur la force de la preuve : PnL économique fortement reproduit mais conditionnel à l’actif ATA final ; agrégats de timeouts non causaux ; détails de funnel moins indépendants que les totaux. L’écart de quote/exécution du trade 4 était déjà identifié par la première passe et n’est pas une découverte nouvelle.

## D. Ce qui manque encore

- Les réponses `getTransaction` complètes pour les 12 signatures (dont `meta.err`, frais, balances, token balances, clés versionnées résolues, instructions internes, blockTime/slot) et une archive de l’état final/owner/lamports de chaque ATA.
- Une preuve scellée de la révision du build `dist/` exécuté et une configuration de session expurgée des secrets, liée à l’exécution.
- Pour établir les moments de décision : slots, âge/fraîcheur des états de curve, ordre des events et quote pleine position persistée avec même slot/état.
- Pour l’entonnoir économique : montant de quote des BUY/SELL de chaque signature, état de finalité, couverture/reconnexion, échecs et duplicats, ainsi que les raisons et rechecks persistés sans reconstruction circulaire.
- Aucune donnée suffisante pour attribuer indépendamment des frais de programme/créateur/intermédiaire ou démontrer que la variation a été échangée en USDT.

Mesure minimale avant une autre session réelle : instrumenter un journal append-only lié par signature qui conserve la transaction RPC complète nettoyée, le solde post-vente des ATA, les quantités raw/décimales, le slot et la quote/fraîcheur ayant déclenché chaque sortie. Ne pas changer de timeout ou de seuil sur la base de ces six trades.

## E. Trois actions prioritaires (proposées, non appliquées)

1. Fermer la lacune de preuve par transaction et stocker les métadonnées RPC complètes, le fee payer et l’état final des ATA ; garder PnL SOL, trésorerie, loyer immobilisé et conversion USDT en lignes séparées.
2. Étendre l’instrumentation existante pour lier chaque décision à son slot, son âge de quote et sa quote de liquidation totale, puis conserver les activités avec montants et indicateur explicite des trous de collecte.
3. Requalifier les scénarios 30/60/120 s en statistiques descriptives uniquement ; n’évaluer une règle de sortie qu’avec un replay causal utilisant les informations disponibles au moment de la décision, puis un échantillon distinct.

## Tests et reproduction

Commandes hors ligne exécutées :

```sh
python3 -B -m unittest -v test_countercheck_r8.py
python3 countercheck_r8.py
node --test docs/operations/audits/2026-10-04T1128Z/analyze-r8.test.mjs
```

Résultats : 6 tests indépendants de contre-vérification réussis ; analyseur Python lu seule réussi ; 4 tests du premier audit réussis. Aucun test connecté, aucun accès réseau/DB, aucune commande de trading. Les six assertions indépendantes contrôlent la copie des journaux, unicité des mints, variation wallet depuis les transactions brutes, absence de seconde déduction des frais, cohérence du loyer post-vente avec le statut, marks initiaux de liquidation, et écart inexpliqué de `2Uc6`.

Scripts ajoutés dans ce dossier : [countercheck_r8.py](./countercheck_r8.py) (lecture seule) et [test_countercheck_r8.py](./test_countercheck_r8.py). Ce rapport et ces scripts ne modifient pas la production, les configurations ou les preuves existantes.

## Réponse finale

**Le diagnostic du premier audit est-il suffisamment étayé pour choisir la prochaine correction technique ?** Oui, pour choisir une correction de mesure et de rapprochement : préserver par signature les métadonnées RPC, la lecture d’ATA après vente et la quote complète avec son slot/fraîcheur. Les pertes dès les premiers marks sont réelles sur les quotes enregistrées et la perte économique r8 se reproduit sous l’hypothèse appuyée d’un loyer ATA conservé. L’audit ne démontre pas un bug d’exécution ayant causé les pertes.

**Quelles conclusions ne doivent pas encore servir à modifier la stratégie ?** Les simulations de timeouts plus courts, l’interprétation du gap `2Uc6` comme meilleur fill, les classements économiques des 129 non-achetés, une attribution précise des frais de programme, et toute promesse qu’un seuil ou timeout alternatif aurait amélioré le résultat. Les preuves r8 établissent un déficit de liquidation dès les premiers snapshots et des pertes plus grandes au terme des positions, mais ne valident aucune stratégie sur six trades.

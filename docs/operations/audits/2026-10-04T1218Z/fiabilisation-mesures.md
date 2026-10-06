# Fiabilisation des mesures et rapprochement par signature — r8

**État :** collecte locale d’index terminée ; collecte blockchain distante non lancée ; rapprochement comptable on-chain en attente des réponses `getTransaction`.

Ce chantier reprend les constats du [rapport de contre-vérification](../2026-10-04T1148Z/rapport-contreverification.md) sans modifier ce rapport ni les preuves r8. Les conclusions initiales gardent leur niveau de preuve : 135 créations uniques, 6 BUY/6 SELL consignés comme confirmés, cinq timeouts et une sortie-profit. `failed=1` reste une interruption de découverte. Le delta de trésorerie recalculé est −17 922 159 lamports. Le résultat économique de −8 839 119 lamports suppose +9 083 040 lamports de fonds ATA récupérables après vente ; cette ventilation n’est pas encore confirmée par les métadonnées blockchain. Les scénarios de timeout court utilisant des observations ultérieures restent non causaux. Aucun nouvel écart historique de comptabilité ou de code de trading n’est démontré.

## Périmètre et données de la session

La source est `docs/operations/evidence/2026-10-04-mainnet-microtrade-r8/`. Les journaux indiquent le wallet `2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ`. La session r8 et ses limites de version/configuration sont décrites dans le rapport de contre-vérification ; le présent chantier n’applique pas le code actuel à la session comme s’il était son build historique.

L’index hors ligne [signature-index.v1.jsonl](./historical-rpc-ready/signature-index.v1.jsonl) contient **1 916 signatures uniques** avec tous les liens source conservés : 135 signatures de création, 1 769 signatures liées à l’activité de marché et les 12 signatures BUY/SELL. Ces catégories de liens ne sont pas toutes disjointes. Les 12 transactions d’exécution sont reliées aux positions suivantes :

| Mint | BUY | SELL |
|---|---|---|
| `HKEZKN1ev8hD2utDdefpcujufTwALCsVvdRcJXwGpump` | `43zoVkSwd749ja5iTzvty93DV9cKbyBVTZw3Rc1FhCuNp95DxhGGQKuuUd4EWcxNS78a6GaDwkbCqhMdrTtTNR99` | `Xs5QUTAfpS5XVz6WxNyTUBjaPi64VESt9nhGEAbZvxEQ9tJMbtBqckB6RXdDgPLpXiSmwfWtN6FWo3xHpM2AURM` |
| `Bvh9xjVqTWA2AAM7HE2Lt11fbhsdAf3WyEALQwHMgSut` | `5vN5Q8LvGRdf4jRJJGmz8xEWxkLoQBzCcAJkzuMQJ4myqnRumehZJfzXkCxz4x1Ga1Q9RNw4wRxZsaUi82vCiGc8` | `4WSJSSj55gWA8bikD9wjuZEpaWjtDRzDCsPCk5LPi7Fkr9FnMx6FjedtCVumEqU7rnVe9SvqhMbxZSMTqWZMMTDB` |
| `3bqjGQ7HQC7JxG6fq8K6U3QYGKNMWEYsfAGn1HWc27yY` | `4xHtQLMx9WpaVXsRDBHMhtcoauFiqvG2ZjGfvxGsWhjYLNNcWsMrbTnoZMfa9M7PzCafPwofJ9uUx1M9atm1K1Bp` | `2eNr8uRteftEb7oorecw3RwvsSTDzLhmCYxSfrnznoSRXsgVAjUwubtFpGjQJc8cmSmXf5hUoix2ZAd8SpNbrz4h` |
| `2Uc6S4C5aQ5NH1J5Co4HPwdSuZCS8QGmBPd5SRxppump` | `2WjRhYkTSUFL64msgwiqu6jaTDqLciGD8ndAoaMC8qUCNAuop46uscnRbBKCj6PXWBisyesfQLnqTPhpsAokykGc` | `3ntQh5YwLWTSMkM1LEy1gD2F5rfEbHGMfaMVc6nLTq4Br9qzCbp1MKfKNP1BonvvRNgUFQmdLajF2HMcXJcaCRk3` |
| `BQgvrXhbCgTG94DG4UToJY4Ggv1mmXRKw72z4eb9pump` | `5iRpc16DexuYPwSKLwEXdw65x2tRJo7q1Cwp31pDTzsDosYPmvtptPyQZdCEb8VzYojT68AJ5KY8mcUWW4aR94up` | `4gWkjZvjgmCwvY6yQwFTyBtAEwpy4bbcnDvPL6JxEGuzb1nNfQ2DHmifvqsDzENXNqwKh7E7wqzW41HhMSAe6tg8` |
| `Cbq36xHU7ynVrrwcAN75SDYkvCmLZRX5cwUPYmUJpump` | `3TVpSP47WK4ZEZaaKUvW8D69AMXnifLjXXHaiZtd8xX6TgXAAHdQXzBbWavutNEqkyqAnaf95usYJk6XQnFo6UvJ` | `4CQmUtKmD8qHwdwkeM2LdaWVUhaErUUpeX9SkKRXm324gRVeDcaumPQquHLneTNS55RopKxhUZDP5CyfasRUaL7g` |

La provenance de ces liens est `wave-*/canary.jsonl` et `status.json` ; le mint des événements du canary a été repris depuis le `preflight` de la même vague. L’index déduplique la requête par signature sans perdre les références d’événement, de mint, de vague et de position. L’inventaire seul ne prouve ni l’exécution ni la réussite on-chain.

## Rapprochement — état actuel

| Partie | Valeur | Statut / limite |
|---|---:|---|
| A. Trésorerie wallet, début → fin | −17 922 159 lamports | **RECALCULÉ À PARTIR DES PREUVES LOCALES**, pas des balances `getTransaction`. Le solde initial vient du préflight et le final du statut r8. |
| B. Flux externes non liés au trading | inconnu | Pas d’historique RPC complet ni de revue des contreparties ; inconnu n’est pas zéro. |
| C. Variation des fonds récupérables ATA | +9 083 040 lamports dans l’estimation existante | **ESTIMÉ AVEC HYPOTHÈSE** de loyers conservés après les trades. Aucun montant par ATA, état historique de compte, propriétaire, autorité de fermeture ou destination de remboursement n’est confirmé ici par RPC. |
| D. Tokens résiduels | non déterminé on-chain | `remainingTokenRaw=0` dans les journaux de sortie n’est pas un remplacement de `postTokenBalances`. |
| E. Résultat économique | −8 839 119 lamports | Calcul conditionnel `A − B + C + D`, avec B supposé nul et D supposé nul. Pas un total blockchain rapproché. |

La ventilation des +9 083 040 lamports **n’est pas intégralement justifiée par les preuves blockchain disponibles**. Les journaux historiques ventilent des montants de compte ATA, mais ne contiennent pas les transactions complètes et états de compte nécessaires pour décider, compte par compte, entre ATA préexistant, création durant la session, fonds encore immobilisés, fermeture et remboursement encaissé. Le montant ne doit pas être traité comme une somme forfaitaire par ATA. Aucun frais réseau n’est retranché de nouveau d’un delta wallet : `meta.fee` est conservé séparément et marqué comme déjà inclus dans `preBalances/postBalances`.

Le [rapprochement hors ligne](./reconciliation-offline/session-reconciliation.md) matérialise les six positions et leurs comptes ATA dérivés du programme Token-2022 utilisé par le canary historique. Il donne les 12 signatures en `NOT_COLLECTED`, et laisse soldes/deltas ATA, transactions et reliquats à `INCONNU`. Ce document n’affirme aucune lecture blockchain.

Le nouveau calculateur [transaction-evidence.ts](../../../../src/telemetry/transaction-evidence.ts) maintient les montants bruts en entiers, résout les loaded addresses des transactions versionnées, sépare SOL et wSOL, suit les balances token avec côtés manquants à `null`, classe les erreurs d’exécution et relève les transferts candidats. Un transfert externe ne réduit/augmente le résultat économique qu’après couverture complète et revue explicite. [report-transaction-evidence.ts](../../../../scripts/report-transaction-evidence.ts) produit un grand livre par signature et compte lorsqu’un cache RPC existe ; tant que l’historique et les réponses sont incomplets, son résultat économique reste `null`.

### Collecte RPC

Aucun `getTransaction` distant n’a été lancé. `.env.example` ne donne pas d’URL RPC renseignée et aucune limite/quota fournisseur vérifiable n’est fournie. Je n’ai pas lu `.env`, de base de données, ni de clé. La commande de collecte est en lecture seule et autorise uniquement la méthode `getTransaction` en HTTPS. Elle a un cache local indexé par signature et paramètres, conserve les réponses et paramètres bruts avec l’heure de récupération, limite les retries à 0–3, et impose un budget strict de 1–500 appels par exécution. Le défaut sélectionne les rôles BUY/SELL/autres transactions ; pour r8, l’inventaire sélectionné contient 12 signatures, pas les 1 769 transactions d’activité de marché.

Après validation indépendante d’un endpoint en lecture seule et de son quota, définir `SOLANA_HTTP_RPC_URL` dans l’environnement d’exécution autorisé, sans l’écrire dans le dépôt, puis exécuter :

```sh
SOLANA_HTTP_RPC_URL='https://<endpoint-rpc-autorise>' node --import tsx scripts/collect-transaction-evidence.ts \
  --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 \
  --out docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready \
  --roles BUY,SELL,OTHER_TRANSACTION \
  --budget-rpc-requests 30 --retries 1 --commitment finalized --max-supported-version 0
```

Le budget est un plafond dur de requêtes, partagé entre signatures et retries. Le cache réutilise les réponses terminales pour des paramètres identiques. Les versions non supportées ont leur statut propre ; après inspection, une collecte ciblée avec un `max-supported-version` supérieur peut être lancée et sera mise en cache sous ces paramètres. Pour rendre le grand livre dans un **nouveau** dossier de sortie :

```sh
node --import tsx scripts/report-transaction-evidence.ts \
  --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 \
  --transactions docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready/transactions.v1.jsonl \
  --out docs/operations/audits/2026-10-04T1218Z/reconciliation-run-001
```

La commande RPC ci-dessus est **livrée, mais non exécutée**. Le budget de 30 constitue seulement le plafond local proposé pour la collecte ciblée ; il ne valide pas le quota d’un fournisseur absent.

## Instrumentation temporelle

Les observations historiques du canary gardent l’heure locale de log, mais n’ont pas l’heure de réception de l’état, le slot de cet état, l’instant du calcul quote ni la ventilation complète des frais. Elles sont désormais non évaluables comme quotes décisionnelles, au lieu d’être promues en PnL exécutable.

Les nouveaux champs de quote sont dans `AvailableQuote` et `quote_observation.v1` : session/position/mint/quantité, réception et slot d’état, heure de calcul, quote et minimum de liquidation en unités natives, frais, traitement des frais, fraîcheur, validité et motif d’invalidité. `T0` est défini par `buy_confirmed.at` (heure locale de réception du journal), avec le slot de confirmation conservé séparément ; il ne représente pas `blockTime`. Les horloges locales et blocktime ne sont pas soustraites l’une de l’autre.

`QuoteObservationRecorder` est désactivé par défaut et son appel `record()` n’attend pas l’écriture ; sa file est bornée et `health()` expose les pertes et erreurs. Le sidecar `collect-position-telemetry.ts --quote-source` sait importer ces observations. **Le producteur de quotes du runtime n’est pas encore branché à ce recorder** : ce dépôt contient maintenant le format, le filtre causal et le collecteur, mais ne commence pas à remplir automatiquement un journal live. Aucun polling RPC additionnel n’a été ajouté à la décision.

Le garde causal rejette pour une décision à `T` tout état ou calcul reçu après `T`, tout état sans slot, trop ancien ou invalide. Les observations postérieures restent descriptives et ne sont pas réutilisées comme connaissance disponible à `T`. Une quote favorable n’est pas présentée comme un fill garanti.

Une vérification des tests a trouvé un défaut dans le **nouveau code de mesure** : des frais marqués `SEPARATE` n’étaient pas retranchés du PnL estimé. Il est corrigé ; les frais séparés sont déduits une fois, les frais inclus dans le minimum ne sont pas déduits une seconde fois, et un traitement inconnu donne un PnL net inconnu. Cette anomalie de télémétrie ne démontre aucun effet sur le résultat historique r8.

## Modifications ciblées

- Index signature → événements, source, mint, vague et position ; rôle `status_buy_link`/`status_sell_link` cohérent avec les confirmations.
- Collecteur `getTransaction` borné, cache local, réponses brutes et statuts différenciés ; aucun code de signature/envoi.
- Parseur de balances, frais, transferts et cycles de vie ; grand livre session par signature/compte avec inconnues visibles et frais sans double déduction.
- Observations de liquidation horodatées, contrôle causal, frais inclus/séparés/inconnus et recorder asynchrone désactivé par défaut.
- Adaptation des tests historiques afin que les timestamps et frais manquants n’impliquent pas un profit calculable.

Aucun changement de stratégie, seuil, taille, risque, configuration active ou chemin d’exécution n’a été fait. Aucun ancien rapport ou élément de preuve n’a été modifié.

## Tests et reproduction

Commandes hors ligne réellement exécutées :

```sh
node --import tsx scripts/collect-transaction-evidence.ts --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 --out docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready --index-only
node --import tsx scripts/report-transaction-evidence.ts --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 --transactions docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready/transactions.v1.jsonl --out docs/operations/audits/2026-10-04T1218Z/reconciliation-offline-repro-001
node --import tsx --test tests/transaction-evidence.test.ts tests/causal-quote.test.ts tests/position-telemetry.test.ts tests/position-telemetry-evidence.test.ts tests/position-telemetry-report.test.ts tests/position-telemetry-isolation.test.ts tests/position-telemetry-postgres.test.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Résultats : index de **1 916** signatures, zéro requête RPC ; **29 tests réussis, 0 échoué** ; TypeScript sans erreur. Les fixtures ont des attendus constants définis à partir des deltas et unités affichés dans chaque cas, dont `−110 + 100 + 30 = +20` (fee inclus une seule fois), `+90 − 100 = −10` lors d’un remboursement d’ATA, et `190 − 100 − 5 − 3 = 82` pour une quote avec frais séparés. Le test d’intégration utilise des chemins temporaires, aucun signer/RPC/DB de trading ; aucun test connecté n’a été exécuté.

## Ce qui est confirmé, estimé et manquant

- **Confirmé par les archives locales :** les liens des 12 BUY/SELL et six mints complets ; l’index dédupliqué préservant les sources ; les constats r8 consignés dans le rapport précédent.
- **Non confirmé par blockchain dans ce chantier :** statut d’exécution et erreur pour chaque signature, montants réellement échangés, fee payer/`meta.fee`, loaded addresses historiques, transfers/instructions internes, frais programme, soldes de chaque ATA, propriétaire/close authority/destination, remboursements, soldes token finaux et frais d’éventuelles transactions échouées hors des 12 opérations consignées.
- **Estimé :** −17 922 159 lamports de delta wallet est reproduit à partir des archives ; −8 839 119 lamports et −1,0726 USDT restent conditionnels aux +9 083 040 lamports ATA, aux flux externes et aux reliquats. Le cours USDT est indicatif au cours SOL/USDT d’entrée et n’est pas une conversion réalisée.
- **Mesure live pas encore automatique :** il manque un adaptateur du quote provider/runtime vers `QuoteObservationRecorder`, branché après la réception de l’état de marché et autour du calcul de quote, sans bloquer le producteur. Sa validation devra utiliser un fixture hors ligne puis un lancement en observation seule, explicitement séparé de tout trading.

## Trois actions prioritaires

1. Valider un endpoint RPC HTTPS en lecture seule et son quota, puis collecter les 12 signatures ciblées avec budget/cache ; examiner toute version non supportée avant d’élargir la collecte.
2. Générer le rapprochement par signature et par ATA depuis `meta` brut ; revoir chaque transfert externe candidat, destinataire de fermeture et solde de token, puis laisser visible tout résidu incomplet.
3. Brancher le recorder désactivé au producteur de quote, émettre/contrôler `health`, puis vérifier en mode observation seule les timestamps, slots, frais et pertes de collecte avant toute analyse temporelle.

**Collecte prête ?** L’index, le collecteur borné et le format de rapprochement sont prêts pour une collecte RPC après vérification de l’accès et du quota. La collecte distante n’a pas été autorisée/exécutée faute de ces preuves. L’instrumentation de quotes est préparée mais ne collecte pas encore automatiquement depuis le runtime.

# Relance du microtrade Pump.fun Mainnet — 3 octobre 2026

## Verdict

Un **deuxième aller-retour réel** a été exécuté après le [premier microtrade](mainnet-microtrade-2026-10-03.md). Le BUY et le SELL du mint `4eNYCcNKt6R7rEUPDCGcGQnW6TUUHTutfKJtcE6epump` sont finalisés. Cinq BUY d'adresses externes distinctes, eux aussi finalisés, se situent après le slot de notre BUY. La vente a été confirmée au premier envoi et le solde du token est **zéro**.

La dépense de trade a été de **8 069 258 lamports** (environ **0,967 USDT** au prix de référence) pour un plafond d'instruction d'achat de **8 341 675 lamports** (environ 1 USDT, hors frais réseau et dépôt de compte). Le produit net du SELL est de **8 302 702 lamports**. Le résultat de ce deuxième trade est de **+233 444 lamports**, soit **+143 444 lamports après les 90 000 lamports de frais réseau**.

Ce résultat prouve le cycle ponctuel décrit ici, pas la réussite du canary formel de l'[issue #89](https://github.com/pivox/sol-token-listener/issues/89) : les gates H2 et l'exécuteur applicatif requis par cette issue n'ont pas été utilisés. Aucun processus de trading autonome ne reste armé. Le travail de l'issue #218 est resté de côté.

## Sniff et choix du mint

Le sniffer a écouté les créations Pump.fun Mainnet du **3 octobre 2026, 17:33:52–17:34:16 UTC** et s'est arrêté exactement à **15 mints distincts**. Les créations ont été contrôlées à finalité `finalized`, puis une fenêtre de 45 secondes a mesuré l'activité. Les nombres B/S ci-dessous proviennent des préfixes `TradeEvent` observés ; ce relevé d'activité sert à la sélection, pas à prouver à lui seul chaque transaction.

| # | Mint | Paire | Mayhem | BUY/SELL observés (45 s) | Acheteurs distincts |
|---:|---|---|---|---:|---:|
| 1 | `Fd4GeDS1LmPUS1Pcqh1FjttPNra6zDXdrQKe4pjREYa` | SOL | non | 0/1 | 0 |
| 2 | `AaGudx79Wrcnuib8kCRbNwzro13NKFFbLEq11Dajpump` | SOL | oui | 7/10 | 1 |
| 3 | `9Rg8AE26nNT7itWqbNBb9vqqmUhwkhoNiayBEvxjpump` | SOL | non | 1/1 | 1 |
| 4 | `8ikue4G4saj2dC7M9C5PYGuCvxXDmAjrHpBd9Bfwpump` | USDC | oui | 24/26 | 5 |
| 5 | `JCucWdb12vLcAezQg5WDtNpigF34QriRRfQTGEcTpump` | SOL | non | 0/1 | 0 |
| 6 | `GQCZLyB4oBc7reihhkHBDbWYY54et7MtBQwagQabpump` | SOL | non | 0/0 | 0 |
| 7 | `4eNYCcNKt6R7rEUPDCGcGQnW6TUUHTutfKJtcE6epump` | SOL | non | 51/64 | 46 |
| 8 | `ER4ciu9k4jYYobVPjcyJr7fzLv6kgnX7SfRiG7Vpump` | SOL | non | 99/22 | 99 |
| 9 | `3d61D3FsyKyqaJcsoo4A5xGtqKPK5gTFMySM7jnSpump` | SOL | non | 39/44 | 34 |
| 10 | `F8hLLXLZjvtUsjcLUwCw6x3keYajXEDVQnYJLCysygb` | SOL | non | 1/0 | 1 |
| 11 | `CupUWMzfEpUU4q5tSYWYrKVE6WxT8ASeimyaA9UrLEic` | SOL | non | 0/0 | 0 |
| 12 | `G7Dov2Bi8jiWtWwEfcpw1ikfeBuCdeNkBzHftoF5pump` | SOL | non | 2/0 | 1 |
| 13 | `3se75paoDUtV2f1WBgQhSjMhfq3emUT4cDTiJafRpump` | SOL | non | 0/0 | 0 |
| 14 | `4D4ViHKoE28FNCdpmjuxqjnjXBMq6AYGKC6HVv1Hpump` | SOL | non | 3/6 | 2 |
| 15 | `HnRLLMXyEWJmYYMGePY9kkPkdrCBTirzXmr3YbnEpump` | SOL | oui | 24/22 | 5 |

Le premier contrôle de finalité des candidats #7 et #8 a refusé leurs créations parce que le script demandait `maxSupportedTransactionVersion: 0` alors que ces transactions sont en version 1. Cette limite locale a été corrigée ; les deux créations ont ensuite été vérifiées `finalized`, sans erreur, sur des mints Token-2022 et des courbes SOL non Mayhem. Le premier classement automatique, qui excluait ces deux candidats, a été invalidé et la correction est conservée dans les preuves.

Le #8 était le plus actif, mais sa réserve SOL était montée à **68,602 SOL** lors de la correction et la courbe se rapprochait de la graduation vers PumpSwap. Le #7 gardait plus de marge et une activité suffisante pour chercher cinq acheteurs. Juste avant le BUY, sa courbe affichait **54,046 SOL** de réserve réelle, n'était pas complète et acceptait une cotation de SELL immédiat. Le script devait déclencher une sortie anticipée si la courbe atteignait 70 SOL de réserve réelle ou passait sous 50 billions d'unités brutes de tokens restantes ; ce garde-fou n'a pas été déclenché.

## Exécution et preuves des cinq acheteurs

À **17:37:32 UTC**, le dernier prix SOL/USDT reçu de l'[API publique Kraken](https://api.kraken.com/0/public/Ticker?pair=SOLUSDT) était **119,88 USDT/SOL**. Le wallet avait **460 082 101 lamports** avant ce deuxième BUY. Le mint, le programme Token-2022, les extensions, le hash de genèse Mainnet, la réserve, la cotation de revente et la clé du wallet ont été contrôlés. La simulation du BUY a réussi avec `105831` unités de calcul.

| Événement UTC | Preuve |
|---|---|
| 17:37:34 | [BUY finalisé](https://explorer.solana.com/tx/35u7ku5SUJsiiavdVmtUA2GYQkqyfkKvcZd4BAP1qRPrbpa43yMeMDjTHMEf93ZrxcCP47JP1uhoJs9e5AfY8vVy), slot `453002869` ; `36 414 343 100` unités brutes reçues. |
| 17:37:47 | Acheteur #1 [`7PYDAg…pr8J`](https://explorer.solana.com/tx/58gMgRT1GhAdLX1jqjLkQJ4QyytmQGCVvccEzm7VZeEG24DZQ43dM11za3yMGLgrqeu4PeHbvVmiW7FBxPajKsNo), slot `453002894` ; acheteur #2 [`DYGnRJ…eCZp`](https://explorer.solana.com/tx/2gG2ynX3J55diPL3nPbFffWfW2mMFnLrmgXa1EEfjugznP7m8tvbV47YUWuohyTdN2kZeyPXjgLXXVN3dYyTtLux), même slot. |
| 17:37:49 | Acheteur #3 [`5BkokS…7yhn`](https://explorer.solana.com/tx/58LhrqoF9YvnJsSNHz1KQfLWS6TPDE9JtUWd9M67iqZeocVoCRsvesrjstSU7RRnhDNHHRJUBLVoXH31JRhHpH53), #4 [`7KiKBu…PGiv`](https://explorer.solana.com/tx/2FcGNrdtUm6W5yd6qjDW98XBdendKHjpYDbMvtPFXjR4dNNSkZtaYhiSNhB5pCEjgHmijGaBL49V1ryFa3d9qCmA) et #5 [`H6EXnc…4A62`](https://explorer.solana.com/tx/2gz92TVs2qiQF69jx47UY5KsYAkaVa6ijeGEABswf2Wr37cM8mEPBk8qB4bgtqSAUkW7cNPCA9ByRSNPV8wow67d), slot `453002895`. |
| 17:37:49 | SELL déclenché après cinq adresses distinctes ; cotation `8 224 393` lamports, minimum d'instruction `7 401 953` lamports. Simulation réussie avec `73497` unités de calcul. |
| 17:37:54 | [SELL finalisé](https://explorer.solana.com/tx/5rBUGCx4DxrVC2eeUo86bKaWs8t94pjKXZQmqbKwtnrxnsWqfeKvhP5fFats955LqxpVnw5EGer1Lpc5r3ymyBU4), slot `453002948`. Solde du token après la vente : **0**. |

Les cinq signatures externes ont été relues avec `getTransaction(..., finalized, maxSupportedTransactionVersion: 1)` : toutes sont finalisées, sans erreur, et contiennent un préfixe d'événement avec ce mint, `is_buy=true`, une quantité de tokens positive et une adresse `user` différente du wallet et des quatre autres. Leurs slots sont strictement postérieurs à notre BUY. Le suffixe non décodé mesure encore **24 octets** ; le résidu wire de l'[issue #215](https://github.com/pivox/sol-token-listener/issues/215) demeure ouvert et cette vérification ciblée ne remplace pas la validation du pipeline complet.

## Comptabilité réconciliée

La transaction BUY finalisée a transféré `7 969 637` lamports à la courbe, `75 712` de frais Pump.fun et `23 909` de frais créateur : **8 069 258 lamports** au total pour le trade. Elle a aussi créé l'ATA Token-2022 avec un dépôt de `1 513 840` lamports et payé `45 000` de frais réseau. Le compte Pump.fun d'accumulation de volume créé lors du premier trade existait déjà ; aucun second dépôt de ce type n'a été fait.

La transaction SELL finalisée a coté `8 407 801` lamports bruts, prélevé `79 875` de frais Pump.fun et `25 224` de frais créateur, puis crédité **8 302 702 lamports** au wallet. Ses frais réseau sont de `45 000` lamports.

| Mesure | Lamports | SOL | Approximation USDT à 119,88 |
|---|---:|---:|---:|
| Dépense BUY, frais Pump.fun inclus | 8 069 258 | 0,008069258 | 0,96734 |
| Encaissement SELL, frais Pump.fun déduits | 8 302 702 | 0,008302702 | 0,99533 |
| Résultat du trade | **+233 444** | **+0,000233444** | **+0,02799** |
| Frais réseau BUY + SELL | 90 000 | 0,000090000 | 0,01079 |
| Résultat après frais réseau | **+143 444** | **+0,000143444** | **+0,01720** |
| Nouveau dépôt de compte encore immobilisé | 1 513 840 | 0,001513840 | 0,18148 |
| Variation du SOL liquide du wallet | **−1 370 396** | **−0,001370396** | **−0,16428** |

Solde liquide du wallet : `460 082 101` avant, `458 711 705` lamports après. L'ATA du deuxième mint est vide, mais reste ouvert avec son dépôt de `1 513 840` lamports ; ce dépôt n'est pas compté comme perte réalisée. Les deux aller-retours de cette session cumulent **−2 762 197 lamports après frais réseau**, hors les dépôts de comptes encore ouverts. Aucun ordre SELL de la relance n'a expiré et aucun second ordre n'a été nécessaire.

## Logs et limites

Les fichiers locaux expurgés conservent les 15 créations, les contrôles initiaux, la correction des transactions de version 1, l'activité, le choix final et les étapes du canary : [`sniff.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/sniff.jsonl), [`candidates.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/candidates.jsonl), [`candidate-corrections.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/candidate-corrections.jsonl), [`activity.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/activity.jsonl), [`selection-corrected.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/selection-corrected.jsonl) et [`canary.jsonl`](evidence/2026-10-03-mainnet-microtrade-r2/canary.jsonl). Aucun secret, fichier de clé ni URL RPC credentialée n'y a été copié.

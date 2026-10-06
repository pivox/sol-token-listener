# Premier microtrade Pump.fun Mainnet — 3 octobre 2026

## Résultat

Un BUY réel puis un SELL complet ont été confirmés et finalisés sur Solana Mainnet pour le mint `A3KGAmJzLP1Jhup5DSdp2u8crTg5Ma5w4EKbJYFNR4Mo`. Le BUY a suivi une création Pump.fun détectée en direct parmi **15 créations distinctes au maximum**. Cinq achats, attribués à cinq adresses externes distinctes, ont été finalisés après le slot du BUY ; le SELL a ensuite été déclenché. Le premier envoi du SELL a expiré sans être inclus. Une vente de récupération, avec nouvelle cotation et nouveau blockhash, a été finalisée. Le compte de tokens du wallet contient **0 token** après la vente.

Ce résultat atteste les transactions et les soldes décrits ci-dessous. Il ne constitue pas le verdict `PASS` du canary formel de l'[issue #89](https://github.com/pivox/sol-token-listener/issues/89) : les preuves H2e/H2d/H2c, l'armement opérateur et l'exécuteur applicatif exigés par cette issue n'ont pas été utilisés. L'opération a été menée par un script ponctuel hors dépôt à la demande de l'utilisateur ; aucun service de trading autonome n'a été armé. Le travail de l'issue #218 est resté de côté.

## Préparation et découverte

- `.env` local : `SOLANA_CLUSTER=mainnet-beta`, URL HTTP et WebSocket Helius Mainnet, hash de genèse Mainnet vérifié contre le RPC ; `EXECUTION_MODE=observe` est resté en place. Les URL complètes et leurs paramètres ne figurent pas dans les preuves.
- Wallet : clé Base58 de `.key` décodée en mémoire, adresse dérivée égale à `EXECUTOR_PUBLIC_KEY`, solde initial **465 847 782 lamports**. `.key` est ignoré par Git et limité au propriétaire (`0600`). Aucun secret n'est inclus ici.
- Docker : conteneur de test arrêté, volume nommé et neuf volumes anonymes retirés, puis images et cache de build nettoyés ; inventaires conteneurs, volumes et images vides après nettoyage.
- Ancien document de roadmap déplacé vers [`docs/roadmap/backlog-sans-issue.md`](../roadmap/backlog-sans-issue.md).
- Sniff Pump.fun du **3 octobre 2026, 16:41:27–16:41:59 UTC** : arrêt dès la quinzième création. Les 15 signatures de création ont été retrouvées avec `finalized`, le mint concordait et une courbe était présente. Fenêtre de mesure d'activité suivante : 90 secondes, 220 événements de trade présélectionnés.

La colonne « réserve » est le SOL réel dans la courbe au contrôle initial, pas une liquidité garantie au moment du trade. « B/S » dénombre les événements BUY/SELL observés durant les 90 secondes ; les événements ont été lus par préfixe IDL et gardent la limite de décodage décrite plus bas.

| # | Mint | Paire | Mayhem | Réserve initiale SOL | B/S (90 s) | Acheteurs distincts (90 s) |
|---:|---|---|---|---:|---:|---:|
| 1 | `Fodh8u3HV227kY4RygHiCiTnfJRAP2tVFGxHsPH99r3t` | SOL | non | <0,001 | 0/0 | 0 |
| 2 | `CBztogX8WUqgFgucoQJMap1nBnL2aDgcvqGRFwQqyhBd` | autre | non | <0,001 | 0/0 | 0 |
| 3 | `2j4NFq5B1afVVdWxyZujrDnzQQqY9pJzw4RH1nPzGVre` | SOL | non | 0,599 | 0/2 | 0 |
| 4 | `4C3pwVrGzHkZfQR6DuD9bsF29WBkPDUeEj2xiQSYpump` | SOL | oui | 0,018 | 0/0 | 0 |
| 5 | `9oee3WUATFzTpis6PsXN2zgJEHMN5r5AM3sb2DX5pump` | SOL | oui | <0,001 | 0/0 | 0 |
| 6 | `ELzviPanyZmGiSBWbb32gZsBVpQ5TyRLrto9XsQ3pump` | SOL | non | 0,144 | 0/0 | 0 |
| 7 | `EDVtWoV5GsEFDTK7kY67VXcdTwz4fqMS4SxE5UQEQtha` | SOL | non | 0,337 | 0/0 | 0 |
| 8 | `A3KGAmJzLP1Jhup5DSdp2u8crTg5Ma5w4EKbJYFNR4Mo` | SOL | non | 28,733 | 96/81 | 72 |
| 9 | `D6WVv8NCjroiDcR3wEE4q2Fi1t7LxvcHp3NtxVVS3yqH` | SOL | non | 2,377 | 5/0 | 5 |
| 10 | `9MWJwPStzoCdzHffJFEjYP3S2HQko35dc2m5NjMXpump` | SOL | oui | 3,101 | 17/14 | 3 |
| 11 | `8fFXdk8y8ZY4Pjxf4Rx3SuVsPUwhuUY9yr19sT2Vpump` | SOL | non | <0,001 | 0/0 | 0 |
| 12 | `HSTrJmJAXJLC1anw9gbFCparRacSaiBP6ew59nQWpump` | SOL | oui | <0,001 | 0/0 | 0 |
| 13 | `CkDjUpCQRNqgKCQo82jwWhJbpGM6pamQLdbuCJvbpump` | SOL | oui | 0,019 | 0/0 | 0 |
| 14 | `9heZ7LyHkmYTcoR4TavbWzsz5We54MLwSCJ7u4i4nGad` | SOL | non | <0,001 | 4/1 | 4 |
| 15 | `5FEnmM1uGhaD3UCkgrgWWrYhExZdjGo9qXq9rdNvpump` | SOL | oui | <0,001 | 0/0 | 0 |

Le candidat #8 avait la plus forte activité récente et une réserve SOL bien supérieure à la dépense prévue. Son mint était Token-2022 avec extensions attendues ; il n'était ni Mayhem ni sorti de la courbe. Le #9 avait eu cinq achats initiaux, puis aucune nouvelle activité dans la suite de la fenêtre. La sélection n'est pas une garantie contre une baisse rapide de prix.

## Exécution et déclencheur de sortie

À **16:52:30 UTC**, le dernier prix public SOL/USDT de [Kraken](https://api.kraken.com/0/public/Ticker?pair=SOLUSDT) était **119,72 USDT/SOL**. Le plafond d'instruction du BUY était de **8 352 823 lamports** (environ 1 USDT de SOL, hors frais et dépôts de comptes). Le montant de tokens a été calculé avec 3 % de marge sous ce plafond. La simulation Mainnet a réussi avant l'envoi : `104386` unités de calcul. La cotation de SELL immédiat était de `7 899 896` lamports, vérifiée avant la prise de position ; elle n'engageait pas le prix futur.

| Événement UTC | Résultat |
|---|---|
| 16:52:30 | BUY soumis ; signature [`5eNgwx…LcZex9`](https://explorer.solana.com/tx/5eNgwxQXNQHimsMj9mghQsV21PMnWLP5LLNBPbMbCyH5TZgRXhL3XLtrnaVRhNcgdx1gCxUG7tKJT38KYcLcZex9), slot `452992824`, finalisé. `84 019 846 948` unités brutes de token reçues. |
| 16:52:43 | Acheteur externe #1 [`ARu4n5…T5SZn`](https://explorer.solana.com/tx/2PtvymNur81KpgLT3BHzFTMrM2sh3cA7GTFEDMDaWGapNXV16NPgBhERp7yk1MtFc8urABVzuh8QRGDnYxRS55cX), slot `452992832`. |
| 16:52:44 | Acheteur #2 [`HkRWht…VzRBjY`](https://explorer.solana.com/tx/43zwDJAAs6G7wCLEnWZCG8fXHeViF79eJWmwwBQANeGn8mUtPgNhkzshoFCTEwfdyTY9ux51LEXMQ55vyRjcXxAh), slot `452992840`. |
| 16:52:59 | Acheteur #3 [`Ced44c…KMgzzT`](https://explorer.solana.com/tx/2yKV6GC6WYGYBL19vgrNe9TydupMrTsG6eDRQPmiGhyCNL2Y2srEN6XBquQSqh8AVobATo15GmCpsWRyy5hsAYd2), slot `452992889` ; acheteur #4 [`8A9diL…wyLD`](https://explorer.solana.com/tx/2vEqoz9yaeKt6LciwAKxnj9KFzMPjE5GE7ygJP49BZqMXi4s9uKFjE4RabsbxwyF1oXNWRAWrXSfK39R6VALJj5z), slot `452992893`. |
| 16:53:10 | Acheteur #5 [`ChmiYK…sXJKV4`](https://explorer.solana.com/tx/4yGd3LiZD8LmQCNmG7h4trB9BR8aVtUyt2iAn5txQHuRNKxNpT3G1EsPWszMei28fBciWbusrnjbvAX8qBXXdMGR), slot `452992933`. Déclenchement du SELL. |
| 16:53:11 | Premier SELL simulé avec succès et [soumis](https://explorer.solana.com/tx/5R3wdsewHGmyJxxmeLA14sdNBQbUey4gwK1ckBMR1uQe6o1168eYhHGPVvPi7b2zJu2aiP1Q3JeYBQwUoG4MMgRS) ; blockhash expiré, statut RPC `null`, aucun débit de tokens ni frais observé. |
| 16:55:07–16:55:09 | Nouvelle cotation et simulation, SELL de récupération [finalisé](https://explorer.solana.com/tx/5fn4UPDgdPvmSzxQoTVmTmbzTAoDVut2KEE7RdZu7TXWsoEr9x9RPHkXULE6wS5w1nMpZbPUHGEHR3CCZVXVoWi2), slot `452993401`. Solde de tokens : `0`. |

Les cinq signatures externes ont été retrouvées `finalized`, sans erreur, sur des slots strictement postérieurs à notre BUY. Chaque transaction contient un préfixe `TradeEvent` indiquant le même mint, `is_buy=true` et une adresse `user` distincte de notre wallet. Le premier acheteur termine sa transaction avec un solde net de tokens nul ; son événement BUY est néanmoins présent. Les suffixes de ces événements mesurent **24 octets**, alors que le décodeur applicatif actuel accepte 0 ou 16 octets : le résidu wire suivi par [#215](https://github.com/pivox/sol-token-listener/issues/215) demeure ouvert. Ce contrôle ciblé du préfixe ne remplace donc pas le décodage complet du pipeline.

## Comptabilité on-chain

Montants observés dans les transactions finalisées, en lamports. Le BUY a transféré `8 079 543` à la courbe, `76 756` de frais de plateforme et `24 239` de frais créateur, soit **8 180 538 lamports de dépense de trade** (≈ **0,97937 USDT** au cours de référence). Il a également créé l'ATA Token-2022 (`1 513 840` lamports) et le compte Pump.fun d'accumulation de volume (`1 346 200` lamports), et payé `15 000` lamports de frais réseau.

Le SELL finalisé a coté `5 402 429` lamports bruts, prélevé `51 324` de frais de plateforme et `16 208` de frais créateur, puis crédité **5 334 897 lamports** au wallet. Frais réseau de cette transaction : `45 000` lamports. Le SELL expiré n'apparaît pas sur chaîne et n'a pas modifié le solde.

| Mesure | Lamports | SOL | Approximation USDT à 119,72 |
|---|---:|---:|---:|
| Dépense BUY, frais Pump.fun inclus | 8 180 538 | 0,008180538 | 0,97937 |
| Encaissement SELL, frais Pump.fun déduits | 5 334 897 | 0,005334897 | 0,63869 |
| Résultat du trade | **−2 845 641** | **−0,002845641** | **−0,34068** |
| Frais réseau BUY + SELL | 60 000 | 0,000060000 | 0,00718 |
| Résultat après frais réseau | **−2 905 641** | **−0,002905641** | **−0,34786** |
| SOL immobilisé en dépôts de deux comptes encore ouverts | 2 860 040 | 0,002860040 | 0,34240 |
| Variation du solde SOL liquide du wallet | **−5 765 681** | **−0,005765681** | **−0,69027** |

Solde liquide : `465 847 782` avant, `460 082 101` lamports après. L'ATA est vide mais reste ouvert avec son dépôt ; le compte d'accumulation de volume reste aussi ouvert. Ces dépôts ne sont pas assimilés à une perte réalisée dans le résultat après frais réseau. Le rendement du trade, hors frais réseau et dépôts, est d'environ **−34,79 %** sur les `8 180 538` lamports dépensés. Le prix de la courbe a baissé pendant l'attente et l'expiration du premier ordre a prolongé l'exposition.

## Incidents, état du projet et preuves

1. Le premier essai de simulation du script ponctuel utilisait le mauvais overload `simulateTransaction` pour une transaction legacy. Aucune transaction n'a été envoyée. L'usage d'une `VersionedTransaction` a corrigé le problème ; la simulation a ensuite réussi.
2. Le premier SELL a été accepté par le RPC mais n'a pas été inclus avant expiration du blockhash. Nous avons vérifié son absence de statut et le solde de tokens inchangé, puis réévalué la courbe, augmenté la priorité, simulé un nouveau SELL et attendu sa confirmation. Ce cas montre qu'une réponse `sendRawTransaction` ne prouve pas l'inclusion. Le script de récupération rebroadcastait la même transaction signée tant que son blockhash restait valide ; l'essai récupéré a été confirmé à la première inclusion. Il n'y a pas eu de second BUY.
3. La baisse du produit de vente est un mouvement réel de marché, pas une erreur de comptabilité. La cotation estimée au cinquième acheteur était de `6 384 003` lamports ; celle de la récupération, de `5 334 897` lamports. Aucun nouveau trade n'a été ouvert après la clôture de cette position.
4. Le travail formel #89 et le résidu wire #215 restent à traiter avant d'affirmer que l'exécuteur du projet satisfait ses propres gates. Le travail #218 n'a pas été repris.

Preuves locales expurgées : [`sniff.jsonl`](evidence/2026-10-03-mainnet-microtrade/sniff.jsonl), [`candidates.jsonl`](evidence/2026-10-03-mainnet-microtrade/candidates.jsonl), [`trade-activity.jsonl`](evidence/2026-10-03-mainnet-microtrade/trade-activity.jsonl), [`canary.jsonl`](evidence/2026-10-03-mainnet-microtrade/canary.jsonl). Elles contiennent uniquement des données publiques de marché, des signatures, l'adresse publique du wallet, les résultats et erreurs du script ; aucun secret ni URL RPC credentialée.

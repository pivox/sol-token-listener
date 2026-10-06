# Cinquième relance Mainnet — session de trente minutes

Mise à jour : **2026-10-03T22:06:23.607Z**. Début : **2026-10-03T21:36:23.564Z**. Fin prévue : **2026-10-03T22:06:23.564Z**. État : **finished**.

## Étapes

| Étape | Heure ou valeur | Résultat |
|---|---|---|
| Démarrage | 2026-10-03T21:36:23.564Z | Terminé |
| Préflight Mainnet et wallet | 2026-10-03T21:36:23.708Z | Terminé |
| Découverte Pump.fun | 2026-10-03T21:42:55.113Z | Vague 6 ; 90 créations observées |
| Trade en cours | — | Aucun |
| Arrêt automatique | 2026-10-03T22:06:23.564Z | Terminé |

## Résultats

| # | Mint | Achat | Vente | Signal de vente | État | PnL estimé USDT |
|---:|---|---|---|---:|---|---:|
| 1 | `AT32f1p51FHjTqMJk54mM4i5vMAsRL1CFoxNQUg5pump` | [BUY](https://solscan.io/tx/NgykNoFdqffcPwqfjhnNYRupnYVPo3JPhD2WXPQrUiiGMZE4B1suJDXDjPKXavyMToYsudhpKnrqK1iuKfxkBrT) | [SELL](https://solscan.io/tx/2uXNinUktBBkRTQtbkMrrvdJDoWsY1tGvAvyGtQijKCivQiUabJdfzmpBKf859GZh6CtKS55Z6q4A5xYiNwRn6Kz) | objectif +0.01 USDT net ; net_profit_target | vendu, solde token 0 | 0.0296 |
| 2 | `7JGeJDmu9vdENkWuxtRdZfawBZRsWaaoUJDaNEJRpWxU` | [BUY](https://solscan.io/tx/512nUGf3z6LQukxubg5zNNR7RuP5BoWt6vjkCfE5rnvhWLP6yATPsq2YoSLCvoQwad7XieocEpnnqQ52tiPZtPLe) | [SELL](https://solscan.io/tx/3Qscst2TsqVECKmdsSuJK9XSjw8U1mJGFMLNF9bBATKzK52TpUuu3V2ZNeoZbkXLTy8BxtrPP2DkKq8BaBdu9uy4) | objectif +0.01 USDT net ; max_hold_15_minutes | vendu, solde token 0 | -0.5012 |

Vagues : **6** ; créations observées : **90** (15 maximum par vague) ; BUY soumis : **2/15** ; ventes : **2** ; échecs : **0**. PnL économique estimé de cette session : **-0.4716 USDT** ; solde wallet : **0.446173140 SOL**.

Le PnL additionne la variation du wallet et le loyer des comptes token toujours détenus ; sa conversion USDT utilise le cours Kraken de chaque achat. Il reste indicatif jusqu'à la réconciliation finale. Les trades sont directs, hors pipeline API/front existant, et ne valident pas le canary formel #89.

Journaux : [session](evidence/2026-10-03-mainnet-microtrade-r5/session.jsonl), [état JSON](evidence/2026-10-03-mainnet-microtrade-r5/status.json), [preuves par vague et trade](evidence/2026-10-03-mainnet-microtrade-r5/). Arrêt opérateur : créer le fichier `docs/operations/evidence/2026-10-03-mainnet-microtrade-r5/STOP` ; une position ouverte est vendue avant l'arrêt si la courbe le permet.

Dernier événement : `done`. Dernière erreur : aucune.

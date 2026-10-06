# Bilan détaillé — cinquième relance Mainnet

Session terminée avec positions déclarées soldées. Début : **2026-10-03T21:36:23.564Z** ; échéance : **2026-10-03T22:06:23.564Z** ; génération : **2026-10-03T22:06:39.285Z**.

## Synthèse

- 6 vagues de découverte, 90 créations Pump.fun observées, 15 mints au plus par vague.
- 2 BUY soumis, 2 achats exécutés puis revendus, 2 ventes confirmées, 0 tentatives échouées.
- PnL économique estimé, frais des transactions échouées inclus : **-0.471589 USDT**. Solde final : **0.446173140 SOL**.
- Limites : 1 USDT environ en SOL par achat, un trade à la fois, maximum 15 BUY soumis, réserve 0,1 SOL, arrêt si perte cumulée atteint 3 USDT environ.

## Vagues de découverte

| Vague | Créations | Créations finalisées | Candidats éligibles | Événements de trade vus | Choix |
|---:|---:|---:|---:|---:|---|
| 1 | 15 | 15 | 0 | 962 | aucun |
| 2 | 15 | 15 | 0 | 74 | aucun |
| 3 | 15 | 15 | 0 | 151 | aucun |
| 4 | 15 | 15 | 0 | 574 | aucun |
| 5 | 15 | 15 | 1 | 174 | `AT32f1p51FHjTqMJk54mM4i5vMAsRL1CFoxNQUg5pump` |
| 6 | 15 | 15 | 1 | 304 | `7JGeJDmu9vdENkWuxtRdZfawBZRsWaaoUJDaNEJRpWxU` |

## Transactions et sorties

Les montants sont en lamports. Le PnL estimé ajoute à la variation de wallet le loyer du compte token conservé avec solde zéro, puis convertit au cours SOL/USDT utilisé pour l'achat.

| # | Mint | Coût prévu BUY | Frais BUY | Produit prévu SELL | Frais SELL | Signal de vente | Motif vente | PnL USDT | État |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | `AT32f1p51FHjTqMJk54mM4i5vMAsRL1CFoxNQUg5pump` | 8107654 | 45000 | 8537405 | 45000 | objectif +0.01 USDT net | net_profit_target | 0.029639 | vendu, solde token 0 |
| 2 | `7JGeJDmu9vdENkWuxtRdZfawBZRsWaaoUJDaNEJRpWxU` | 8107654 | 45000 | 4008185 | 45000 | objectif +0.01 USDT net | max_hold_15_minutes | -0.501228 | vendu, solde token 0 |

Les signatures et le déroulé étape par étape figurent dans le [tableau de session](mainnet-microtrade-2026-10-03-relance-5.md). Les preuves brutes expurgées se trouvent dans [le dossier de la relance](evidence/2026-10-03-mainnet-microtrade-r5/). Les événements de trade ont été reconnus par leur préfixe IDL, puis les signatures d'acheteurs ont été vérifiées finalisées. Le suffixe IDL de 24 octets reste à traiter dans #215. Cette session directe ne valide pas les gates du canary formel #89.

Dernière erreur : aucune.

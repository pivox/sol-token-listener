# Bilan détaillé — sixième relance Mainnet

Session terminée avec positions déclarées soldées. Début : **2026-10-03T22:39:45.324Z** ; échéance : **2026-10-03T23:09:45.324Z** ; génération : **2026-10-03T22:48:54.725Z**.

## Synthèse

- 6 vagues de découverte, 90 créations Pump.fun observées, 15 mints au plus par vague.
- 1 BUY soumis, 1 achats exécutés puis revendus, 1 ventes confirmées, 0 tentatives échouées.
- PnL économique estimé, frais des transactions échouées inclus : **0.013141 USDT**. Solde final : **0.444768915 SOL**.
- Limites : 1 USDT environ en SOL par achat, un trade à la fois, maximum 15 BUY soumis, vente de sécurité après 5 minutes, réserve 0,1 SOL, arrêt si perte cumulée atteint 3 USDT environ.

## Vagues de découverte

| Vague | Créations | Créations finalisées | Candidats éligibles | Événements de trade vus | Choix |
|---:|---:|---:|---:|---:|---|
| 1 | 15 | 15 | 0 | 391 | aucun |
| 2 | 15 | 15 | 0 | 251 | aucun |
| 3 | 15 | 15 | 2 | 357 | `EKXPRCENhYVMA2jn4dQgMqZwaMcVgqL1WudhHyKU185s` |
| 4 | 15 | 15 | 0 | 168 | aucun |
| 5 | 15 | 15 | 0 | 60 | aucun |
| 6 | 15 | 15 | 0 | 566 | aucun |

## Transactions et sorties

Les montants sont en lamports. Le PnL estimé ajoute à la variation de wallet le loyer du compte token conservé avec solde zéro, puis convertit au cours SOL/USDT utilisé pour l'achat.

| # | Mint | Coût prévu BUY | Frais BUY | Produit prévu SELL | Frais SELL | Signal de vente | Motif vente | PnL USDT | État |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | `EKXPRCENhYVMA2jn4dQgMqZwaMcVgqL1WudhHyKU185s` | 8091423 | 45000 | 8291038 | 45000 | objectif +0.01 USDT net | net_profit_target | 0.013141 | vendu, solde token 0 |

Les signatures et le déroulé étape par étape figurent dans le [tableau de session](mainnet-microtrade-2026-10-03-relance-6.md). Les preuves brutes expurgées se trouvent dans [le dossier de la relance](evidence/2026-10-03-mainnet-microtrade-r6/). Les événements de trade ont été reconnus par leur préfixe IDL, puis les signatures d'acheteurs ont été vérifiées finalisées. Le suffixe IDL de 24 octets reste à traiter dans #215. Cette session directe ne valide pas les gates du canary formel #89.

Dernière erreur : aucune.

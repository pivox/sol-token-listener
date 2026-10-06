# Bilan détaillé — septième relance Mainnet

Session terminée avec positions déclarées soldées. Début : **2026-10-03T22:52:35.197Z** ; échéance : **2026-10-04T02:52:35.197Z** ; génération : **2026-10-04T03:16:30.870Z**.

## Synthèse

- 5 vagues de découverte, 26 créations Pump.fun observées, 15 mints au plus par vague.
- 1 BUY soumis, 1 achats exécutés puis revendus, 1 ventes confirmées, 5 tentatives échouées.
- PnL économique estimé, frais des transactions échouées inclus : **-0.548892 USDT**. Solde final : **0.438673339 SOL**.
- Limites : 1 USDT environ en SOL par achat, un trade à la fois, maximum 15 BUY soumis, vente de sécurité après 5 minutes, réserve 0,1 SOL, arrêt si perte cumulée atteint 3 USDT environ.

## Vagues de découverte

| Vague | Créations | Créations finalisées | Candidats éligibles | Événements de trade vus | Choix |
|---:|---:|---:|---:|---:|---|
| 1 | 15 | 15 | 1 | 500 | `AhGVNyb2e2vBWb4K3QxevvHen3UWyunDPMsSXvaJpump` |
| 2 | 4 | 0 | 0 | 0 | aucun |
| 3 | 3 | 0 | 0 | 0 | aucun |
| 4 | 1 | 0 | 0 | 0 | aucun |
| 5 | 3 | 0 | 0 | 0 | aucun |

## Transactions et sorties

Les montants sont en lamports. Le PnL estimé ajoute à la variation de wallet le loyer du compte token conservé avec solde zéro, puis convertit au cours SOL/USDT utilisé pour l'achat.

| # | Mint | Coût prévu BUY | Frais BUY | Produit prévu SELL | Frais SELL | Signal de vente | Motif vente | PnL USDT | État |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | `AhGVNyb2e2vBWb4K3QxevvHen3UWyunDPMsSXvaJpump` | 8096827 | 45000 | 3605091 | 45000 | objectif +0.01 USDT net | recover_expired_sell | -0.548892 | vendu, solde token 0 |

Les signatures et le déroulé étape par étape figurent dans le [tableau de session](mainnet-microtrade-2026-10-03-relance-7.md). Les preuves brutes expurgées se trouvent dans [le dossier de la relance](evidence/2026-10-03-mainnet-microtrade-r7/). Les événements de trade ont été reconnus par leur préfixe IDL, puis les signatures d'acheteurs ont été vérifiées finalisées. Le suffixe IDL de 24 octets reste à traiter dans #215. Cette session directe ne valide pas les gates du canary formel #89.

Dernière erreur : Découverte vague 5, code 13.

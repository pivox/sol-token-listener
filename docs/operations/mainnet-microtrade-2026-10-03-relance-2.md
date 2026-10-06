# Troisième relance Mainnet — observation sans nouvel ordre

## Résultat

Le 3 octobre 2026, un nouveau sniff Pump.fun Mainnet a été lancé à **17:48:10 UTC** et arrêté à **15 créations distinctes** à **17:48:24 UTC**. Les 15 créations ont été retrouvées finalisées et les courbes ont été contrôlées. Une première fenêtre de 45 secondes, puis une prolongation de 120 secondes sur les **mêmes 15 mints**, n'ont donné aucun candidat ayant à la fois une courbe SOL encore revendable, une réserve suffisante et un flux récent d'achats externes pour viser le seuil de cinq acheteurs après notre BUY.

**Aucun BUY ni SELL n'a été soumis pendant cette troisième relance.** Le wallet est resté à **458 711 705 lamports**. Les deux tokens des aller-retours précédents ont chacun un solde de **0**. L'absence d'ordre est un résultat de sélection de marché sous la limite de 15 mints, pas un échec de simulation ou du RPC.

## Les 15 créations observées

Les réserves sont les montants SOL réels lus lors du contrôle initial des courbes. Les colonnes BUY/SELL et acheteurs proviennent des préfixes `TradeEvent` observés pendant les 45 secondes suivantes ; il ne s'agit pas d'un historique exhaustif. Les valeurs inférieures à `0,001 SOL` sont notées `<0,001`.

| # | Mint | Mayhem | Courbe complète | Réserve initiale SOL | BUY/SELL (45 s) | Acheteurs distincts |
|---:|---|---|---|---:|---:|---:|
| 1 | `drWp1eUrCUh3yWVecd67zFGmrzURJvpPC51DxSApump` | non | non | 7,217 | 0/4 | 0 |
| 2 | `E6BVTJkFGZDA6zMHLTQkR38borLdSzDv7aTn77oLgdXp` | non | non | <0,001 | 0/0 | 0 |
| 3 | `HtCtGChpeAZYj2Bi69N7P4GuWkD4ajcTGPKuwQ3ipump` | non | non | 0,365 | 2/3 | 2 |
| 4 | `2DB7z96c6qYqn2HaHE4nuXQc8X1v1dVjV45HjMEzpump` | non | non | 0,026 | 0/0 | 0 |
| 5 | `BdamGWD6YG86HkBeqv1RZGFo3bMMb1RzEa6aPLbopump` | non | non | 0,003 | 0/0 | 0 |
| 6 | `7rmySuHicymL62rYfHiFY4xY7s8fjEvTAxFeaPmgpump` | non | oui | 0 | 0/0 | 0 |
| 7 | `J8vnr5eHQx5uwKViawb9FR3s9bmd3aLzXjjkwVxNpump` | oui | non | 0,111 | 5/5 | 2 |
| 8 | `FZ1NkupviNV8QAHQmhwvkYzNQdVPFa4pStRKqqTFpump` | non | non | 0,458 | 0/4 | 0 |
| 9 | `5kf9JdCAQegYV9KwyKAXC3KBJw8D3TmHkFcMjQgWsUvT` | non | non | 7,590 | 0/5 | 0 |
| 10 | `J631kjwsBjXuDnyfLkpci264m4WdxX4cidDENcGxpump` | oui | non | 0,549 | 1/1 | 1 |
| 11 | `6SQp9YeWv2mhrG3wNNXwGhCFCjHTr5XFZr4rUimGfEBR` | non | non | <0,001 | 0/0 | 0 |
| 12 | `GVJBiAsnetzxoP6zhd2TqdaYvzsJ3azLoZLGbfiDpump` | non | non | 0,495 | 1/0 | 1 |
| 13 | `FNSjN5MeMc5TV8X7dm2ZeSRfbJVKeffg7j3mLupFpump` | non | non | 2,097 | 1/5 | 1 |
| 14 | `6pVwWtH7K4ReeR9NB7VunjXkahbXbXTnANsLAKSSpump` | non | non | <0,001 | 0/0 | 0 |
| 15 | `AoKcVQcMEPJ25cK24V4evdLwwUFTbwKCNMQYmDms32ww` | non | non | 0 | 0/0 | 0 |

Les candidats #1 et #9 avaient initialement plus de 7 SOL dans leur courbe, mais aucun BUY pendant la fenêtre et respectivement quatre et cinq SELL. Lors du nouveau contrôle, leurs réserves réelles n'étaient plus que **9** et **3 lamports**. Le #13 est passé de **2,097 SOL** à **0,594 SOL** environ. Le #6 était déjà sorti de sa courbe au contrôle initial ; la vente Pump.fun directe n'y était donc plus applicable. Le mode Mayhem des #7 et #10 les excluait du microtrade choisi.

De **17:50:49 à 17:52:49 UTC**, la surveillance supplémentaire n'a observé **aucun nouvel événement de trade sur ces 15 mints**. Elle s'est arrêtée au délai prévu, sans nouveau mint et sans transaction. Le RPC répondait encore : le slot finalisé a atteint `453006354` lors de la vérification finale, avec le hash de genèse Mainnet attendu.

## Frontend existant

Le projet contient une [console React/Vite](../../frontend/README.md) en lecture seule : radar des lancements, fiche token avec timeline/risque/social/détenteurs, positions **paper** et état de santé. Le radar peut afficher une progression des achats externes **paper** et la page des positions affiche un PnL **estimé**. Les aller-retours réels de cette session ont été exécutés par un script ponctuel hors du pipeline API ; leurs signatures, PnL réel et logs n'alimentent donc **pas** les vues actuelles. La console et l'API n'étaient pas démarrées localement sur `127.0.0.1:4173` et `127.0.0.1:3000` au contrôle. Le frontend ne charge aucun wallet et ne propose aucune action d'achat ou de vente.

## Preuves et état

Logs expurgés de la relance : [`sniff.jsonl`](evidence/2026-10-03-mainnet-microtrade-r3/sniff.jsonl), [`candidates.jsonl`](evidence/2026-10-03-mainnet-microtrade-r3/candidates.jsonl), [`activity.jsonl`](evidence/2026-10-03-mainnet-microtrade-r3/activity.jsonl), [`selection.jsonl`](evidence/2026-10-03-mainnet-microtrade-r3/selection.jsonl) et [`continued.jsonl`](evidence/2026-10-03-mainnet-microtrade-r3/continued.jsonl). Le [rapport du premier trade](mainnet-microtrade-2026-10-03.md) et le [rapport du deuxième trade](mainnet-microtrade-2026-10-03-relance.md) restent séparés de cette tentative sans ordre.

Les suffixes `TradeEvent` de 24 octets observés restent le résidu suivi par [#215](https://github.com/pivox/sol-token-listener/issues/215). Les gates du canary formel [#89](https://github.com/pivox/sol-token-listener/issues/89) n'ont pas été exécutés pendant cette relance. Aucun processus de trading autonome ne reste armé.

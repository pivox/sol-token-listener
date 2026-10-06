# Rebase opérateur des checkpoints — 2026-10-05

## Résultat courant

**Migration appliquée, deux checkpoints rebasés, observation bloquée au scanner.** Aucun ordre, fill, wallet, keyfile, signer ou chemin live n'a été lancé.

Les checkpoints lus en lecture seule juste avant les dry-runs étaient :

| Programme | Ancien slot | Ancienne signature | État |
|---|---:|---|---|
| launchpad | 488462493 | `NGYdaJtjAv6HgyxvoCoQsVikkSZpScYACGswqTnQirKR5X96ryThf1Ddg1ZkHN72T6sTqbXB3JK2SSzywsPPgmB` | supérieur au head finalized |
| market | 488472270 | `4YTv25hk4M819xNSBuQLubtZdnATJWczyh8n2bneR5zfMSqMpkvFEpfzrJknSgQLgUrs9skggtcMhpa44WCNtcKT` | supérieur au head finalized |

Avant migration, la connexion a été identifiée comme `solanabot` / rôle `solanabot` / schéma `public` sur `127.0.0.1:5432`. La comparaison exacte des fichiers SQL locaux à `migration_history` a établi que seul `021_processing_checkpoint_rebase_gaps.sql` était pendant. Aucun autre client PostgreSQL ni verrou advisory n'était présent. Le migrateur a retourné exactement `applied:["021_processing_checkpoint_rebase_gaps.sql"]`.

Après migration, les vérifications en lecture seule ont confirmé : la table existe, 021 est enregistrée une fois, les contraintes et index attendus existent, l'historique compte 53 entrées et aucune migration locale ne reste en attente. Les anciennes lignées présentes dans l'historique n'ont pas été modifiées. La table d'évidence était vide avant les rebases.

## Plans dry-run obtenus

Les premiers plans ci-dessous ont été produits avant l'autorisation et sont historiques ; ils n'ont pas été réutilisés.

| Programme | Nouveau slot | Nouvelle signature finalized | Head finalized échantillonné | Résultat |
|---|---:|---|---:|---|
| launchpad | 453619918 | `4WCDXrCN4XGmTHDLiAcGaVEHRvM8NBeA92Lf6NjEn1e8eHzQ6qJTEawWTHdFFJzkA6d7CyEqEtAcMobu1BnRGRrR` | 453619919 | dry-run |
| market | 453619925 | `55tcH1p3CWSFPZ2LSwYKAghbohdNzKNQARh98VdT1HJxobryJyURRGT7h23veWjZ9sqRfunBfotFS4otaqxN6EUa` | 453619925 | dry-run |

Après l'autorisation, les dry-runs ont été recalculés. Le genesis restait `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; les deux anciens checkpoints étaient toujours au-dessus du finalized head.

| Programme | Ancien slot / signature | Nouveau slot / signature appliqué | Head finalized au rebase |
|---|---|---|---:|
| launchpad | 488462493 / `NGYdaJtjAv6HgyxvoCoQsVikkSZpScYACGswqTnQirKR5X96ryThf1Ddg1ZkHN72T6sTqbXB3JK2SSzywsPPgmB` | 453623653 / `5fPkTBH4MqUdkRsih6ax2HBDdgBZEPzhgr8LjzQgSMTf4DhBnwHMQxQyB5WeBwmm4TAgAKXfp8yrpUyqp6EVdqmE` | 453623653 |
| market | 488472270 / `4YTv25hk4M819xNSBuQLubtZdnATJWczyh8n2bneR5zfMSqMpkvFEpfzrJknSgQLgUrs9skggtcMhpa44WCNtcKT` | 453623660 / `2JQLzWuExnDc92BvidZwj57ixw9xp8Ygety3j9pYWsF6mEFCS6a3r42aiksbbD4KX7HwuCgYPX3qdXpeAwBRtZWw` | 453623660 |

Les deux commandes confirmées ont retourné `APPLIED`. La relecture en base confirme une ligne par programme, sans doublon ; `previous_program` et `current_program` concordent, et le slot/signature nouveaux de l'évidence correspondent au checkpoint. Le motif est `invalid-future-checkpoint`. Les nouvelles signatures ont été obtenues par `getSignaturesForAddress` du programme respectif avec commitment finalized.

## Mécanisme ajouté

- `npm run listener:checkpoint:operator -- inspect` : lecture seule.
- `npm run listener:checkpoint:operator -- rebase --program launchpad --reason invalid-future-checkpoint` : dry-run seulement.
- Équivalent avec `--program market`.
- Une écriture requiert explicitement `--confirm-invalid-checkpoint-rebase`; elle est actuellement bloquée tant que la migration 021 n'est pas appliquée.
- L'écriture insère l'ancien état complet dans `processing_checkpoint_rebase_gaps` et met à jour le checkpoint sous le même verrou transactionnel que le scanner. Une seconde exécution est idempotente.

## Vérifications exécutées

- `node --import tsx --test tests/listener-checkpoint-operator.test.ts` sous environnement nettoyé : 6 réussis.
- `tests/listener-checkpoint-operator.postgres.test.ts` sur PostgreSQL 14 jetable, base `checkpoint_test` : 1 réussi, 0 ignoré.
- `npm run check:backend` : réussi.
- ESLint strict sur les fichiers TypeScript concernés : réussi.
- `git diff --check` sur les fichiers concernés : réussi.
- Migration sur la cible : exactement 021 appliquée, puis vérifications de schéma et historique réussies.
- Deux dry-runs actualisés et deux rebases confirmés ; vérifications post-rebase en lecture seule réussies.
- Observation demandée, bornée à 60 secondes : le processus a quitté après 4 secondes sur `scanner-scan`; aucune souscription WS ni réception d'événement n'est démontrée.

## Observation et blocage courant

L'observation a été lancée avec `LIVE_ENABLE=false`, `LIVE_KEYPAIR_FILE` vide, `EXECUTION_MODE=observe`, `PAPER_STRATEGY_ENABLED=false`, `POSTGRES_AUTO_MIGRATE=false`, `API_ENABLED=false`, `DASHBOARD_ENABLED=false`, dans un processus `env -i` qui ne charge que `live.env` et ces surcharges explicites. `listener.foundation_ready` a indiqué `transactionSubmissionEnabled=false`.

Le démarrage a échoué avec diagnostic nettoyé `stage=scanner-scan`, cause `CatchUpWindowExceededError`, code `CATCH_UP_WINDOW_EXCEEDED`. Le code du scanner ne produit cette erreur qu'après consommation de toutes les pages configurées sans trouver le couple exact slot/signature du checkpoint ni terminer sur une page courte. La configuration effective lue sans révéler d'autres variables était `pageSize=100`, `maxPages=20`; `LISTENER_CATCH_UP_POLICY` n'est pas consommée par le code local. La trace filtrée ne précise pas lequel des deux programmes a épuisé sa fenêtre. Aucune nouvelle tentative n'a été lancée.

Le heartbeat en base avait `updated_at=2026-09-12T19:39:12.490Z`; c'est une valeur ancienne, pas une preuve de l'observation. L'inbox ne contenait aucune entrée WebSocket après l'échec. Les checkpoints restent aux nouvelles valeurs ; aucun reset ni modification métier n'a eu lieu.

**Blocage avant canary :** il faut déterminer pourquoi le scanner de rattrapage n'a pas retrouvé son checkpoint récent dans ses 20 pages de 100 signatures. Ne pas augmenter la fenêtre ni refaire l'observation à l'aveugle ; identifier d'abord le programme concerné et comparer la vue RPC du scanner avec la signature/slot persistés. Aucun live ne doit être lancé tant que ce démarrage observe ne passe pas.

### Historique

Le diagnostic antérieur a établi que les checkpoints initiaux étaient environ 34,85 millions de slots au-delà du head finalized observé. Les références historiques sont conservées dans les rapports antérieurs ; ce rapport ne les modifie pas.

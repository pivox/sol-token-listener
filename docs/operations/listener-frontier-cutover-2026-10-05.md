# Validation du cutover par frontier de programme — 2026-10-05

## Changement

Après que le subscriber a reçu les ACK des deux abonnements, le bootstrap appelle `getSignaturesForAddress` avec `commitment=finalized` et `limit=1` pour chaque programme. La première signature finalized valide devient la frontier du programme concerné. Le catch-up et l’évidence de cutover utilisent cette signature et ce slot exacts; ils ne cherchent plus après coup une signature correspondant à un slot global antérieur.

Les abonnements restent actifs durant les deux lectures et la transaction de cutover. L’inbox continue de dédupliquer les notifications WS et celles du catch-up. L’application evidence + checkpoint reste atomique et protégée par le verrou transactionnel existant. Sans `--allow-recorded-live-edge-cutover`, le dépassement demeure une erreur. `maxPages=20` n’a pas changé. Le bootstrap est borné à trois scans (deux programmes, un cutover maximal chacun, puis scan final). Les diagnostics gardent l’erreur de fenêtre initiale si le cutover échoue.

## Vérifications hors ligne

- Unitaire ciblé : **56 réussis, 0 échoué, 0 ignoré** (`program-finalized-frontier`, bootstrap/cutover, catch-up, sécurité et diagnostics).
- PostgreSQL jetable : **2 réussis, 0 échoué, 0 ignoré** (`recorded-live-edge-cutover.postgres.test.ts`, `listener-checkpoint-operator.postgres.test.ts`). Vérifie evidence/checkpoint atomiques, durable et idempotents.
- `npm run check:backend` : réussi.
- ESLint ciblé sur les modules et tests modifiés avec `--max-warnings=0` : réussi.
- `git diff --check` ciblé : aucune anomalie signalée.

Le test de course simule les abonnements actifs, capture d’abord la frontier launchpad, 2 500 notifications WS avant la capture market, et la poursuite des notifications pendant le catch-up. Il constate deux frontiers distinctes, un cutover au plus par programme, inbox durable et reprise stricte sans nouveau cutover. Autres cas couverts : page finalized vide, erreur RPC, événement WS/catch-up dupliqué, erreur de cutover qui conserve la cause de catch-up, et redémarrage.

## Cible et séquence

Avant l’observation, une transaction PostgreSQL `READ ONLY` a confirmé : base `solanabot`, rôle `solanabot`, schéma `public`, serveur `127.0.0.1:5432`, PostgreSQL 14.18; migration `022_recorded_live_edge_cutover.sql` présente une fois; aucune autre session active. Les anciens checkpoints étaient launchpad `453623653` et market `453623660`; une preuve antérieure `invalid-future-checkpoint` par programme était encore présente. Aucun runtime concurrent n’a été trouvé.

Configuration effective observée sans afficher de credentials : cluster `mainnet-beta`, `EXECUTION_MODE=observe`, `LIVE_ENABLE=false`, keyfile vide, `PAPER_STRATEGY_ENABLED=false`, migrations/API/dashboard désactivés, `maxPages=20`, `pageSize=1000`.

Une seule observation a utilisé l’entrée applicative `src/app.ts --allow-recorded-live-edge-cutover`. Aucun keyfile, signer, live runner ni instruction d’envoi n’a été chargé par ce chemin. L’option d’observation autorisait uniquement le cutover documenté.

## Résultat observé

| Mesure | Résultat |
|---|---|
| `CUTOVER_LAUNCHPAD_APPLIED` | `true` |
| `CUTOVER_MARKET_APPLIED` | `true` |
| Frontier launchpad | slot `453662738` |
| Frontier market | slot `453662739` |
| Evidence launchpad | `4bd4dd93-fe4d-4ca4-8fb5-31f500ff25cc`, raison `operator-approved-live-edge-cutover` |
| Evidence market | `6ac03c36-33d6-4bee-b4b3-31b8757079fa`, raison `operator-approved-live-edge-cutover` |
| Checkpoint launchpad | `453623653 → 453662738` |
| Checkpoint market | `453623660 → 453662739` |
| `BOOTSTRAP_OK` | `true` — heartbeat indiquait `RUNNING` |
| `WS_LAUNCHPAD_SUBSCRIBED` | `true` — le subscriber passe à `RUNNING` seulement après les ACK des deux souscriptions |
| `WS_MARKET_SUBSCRIBED` | `true` — même preuve de contrôle |
| `WS_CONNECTED` | `true` — `subscriberState=RUNNING` |
| `WEBSOCKET_EVENTS_RECEIVED` | `67 052` callbacks reçus |
| `WEBSOCKET_ENQUEUES_COMPLETED` | `39 908` appels d’enqueue terminés avec succès |
| `WARMUP_SECONDS_OBSERVED` | `46` depuis le dernier cutover |
| `TRANSACTION_SUBMISSION` | `false` |
| `PROCESS_EXIT` | arrêt demandé par SIGINT; code 0; durée totale 57 s |
| `CATCH_UP_WINDOW_EXCEEDED` | aucun après cutover; aucun diagnostic `listener.start_failed` |

Les deux checkpoints finaux correspondent aux slots des frontiers propres à chaque programme. Les anciennes lignes `invalid-future-checkpoint` sont conservées; aucun rebase manuel, migration ou reset n’a été fait dans cette observation. Le nombre de callbacks inclut les notifications que le parser peut ensuite écarter; le compteur d’enqueue mesure des appels terminés, pas le nombre d’insertions inédites. L’inbox contenait 49 568 lignes WebSocket au total après l’observation, cumul qui ne doit pas être confondu avec les enqueues de cette session.

## Verdict

**READY_FOR_FINAL_PRECANARY_CHECK.** Le bootstrap, les deux abonnements, les frontiers finalized par programme, la continuité observée des enqueues et le warm-up minimal sont validés pour cette configuration sur cette cible. Ce résultat ne valide ni la rentabilité ni l’exécution de transactions. Le canary réel et toute commande `live:run` restent hors de cette opération et exigent une action séparée de l’utilisateur.

# Bootstrap listener — vérification et correction du 2026-10-05

## Diagnostic de la fenêtre

**A1 confirmé pour `launchpad`.** La vérification RPC read-only bornée déjà effectuée a lu 20 pages de 100 signatures (2 000 signatures), sans retry ni écriture. Slots observés : récent `453638930`, ancien de la page 20 `453638909`. Le checkpoint était `453623653`, soit sous le plus ancien slot retourné, et sa signature n'était pas présente. Les pages étaient pleines et ordonnées. Cela établit que le checkpoint se trouvait avant la fenêtre de 2 000 signatures ; ce n'est pas une preuve d'un mauvais couple signature/slot (A2).

Le scanner traite `launchpad` avant `market`; l'échec sur launchpad empêchait alors la seconde vérification. Les checkpoints au début de l'observation post-correction étaient toujours `453623653` et `453623660`. Aucun rebase ou changement de checkpoint n'a été effectué dans ce lot.

## Correction locale

- `SolanaListenerRuntime.performStart()` ouvre maintenant les abonnements avant le catch-up. Le scanner lit ensuite une frontier finalized fraîche et fixe dans le même démarrage. Le runtime ne lance pas ses workers et ne se déclare pas RUNNING si l'abonnement se dégrade pendant le rattrapage.
- Le raccord de l'accusé d'abonnement est isolé dans `Web3ProgramLogsConnection`. Il s'appuie sur `_onSubscriptionStateChange` de `@solana/web3.js` verrouillé en version `1.98.4`; l'abonnement doit atteindre `subscribed` pour les deux programmes dans un délai borné. Une déconnexion après l'accusé place le subscriber en DEGRADED.
- Le catch-up ignore, pour l'application et l'avancement du checkpoint, les lignes au-delà de la frontier capturée. Elles restent couvertes par le WebSocket déjà actif et la déduplication par signature de l'inbox PostgreSQL. Le checkpoint n'avance qu'après l'enqueue durable des éléments catch-up couverts.
- `LISTENER_CATCH_UP_MAX_PAGES` reste à `20`. La taille de page par défaut passe de `100` à `1000` (maximum déjà autorisé par le RPC), soit une fenêtre bornée de 20 000 signatures par programme. Aucun reset ni rebase automatique n'est ajouté.
- Une page courte qui n'atteint pas un checkpoint durable existant provoque maintenant `CATCH_UP_WINDOW_EXCEEDED` au lieu d'autoriser une avance non prouvée. Une page courte reste une fin valide lorsqu'il n'existe pas encore de checkpoint.
- Le heartbeat persiste dans son payload JSON des compteurs WebSocket (`websocketEventsReceived`, `websocketEnqueuesCompleted`) sans migration de schéma.

Limite explicite : un historique durable plus ancien que 20 000 signatures reste un dépassement borné et visible ; il ne sera ni sauté ni rebased par le bootstrap.

## Vérifications hors réseau

- Scénario bootstrap avec plus de 2 000 signatures entre le checkpoint durable et le démarrage : l'ancien scanner à 100 lignes/page échoue, la frontier fixe est rattrapée dans la limite de 20 pages et une observation post-frontier reçue via WebSocket ne fait pas avancer le checkpoint.
- Couverture également ajoutée pour overlap catch-up/WebSocket et idempotence par signature, crash partiel avant checkpoint puis reprise, perte WebSocket, erreur RPC sans progression, absence de progression si la page courte ne contient pas le checkpoint, timeout d'accusé WS, et refus de lancer les workers si WS se dégrade durant le catch-up.
- Tests ciblés exécutés : 101 réussis, 0 échoué. Suite additionnelle isolée exécutée sous `env -i` : 54 réussis, 0 échoué, 13 ignorés faute de `TEST_DATABASE_URL` (tests PostgreSQL de l'inbox ; aucune base cible n'a été utilisée).
- `npm run check:backend` : réussi. ESLint strict sur les fichiers touchés : réussi. Aucun test ne diffuse une transaction.

## Observation cible — une tentative, non validée

Une observation unique a été lancée avec les surcharges `LIVE_ENABLE=false`, `LIVE_KEYPAIR_FILE=""`, `EXECUTION_MODE=observe`, `PAPER_STRATEGY_ENABLED=false`, `POSTGRES_AUTO_MIGRATE=false`, `API_ENABLED=false`, `DASHBOARD_ENABLED=false`, dans un environnement `env -i` qui charge `live.env` explicitement. Aucun keyfile, signer ou chemin de soumission n'a été utilisé.

Résultat réellement conservé par le harnais :

```text
BOOTSTRAP_OK=false
WS_CONNECTED=NOT_PROVEN
EVENTS_RECEIVED=UNKNOWN
CHECKPOINTS_ADVANCED=none (launchpad 453623653→453623653; market 453623660→453623660)
TRANSACTION_SUBMISSION=false
process_exit=1 after ~7s
```

`listener.foundation_ready` a confirmé `executionMode=observe` et `transactionSubmissionEnabled=false`. Aucun heartbeat frais n'a été observé. La cause de l'arrêt n'est **pas déterminable à partir de cette tentative** : le wrapper de collecte cherchait `diagnostic`, alors que `listener.start_failed` émet le tableau `diagnostics`; il n'a donc pas conservé l'étape ni le code. Ce défaut de collecte est établi et ne permet pas de conclure que le bootstrap corrigé a échoué pour A1 ou pour une autre cause. L'observation n'a pas été répétée.

## Point de reprise

Le diagnostic historique A1 est confirmé et la correction locale est compilée et testée hors ligne. Le démarrage réel, l'accusé WebSocket et la réception réseau restent non validés. La prochaine action est une nouvelle observation seulement après autorisation distincte, avec un collecteur qui lit correctement `diagnostics[]` et n'imprime que les champs filtrés. Ne pas toucher aux checkpoints ; si le diagnostic confirme encore une fenêtre dépassée, rapporter son programme, sa frontier et ses bornes avant toute autre action.

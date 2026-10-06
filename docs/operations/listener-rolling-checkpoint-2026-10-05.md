# Rolling checkpoint durable — 2026-10-05

## Résultat

Le listener maintient désormais ses checkpoints par des sweeps finalized périodiques, au moyen du `CatchUpScanner`, de l’inbox PostgreSQL et du dépôt de checkpoint existants. Pour chaque passe, les deux frontiers programme sont capturées après le démarrage des WS; elles restent fixes pendant le scan. Le scanner enqueue avant d’écrire les checkpoints et l’inbox déduplique les notifications déjà reçues par WS. Il ne dérive jamais le checkpoint du slot maximal observé en WS.

La cadence configurable `LISTENER_ROLLING_CATCH_UP_INTERVAL_MS` est de 15 000 ms par défaut, validée entre 5 000 et 120 000. Elle est une période entre débuts de sweeps: la durée du sweep est retranchée du prochain délai; si elle dépasse la période, le sweep suivant démarre dès la fin du précédent. Un seul sweep global est actif à la fois, donc a fortiori une seule passe par programme. Les erreurs et l’état WS dégradé sont exposés dans `listener.rolling_catch_up_status` et placent le scanner en `DEGRADED`.

La justification de la période vient de la dernière observation: market a reçu 45 601 événements en 57 secondes, soit environ 12 000 signatures en 15 secondes, contre le plafond maintenu de 20 000 par programme et par sweep. Cette estimation laisse environ 8 000 signatures de marge au débit observé; elle ne prédit pas les pointes. Le nombre de requêtes attendu est approximativement le nombre de pages de chaque programme plus une lecture de frontier par programme, tous les 15 secondes. Aucun contrat de quota du fournisseur n’est disponible ici; les erreurs RPC ou 429 restent visibles et ne font pas avancer les checkpoints.

## Sûreté et reprise

- Échec d’enqueue ou de catch-up avant couverture complète: aucun checkpoint n’est avancé.
- Crash après enqueue mais avant checkpoint: le redémarrage rescane depuis le checkpoint durable; la contrainte d’idempotence de l’inbox empêche une seconde ligne logique.
- Événement post-frontier reçu par WS durant le scan: l’inbox le conserve; le sweep suivant le couvre à son tour.
- Erreur de WS avant, pendant ou après le scan: le passage échoue, état `DEGRADED`, pas de progression revendiquée.
- `live:run` reste bloqué contre les nouvelles entrées lorsque la couverture scanner/WS est dégradée; la gestion d’une position existante n’a pas été modifiée.
- Si un composant ultérieur échoue après le bootstrap, l’arrêt ferme le scanner et attend son sweep actif avant de fermer les producteurs.

## Tests exécutés

Commande:

```sh
env -i PATH="$PATH" HOME="$HOME" node --import tsx --test \
  tests/rolling-catch-up.test.ts \
  tests/live-decision-coverage-guard.test.ts \
  tests/listener-bootstrap.test.ts \
  tests/listener-bootstrap-cutover.test.ts \
  tests/catch-up-scanner.test.ts \
  tests/config-safety.test.ts \
  tests/listener-runtime.test.ts
```

Résultat: **86 réussis, 0 échoué, 0 ignoré**. `npm run check:backend`, ESLint ciblé des fichiers concernés et `git diff --check` passent. Les cas comprennent plus de 20 000 événements au total avec moins de 20 000 par fenêtre, déduplication WS/catch-up, replay après échec d’enqueue, redémarrage depuis un checkpoint stocké, erreur RPC, WS déconnecté, dépassement des 20 000, frontier fixe, absence de chevauchement, cadence contrôlée et fermeture du scheduler en rollback de démarrage.

Les fixtures de ce lot utilisent un dépôt durable en mémoire recréé entre les instances; elles vérifient l’ordre enqueue→checkpoint et l’idempotence du contrat. Elles ne constituent pas un nouvel essai PostgreSQL, lequel demeure couvert par les tests repository antérieurs et n’a pas été relancé contre une base cible.

Clés, RPC blockchain, wallet, transaction et base de production ne sont pas utilisés par ces fixtures.

## Validation cible

Les observations A (90 s) et B (nouveau processus, 30 s) n’ont pas été lancées. Le dernier diagnostic réel disponible montre le checkpoint launchpad `453662738` et une fenêtre de 20 000 signatures `453680526 → 453680409`, sans signature du checkpoint. Le bootstrap initial strict échoue donc avant d’activer le runtime rolling. Sans cutover, rebase, reset ou modification manuelle de checkpoint, tous exclus dans cette demande, A ne peut pas produire de nouveaux checkpoints durables et B ne peut pas démontrer le redémarrage demandé. Le diagnostic correspondant était `CATCH_UP_WINDOW_EXCEEDED`, `pageCount=20`, `signaturesRead=20000`.

Il n’y a donc pas de valeurs observation A/B à rapporter pour les checkpoints, sweeps, événements ou `transactionSubmission`. La cause bloquante unique est l’impossibilité du bootstrap strict depuis la borne launchpad durable actuelle dans la limite configurée, avec cutover explicitement interdit pour ce lot. Aucun nouvel essai réseau n’a été tenté.

## Fichiers concernés

- `src/application/production-listener-factory.ts`
- `src/application/catch-up-scanner.ts`
- `src/application/listener-runtime.ts`
- `src/config/env.ts`
- `.env.example`
- `docs/operations/live-config-model.md`
- `tests/rolling-catch-up.test.ts`
- `tests/live-decision-coverage-guard.test.ts`
- `tests/catch-up-scanner.test.ts`
- `tests/config-safety.test.ts`
- `tests/listener-runtime.test.ts`

Aucune règle de stratégie, valeur `maxPages=20`, position, commande live, checkpoint ou preuve historique n’a été modifiée.

# Admission séquentielle des hydratations de blocs

Version : 1.0.0 — 2026-09-19 — issue #127.

## Objectif

Garantir qu'une instance de `CachedSolanaBlockTransactionLocator` n'exécute
jamais plus d'un `getBlockTransactions` à la fois, tout en conservant le pacing
FIFO de 250 ms, le single-flight par clé et l'invalidation par epoch/génération.

## Portée

- rendre `Admission.start` asynchrone et attendre sa terminaison dans la pompe ;
- isoler l'échec d'une admission afin que la suivante puisse démarrer ;
- couvrir par tests déterministes la latence, l'erreur et le changement d'epoch ;
- mettre à jour la spécification du cache en version 1.1.0.

Sont hors portée : activation ou wiring runtime, configuration, factory,
classifier, lease, timeout RPC, annulation réseau et persistance.

## Invariant et ordre FIFO

À tout instant, `0 <= inFlightFetches <= 1`. Pour deux admissions A puis B :

```text
start(B) >= max(settle(A), start(A) + fetchIntervalMs)
```

Une jointure single-flight ne crée aucune admission. Un changement d'epoch ou
un `clear()` rejette les admissions anciennes encore en file mais ne peut pas
annuler l'appel SDK actif. Une admission fraîche attend donc la fin de cet appel,
puis l'ancienne réponse reste non retenable grâce à l'epoch et la génération.

## Démarche TDD

1. Ajouter un test rouge avec deux slots, premier fetch différé, et constater
   qu'un seul appel part avant sa résolution.
2. Ajouter un test rouge où le premier fetch échoue et vérifier que le second
   démarre ensuite sans chevauchement ni vidage global de la file.
3. Adapter le test d'epoch pour prouver qu'un fetch frais attend l'ancien appel
   non annulable et que l'ancienne réponse n'est pas retenue.
4. Attendre `Admission.start()` dans la pompe et garder les rejets individuels
   hors du chemin d'erreur global de la pompe.

## Vérification

- tests ciblés du cache, du locator et de la composition de production ;
- répétitions du test du cache pour détecter une course ;
- `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check` ;
- `git diff --check`.

## Risques assumés

La sérialisation réduit le débit à `min(4/s, 1/latence)` et introduit du
head-of-line blocking si le fournisseur tarde à répondre. Les métriques de file
existantes rendent cet effet observable. Un timeout ou une borne de file exige
une décision opérationnelle séparée et ne fait pas partie de #127.

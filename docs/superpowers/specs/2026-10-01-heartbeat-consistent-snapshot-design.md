# Snapshot cohérent du heartbeat

Version : 1.0.0 — correction #193, suivi capacité #120.

## Défaut reproduit

Le heartbeat collecte `counts()`, attend les slots RPC, puis collecte
`workerAdmissionMetrics()`. Une arrivée concurrente produit backlog=1 et
classificationPending=2 dans un même heartbeat. Le canary `735e236` présente
24 489 contre 24 492 à T+15 et reste légitimement INCONCLUSIVE sur ce gate.

## Correction

Le repository expose une collecte composée en transaction PostgreSQL
REPEATABLE READ READ ONLY. Les deux requêtes existantes utilisent le même
client et le même snapshot MVCC. La transaction finit avant toute attente RPC
du heartbeat. Aucun verrou métier ni écriture ne sont ajoutés.

La factory fournit ce snapshot au heartbeat pour RUNNING et STOPPED. Les
lectures indépendantes restent disponibles pour leurs consommateurs existants.
Un échec de collecte empêche la publication; aucun compteur n'est tronqué ou
remplacé par zéro. Les gates du canary et contrats JSON publics restent inchangés.

## Vérification

- Reproduire l'arrivée pendant getSlot avec la classe réelle; prouver la
  cohérence du snapshot utilisé et l'absence de lectures indépendantes.
- Vérifier le client partagé, l'isolation, commit, rollback et release.
- Vérifier sous PostgreSQL une insertion concurrente entre les deux lectures.
- Exécuter tests ciblés, check, lint et build avant revue (deux cycles maximum).

Ce correctif ne résout ni la croissance réelle du backlog, ni les layouts Pump
non décodés, ni le gate de profondeur de file d'hydratation.

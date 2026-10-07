# Checkpoint — chemin simple (arrêt 2026-10-06, panne PC opérateur)

Spec : `docs/superpowers/specs/2026-10-06-simple-path-design.md`.
Plan lot 1 : `docs/superpowers/plans/2026-10-06-simple-path-lot1-deletions.md`.

## Fait

- PR A (#237) **mergée** dans `main` (`95476a7`) : code mort, harnais paper MVP, spec + plan.
- Branche `refactor/remove-dossier` (worktree `.worktrees/reconcile`, poussée) :
  - B1 `749de67` creatorHasNotSold depuis les trades du mint (suite complète verte).
  - B2 `a582633` retrait social / graphe / analytics participants (suite verte hors flaky).
  - B4 `c47b19d` front sans onglets Social/Holders ; B5 `63e8c11` + `93b0c4a` docs.
  - B3 `7db3edb` API sans social/holders ni UNION state_transitions ; `93211c0` phrase REPORT_ONLY remise.
- Branche `refactor/remove-dossier-migration` (worktree `.worktrees/front`, poussée) : B6
  `e827dc3` migration 062 (DROP de 26-27 tables, sans CASCADE) + `ce23cee` droits retirés.
  Partie de `93b0c4a` : **pas encore réunie** avec B3.

## Lot 1 — terminé

- PR B (#238) **mergée** dans `main` (`4f18b88`) : B1-B5, migration 062, droits, smoke sans
  pipeline `social`. Déployer B2 et 062 ensemble. Reste : profil `pumpfun-v1-unvalidated` exige des
  signaux sociaux (paper → WATCHLISTED) ; `docs/api/v1.md` cite encore `participant_analytics` /
  `wallet_graph`.

## Lot 2 — terminé

PR #239 **mergée** (`ec8dbf2`) : scope `creates-only`, migration 063, `PUMPFUN_CURVE_TRADE`, poller
de bonding curves.

## Lot 3 — PR ouverte (branche `feat/fast-entry`)

Plan : `docs/superpowers/plans/2026-10-06-simple-path-lot3-fast-entry.md` (voir ses « Deviations »).
Fait : `ENTRY_MODE=off|fast` (fast exige `creates-only`), migration 064 (`entry_decisions`,
`execution_entry_envelopes` avancée depuis le lot 4, `FastEntryDecided`), règles pures, repository
(écriture BUY atomique : événement + intent `fast-entry-v1` TTL 30 s + décision), service appelé après
le pipeline observé (hors stage, erreurs journalisées), garde de fraîcheur 15 s, rétention des
décisions (7 j), droits listener (colonnes d'enveloppe en lecture seule) et rétention.

## Lot 4a — terminé (PR #TBD, branche `feat/envelope-auto-arm`)

Plan : `docs/superpowers/plans/2026-10-07-simple-path-lot4a-envelope-auto-arm.md` (voir « Deviations » et
« Amendments »). Runbook : `docs/operations/executor-live-canary.md`, section « Enveloppe d'entrée et auto-arm ».
Écarts :
- armement par un démon `live:auto-arm` (rôle operations), pas une lane H2b ;
- qualification `ENVELOPE` (24 h, payload version 2) ;
- découpage 4a / 4b ;
- la sortie à l'échéance utilise l'événement de décision du BUY (pas de `LiveExitDecided`) ;
- TTL des intents fast-entry 30 s -> 120 s ;
- perte réalisée = somme des pertes par position ;
- revoke n'est pas une sortie immédiate.

Correctifs de droits trouvés sur main et corrigés ici :
- rôle operations : `control_events`, `pair_memberships.pair_id`, `rate_limit_events.event_id`,
  `authorizations.payload_version`, `admission_reports.quota_state` ;
- rôle live : SELECT sur `execution_wallet_snapshots` (`snapshot_fingerprint`, `superseded_at`) et
  `execution_safety_gate_evidence` (`qualification_id`, `gate_index`, `gate_id`, `status`,
  `evidence_fingerprint`, `expires_at`) ; sans eux la signature BUY ne pouvait jamais tourner sous le rôle live.

Reste ouvert : le chemin v3 pairé n'a pas de droit operations sur `execution_preflight_intent_pairs`.

## Lot 4b — ouvert

Lane de sortie (vente par le créateur / take-profit / N acheteurs), `LiveExitDecided`, CLI `report`,
`market_pools` en creates-only.

## Prérequis du lot 5

- artefact gate 10, produit par le worker simulation-only avec auto-arm arrêté ;
- provider id ou clé dédié à l'exécuteur (point de sécurité 2) ;
- `maximum_holding_ms` <= 300 000 ;
- accord explicite de l'opérateur.

## Points ouverts pour le lot 4

- Lignage exécuteur : `EXECUTION_INTENT_CURRENT_LINEAGE_SQL` exige candidat paper +
  `PaperStrategySessionUpdated` ; à étendre pour `fast-entry-v1`.
- Enveloppe : CLI create/revoke/show, compteurs (`buys_armed` à l'armement, perte réalisée), colonnes
  `scope`/`envelope_id` de la qualification (065). Tant que la lane `arm` n'existe pas, ne pas activer
  `ENTRY_MODE=fast` avec un exécuteur live : chaque create accepté produit un intent PENDING.
- Les événements `FastEntryDecided` n'ont pas de `purge_after` (comme les événements paper) ; si on
  les purge un jour, garder la suppression de `domain_events` contre `execution_intents`.
- `creates-only` n'alimente pas `market_pools` : rien n'est suivi après migration (sortie lot 4).
- Avec l'admission bornée, un `create` aux logs ambigus est filtré `NOT_A_CREATE`.
- Charge RPC du poller de curves : 2-6 `getSignaturesForAddress` par curve et par cycle.

## Ensuite

- Lot 4b : lane de sortie, `LiveExitDecided`, CLI `report` (le 4a est fait, voir plus haut).
- Lot 5 : premier run réel (K = 1, enveloppe minimale) — accord explicite de l'opérateur requis.

## Environnement

- Postgres jetable Docker sur 127.0.0.1:55432 (`sol-token-listener-test`) ; jamais le 5432 natif.
- Aucun listener / RPC / achat réel lancé dans ce chantier.

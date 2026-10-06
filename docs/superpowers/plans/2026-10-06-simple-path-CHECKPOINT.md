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

## Lot 2 — PR ouverte (branche `feat/creates-only`)

Plan : `docs/superpowers/plans/2026-10-06-simple-path-lot2-creates-only.md`. Fait : scope
`creates-only` (filtre `NOT_A_CREATE`, scans stricts no-op, pin strict ignoré), migration 063,
indice `PUMPFUN_CURVE_TRADE` (ordre de claim TRADE < CURVE < POOL), poller réutilisé pour les
bonding curves (`PostgresTrackedCurveRepository`, PDA dérivée du mint, cap 20, positions live
d'abord). Suite complète verte (4052/4052 hors skips).

Points ouverts relevés en revue (à traiter dans les lots suivants si besoin) :
- En `creates-only`, `market_pools` n'est pas alimenté (programme PumpSwap non ingéré) : le poller
  de pools ne suit donc rien après migration. À régler avant le lot 4 (sortie après migration).
- Avec l'admission bornée activée, un `create` aux logs ambigus a l'indice NONE → filtré
  `NOT_A_CREATE` (perte acceptée par la spec).
- Charge RPC : 2-6 `getSignaturesForAddress` par curve et par cycle (≤ 20 curves / 10 s).

## Ensuite

- Lot 3 : entrée rapide, `entry_decisions`, `FastEntryDecided`, `ENTRY_MODE`, migration 064
  (voir la spec). Plan à écrire dans `docs/superpowers/plans/2026-10-06-simple-path-lot3-fast-entry.md`.
- Lots 4-5 : voir la spec.

## Environnement

- Postgres jetable Docker sur 127.0.0.1:55432 (`sol-token-listener-test`) ; jamais le 5432 natif.
- Aucun listener / RPC / achat réel lancé dans ce chantier.

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

## Reste à faire (lot 1)

1. `tests/config-safety.test.ts` test « Pump.fun calibration documentation states… » (~:1080-1120) :
   retirer les assertions sur la doc sociale supprimée (liste `CROSS_LINK_CONFIRMED`,
   `sans API payante`, regex `/NOT_AVAILABLE.*AVAILABLE.*COMPLETE.*PARTIAL.*FAILED/`). C'est le seul
   échec connu des tests ciblés de B3 (399/400).
2. Cherry-pick `e827dc3` et `ce23cee` sur `refactor/remove-dossier` (résoudre conflits éventuels).
3. Vérifier la suite complète de B6 (jamais confirmée après coupure de session) :
   `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test npm run test:backend`,
   puis `cd frontend && npm test && npx playwright test`.
4. PR B vers `main`. À noter dans la PR : B2 et 062 doivent être déployés ensemble (sinon FK des
   tables dossier bloquent la rétention) ; le profil par défaut `pumpfun-v1-unvalidated` exige des
   signaux sociaux que plus rien n'alimente (paper → WATCHLISTED ; le profil technique est inchangé).
5. CI verte, merge, `main` local à jour.

## Ensuite

- Lot 2 : plan à réécrire dans `docs/superpowers/plans/2026-10-06-simple-path-lot2-creates-only.md`
  (l'inventaire est fait ; résumé : scope `creates-only` = `launchpad-only` + filtre `NOT_A_CREATE`
  dans `ws-program-session.ts` + `runStrictScan` no-op dans la factory ; indice
  `PUMPFUN_CURVE_TRADE` calqué sur `PUMPSWAP_POOL_TRADE` + migration 063 ; poller de pools
  généralisé, instancié pour les bonding curves (adresse dans `TokenLaunchDetected`
  `payload.launch.parameters.bondingCurve`, graine `token_launches.created_signature/slot`).
- Lots 3-5 : voir la spec.

## Environnement

- Postgres jetable Docker sur 127.0.0.1:55432 (`sol-token-listener-test`) ; jamais le 5432 natif.
- Aucun listener / RPC / achat réel lancé dans ce chantier.

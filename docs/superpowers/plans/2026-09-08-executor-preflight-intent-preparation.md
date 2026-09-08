# Plan d'implémentation H2k-b — préparation d'intention de préflight

Spec : `docs/superpowers/specs/2026-09-08-executor-preflight-intent-preparation-design.md` v1.0.1

## Contraintes permanentes

- Une seule PR H2k-b, commits TDD séquentiels et fusionnables.
- Deux cycles de revue maximum.
- Aucun wallet, secret, armement, signature ou envoi.
- Toute preuve de succès vient d'un test frais ; PostgreSQL 16 utilise un
  conteneur tmpfs borné et supprimé après usage.

## Lot 1 — Autorité persistante (migration 042)

Fichiers prévus :

- `migrations/042_execution_preflight_intent_preparation.sql`
- `src/execution-migrations/live-catalog.ts`
- `tests/execution-preflight-intent-preparation-migration.test.ts`
- tests de migration qui épinglent encore le head 041

TDD : écrire d'abord les tests de forme, base vide, upgrade, rejeu,
contraintes, sélection concurrente sans substitution, lease, deadline et
crash/reprise. Implémenter ensuite la table, les guards et les fonctions
minimales. Mettre à jour le hash catalogue seulement après stabilisation.

## Lot 2 — Repository, watermark et claims exacts

Fichiers prévus :

- `src/domain/execution-preflight-preparation.ts`
- `src/ports/execution-preflight-preparation-repository.ts`
- `src/storage/execution-preflight-preparation.repository.ts`
- `src/storage/execution-intent.repository.ts`
- tests unitaires et PostgreSQL des repositories

TDD : valider les objets stricts et erreurs stables, puis prouver capture du
watermark DB, première paire exacte, claim TARGET dry-run, claim SIMULATION,
renouvellement et transitions terminales. Ajouter les anti-joins afin que les
claims génériques `DRY_RUN` et `EXECUTE` excluent toute membership appairée.

## Lot 3 — Orchestrateur one-shot

Fichiers prévus :

- `src/executor-preflight-preparation/config.ts`
- `src/executor-preflight-preparation/service.ts`
- `src/executor-preflight-preparation/main.ts`
- adaptation minimale des workers dry-run/simulation pour accepter un claim
  exact authentifié
- tests unitaires et d'intégration

TDD : couvrir le chemin nominal exact, aucune paire, perte de fence, deadline,
annulation, 429, mauvais genesis, simulation échouée, commit incertain et
reprise sans substitution. Le processus doit toujours s'arrêter après un état
terminal.

## Lot 4 — Manifeste redacted

Fichiers prévus :

- `src/executor-preflight-preparation/manifest.ts`
- tests filesystem dédiés

TDD : permissions `0600`, chemin absolu hors dépôt, création exclusive,
symlink refusé, écriture temporaire atomique, `fsync` fichier/dossier,
relecture finale, schéma exact et absence de champs interdits. Tester le
nettoyage après quatre heures sans effacer une sortie non authentifiée.

## Lot 5 — H2h/H2c versionnés

Fichiers prévus :

- `src/preflight-source/domain.ts`
- `src/preflight-source/repository.ts`
- `src/preflight-source/service.ts`
- contrats H2c concernés dans `src/execution-operations/`
- tests source/draft/opérations

TDD : ajouter les contrats v2 sans modifier le sens des archives v1. Prouver le
snapshot `REPEATABLE READ READ ONLY`, la lignée exacte, la cible pristine,
l'unique tentative du sibling, l'artefact frais, la finalité causale et la
marge de cinq secondes. Une cible appairée doit être refusée par H2c v1.

## Lot 6 — Rôles, déploiement, rétention et documentation

Fichiers prévus :

- `scripts/provision-executor-roles.sql`
- `scripts/deployment-smoke.mjs`
- `src/storage/database.ts`
- validateurs de migration head et tests de contrats
- README/opérations si nécessaire

TDD : reconstruire les rôles sur PostgreSQL 16, vérifier les droits colonnes et
fonctions exacts, l'absence de capacité live/signante, la rétention ordonnée et
le head 042. Mettre à jour tous les contrats de déploiement épinglés.

## Vérification et livraison

1. tests ciblés à chaque lot ;
2. `npm run build` ;
3. `npm run check` ;
4. `npm run lint` ;
5. `npm test` ;
6. migrations et rôles sur PostgreSQL 16 tmpfs ;
7. cycle de revue 1, corrections et vérification ;
8. cycle de revue 2 au maximum, corrections bloquantes, CI verte ;
9. fusion de H2k-b uniquement sans wallet ni opération live.

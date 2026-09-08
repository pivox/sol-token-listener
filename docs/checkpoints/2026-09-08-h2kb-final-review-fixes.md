# Checkpoint H2k-b — corrections de revue finale

**Date UTC :** 2026-09-08T13:17:51Z
**Worktree :** `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/issue-51h2k-preparation`  
**Branche :** `feat/issue-51h2k-preparation`  
**Base :** `origin/main` à `bc4c470`  
**État Git :** 16 commits d'avance, corrections CI finales prêtes au commit
**Canary :** `CANARY_NOT_STARTED`

## Invariants de sécurité

- H2k-b reste sans wallet, clé privée, signature, armement ou soumission.
- Ne pas lire ni convertir le wallet avant les gates et le checkpoint humain final frais.
- Un `go` générique n'est pas une autorisation transactionnelle.
- Les deux cycles de revue autorisés pour cette PR sont consommés : ne pas demander une troisième revue.

## Corrections implémentées après la seconde revue

1. H2c verrouille dans l'ordre paire puis cible, verrouille les preuves causales et
   réévalue la lineage immédiatement avant `live_reserved=true`.
2. H2c relit `trading_candidates.eligible_until` et `purge_after` et les lie à
   l'expiration de la preuve H2h.
3. H2k-b valide TARGET et SIMULATION sous verrous à la sélection puis avant
   `PREPARED`; une dérive terminalise le même run avec
   `PREFLIGHT_PAIR_LINEAGE_INVALID` sans substitution.
4. La construction du draft refuse désormais le gate RPC sauf décision
   `evaluateProviderQuota(...).state === 'NORMAL'`.
5. La rétention supprime les runs PREPARED/FAILED purgeables avant leurs preuves
   et exclut de la cohorte toute paire ayant un run encore retenu.
6. La migration 043 vérifie les colonnes locales/référencées, `ON UPDATE`,
   `ON DELETE`, `MATCH`, la déferrabilité et l'état `NOT VALID` de chaque FK.
7. L'expiration de la source H2h est bornée par `candidate.eligible_until` et
   `candidate.purge_after`.

## Diagnostic résolu

Les fixtures H2c fabriquaient leurs qualifications avec `Date.now()`, parfois
exactement 1 ms devant `statement_timestamp()` lors du contrôle PostgreSQL. Le
runtime échouait correctement fermé avec `PREFLIGHT_EXPIRED`; la fixture a été
alignée sur l'horloge de la base sans relâcher le garde-fou produit. Les contrats
d'autorité ont aussi été alignés sur `execution_intents.candidate_id`, et le rôle
de rétention a reçu uniquement `SELECT`/`DELETE` sur les runs de préparation.
Il ne peut toujours pas lire `signed_transaction_bytes`.

## Validations finales fraîches

- `npm run build` : succès backend et frontend.
- `npm run check` : succès backend et frontend.
- `npm run lint` : succès backend et frontend, zéro warning.
- `npm run docs:check` : 16 sections, 8 SVG et 28 références validées.
- `git diff --check` : succès.
- Backend sans base : 2 841 tests, 2 414 réussis, 427 intégrations PostgreSQL
  explicitement ignorées, zéro échec.
- Frontend : 17 fichiers et 145 tests réussis.
- H2k-b/migrations/rétention/rôles sur PostgreSQL 16 : 41/41.
- H2c sur PostgreSQL 16 : deux passages séquentiels à 20/20.
- Base PostgreSQL vide : 43 migrations appliquées jusqu'à
  `043_execution_intent_causal_lineage.sql`; base jetable ensuite supprimée.
- `npm run deployment:smoke` : succès Docker complet après alignement du
  compteur canonique `executionPreflightPreparationRuns`; ressources nettoyées.
- `npm audit --omit=dev` : 15 alertes transitives (7 modérées, 8 hautes) dans
  les SDK Solana/Pump. Les corrections proposées imposent des downgrades
  cassants ; elles restent une dette de sécurité séparée, sans `--force` dans
  H2k-b.

## Corrections après la première exécution CI de la PR #88

- La migration 043 impose correctement les FK `decision_event_id` et
  `candidate_id`. Les anciennes fixtures d'exécution créent désormais leur
  événement de décision exact avant l'intention ; la contrainte produit n'a pas
  été affaiblie.
- La relecture d'une intention SELL de deadline inclut explicitement la clé
  nullable `candidateId` introduite dans le contrat de domaine. Le contexte
  relu est comparé au draft avant toute poursuite.
- La fixture d'autorité listener utilise une lineage canonique complète pour la
  paire H2c, tout en démontrant que le rôle reste privé de tout état live.
- Groupe initialement fautif en CI : 136/136 tests PostgreSQL réussis en
  séquentiel.
- `execution-live.repository` : 38/38 réussis ; préparation transactionnelle :
  15/15 réussis ; autorité listener : 2/2 réussis.
- Une passe exhaustive locale parallèle a saturé PostgreSQL et fait expirer des
  fixtures temporaires ainsi qu'un délai d'observation de verrou. Tous ces
  scénarios passent isolément ; le verdict final est confié à la CI propre après
  push.

## Reprise recommandée

1. Commit unique des corrections finales, push, attendre la CI, puis fusionner
   H2k-b si tout est vert, sans troisième cycle de revue.
2. Reprendre ensuite l'attestation H2h fraîche et le préflight H2c ; toujours sans
   charger le wallet avant le checkpoint final.

## Environnement temporaire de test

- Conteneur : `stl-h2kb-pg16-042` (PostgreSQL 16, encore actif au checkpoint).
- DB H2k-b :
  `postgresql://postgres:h2kb_test_only@127.0.0.1:55442/sol_token_listener_h2kb`
- DB H2c :
  `postgresql://postgres:h2kb_test_only@127.0.0.1:55442/sol_token_listener_h2c_v3`
- Ne supprimer que ce conteneur temporaire exact une fois les validations finies.

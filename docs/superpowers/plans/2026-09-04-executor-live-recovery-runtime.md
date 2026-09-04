# Executor Live Read-Only Finality Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer #51-H2a comme runtime séparé de confirmation, réconciliation finalized et création de sorties à échéance, structurellement incapable de charger un secret, signer ou soumettre.

**Architecture:** Un bootstrap fermé valide configuration, PostgreSQL, catalogue de migrations, bindings et genesis, puis compose trois lanes sur les claims/read-models H1 et un gateway Solana HTTP strictement read-only. Le runtime traite une unité par passe, journalise des résultats redacted et s'arrête de façon bornée. H2b conserve toute autorité signable.

**Tech Stack:** TypeScript strict ESM, Node.js 22, PostgreSQL, Solana JSON-RPC HTTP, `node:test`, `bigint`, logs Pino structurés.

**Normative design:** `docs/superpowers/specs/2026-09-04-executor-live-recovery-runtime-design.md` version 1.0.2, parent version 1.8.1, H1 version 1.0.6.

---

### Task 1: Versionner la frontière H2a

**Status:** in progress

**Files:**
- Create: `docs/superpowers/specs/2026-09-04-executor-live-recovery-runtime-design.md`
- Create: `docs/superpowers/plans/2026-09-04-executor-live-recovery-runtime.md`
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`
- Modify: `docs/superpowers/specs/2026-09-01-executor-live-orchestration-design.md`
- Modify: `docs/operations/executor-live-canary.md`

- [ ] Décrire les options étudiées, invariants, configuration, RPC autorisés,
  lanes, arrêt et non-objectifs.
- [ ] Versionner les spécifications parentes sans réécrire leur historique.
- [ ] Faire échouer les tests documentaires qui attendent encore l'ancien état,
  puis les mettre en cohérence.
- [ ] Committer la documentation seule.

### Task 2: Valider le démarrage sans autorité live

**Status:** pending

**Files:**
- Create: `src/executor-live-recovery/config.ts`
- Create: `src/executor-live-recovery/startup-validator.ts`
- Create: `tests/executor-live-recovery-config.test.ts`
- Create: `tests/executor-live-recovery-startup.test.ts`

- [ ] Écrire les tests RED pour configuration exacte, bornes et noms de secret
  interdits.
- [ ] Implémenter le parser immuable et les erreurs typées.
- [ ] Écrire les tests PostgreSQL RED pour rôle, head/catalogue migrations et
  bindings ouverts.
- [ ] Implémenter les validations read-only dans l'ordre normatif.
- [ ] Exécuter les tests ciblés sur PostgreSQL réel puis committer.

### Task 3: Implémenter le gateway RPC read-only borné

**Status:** pending

**Files:**
- Create: `src/executor-live-recovery/rpc-gateway.ts`
- Create: `tests/executor-live-recovery-rpc.test.ts`

- [ ] Écrire un faux serveur JSON-RPC local couvrant genesis, statut,
  transaction finalized, hauteurs et deltas.
- [ ] Tester timeout, abort, 429, taille, identifiant, types et réponses
  divergentes avant l'implémentation.
- [ ] Implémenter uniquement les ports de lecture étroits et les budgets.
- [ ] Prouver que les entiers financiers restent des `bigint` puis committer.

### Task 4: Composer les lanes H1

**Status:** pending

**Files:**
- Create: `src/executor-live-recovery/lanes.ts`
- Create: `tests/executor-live-recovery-lanes.test.ts`

- [ ] Tester RED claims `RECONCILE`/`CONFIRM`, read-models, provider affinity,
  renouvellement et perte de lease.
- [ ] Composer réconciliation et confirmation sur les workers existants.
- [ ] Composer le scanner deadline sans réclamer le SELL créé.
- [ ] Tester une seule unité et ordre strict puis committer.

### Task 5: Publier le runtime et l'entrypoint séparés

**Status:** pending

**Files:**
- Create: `src/executor-live-recovery/runtime.ts`
- Create: `src/executor-live-recovery/main.ts`
- Create: `src/executor-live-recovery/logger.ts`
- Create: `tests/executor-live-recovery-runtime.test.ts`
- Create: `tests/executor-live-recovery-main.integration.test.ts`
- Modify: `package.json`

- [ ] Tester RED ordre de bootstrap, logs redacted, SIGINT/SIGTERM et timeout
  d'arrêt.
- [ ] Implémenter la boucle et la composition réelle sans importer le graphe
  signable.
- [ ] Publier `executor:live:recovery:start` et son équivalent de développement.
- [ ] Tester source et `dist` contre signer, secrets et soumission puis committer.

### Task 6: Vérifier et livrer H2a

**Status:** pending

**Files:**
- Modify: tests/documentation only as justified by verification evidence

- [ ] Exécuter build, check, lint, docs, suites backend/frontend, migrations sur
  base vide et replay, et smoke de déploiement.
- [ ] Faire une revue locale de sécurité et corriger les constats.
- [ ] Pousser la branche, ouvrir une PR liée à #51 et demander au plus trois
  cycles de revue GitHub.
- [ ] Fusionner seulement avec checks verts et aucune discussion bloquante.
- [ ] Conserver `CANARY_NOT_STARTED`; ne jamais armer ou appeler Mainnet.

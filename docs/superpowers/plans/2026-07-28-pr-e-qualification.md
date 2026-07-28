# PR E Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une qualification Pump.fun V1 configurable, explicable et sans effet de bord.

**Architecture:** Un module de domaine définit le rapport, les signaux et le
ruleset. Un moteur pur valide sa configuration, attribue les points et rend un
verdict ; il ne dépend ni du RPC, ni de PostgreSQL, ni du paper trading.

**Tech Stack:** TypeScript strict ESM, `node:test`.

---

### Task 1: Contrats de qualification

**Files:**

- Create: `src/domain/qualification.ts`
- Test: `tests/qualification.test.ts`

- [ ] Écrire un test rouge montrant trois scores et un verdict qualifié avec
  un score total de 60.
- [ ] Exécuter `npx tsx --test tests/qualification.test.ts` et constater
  l’échec pour module absent.
- [ ] Définir les contrats immuables : ruleset, signaux, preuves, scores,
  blockers, verdict et rapport.
- [ ] Relancer le test, puis committer `feat: define qualification contracts`.

### Task 2: Moteur de score et verdict

**Files:**

- Create: `src/qualification/qualification-engine.ts`
- Modify: `tests/qualification.test.ts`

- [ ] Écrire des tests rouges pour un blocker (`REJECTED`) et des preuves
  obligatoires manquantes (`WATCHLISTED`).
- [ ] Implémenter `QualificationEngine.evaluate` : validation entière des
  poids, déduplication/validation des reason codes, attribution des points,
  gel profond du rapport et règle `REJECTED > WATCHLISTED > QUALIFIED`.
- [ ] Exécuter le test ciblé puis committer
  `feat: evaluate explainable qualification reports`.

### Task 3: Seuil configurable et régression

**Files:**

- Modify: `src/config/env.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`

- [ ] Écrire un test rouge couvrant `QUALIFICATION_MIN_SCORE=60` et le rejet
  de `101`.
- [ ] Ajouter `qualificationMinimumScore`, borné entre 0 et 100, puis le
  relier au ruleset V1 sans déclencher de paper trading.
- [ ] Documenter le statut non calibré du seuil.
- [ ] Exécuter `npm test && npm run build && npm run check && npm run lint && git diff --check`.
- [ ] Committer `feat: configure Pump.fun qualification threshold`.

# Compiled Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package every versioned PostgreSQL migration with the compiled application so production auto-migration works.

**Architecture:** A focused build helper copies canonical SQL migration files into `dist/migrations`. The existing runtime migration resolver remains unchanged and therefore reads only packaged artifacts when started from `dist`.

**Tech Stack:** TypeScript strict, Node.js filesystem APIs, Node test runner, PostgreSQL, npm scripts.

---

### Task 1: Prove the missing build artifact

**Files:**
- Create: `tests/copy-migrations.test.ts`
- Create: `scripts/copy-migrations.ts`
- Modify: `package.json`

- [ ] Write a test that imports `copyMigrationArtifacts`, copies canonical SQL from isolated source and target directories, and asserts sorted names plus exact bytes.
- [ ] Add a test that reads `package.json` and requires the build script to invoke `scripts/copy-migrations.ts`.
- [ ] Run `npx tsx --test tests/copy-migrations.test.ts` and verify it fails because the helper is absent.
- [ ] Implement the helper with `readdir`, `rm`, `mkdir` and `copyFile`, rejecting an empty canonical source.
- [ ] Append the helper to `npm run build` and rerun the focused test to green.

### Task 2: Verify the compiled production path

**Files:**
- Modify only files required by a verified failure.

- [ ] Run `npm run build` and assert the canonical source and `dist/migrations` filename lists and file hashes are identical.
- [ ] Create a uniquely named empty PostgreSQL schema and apply migrations through `dist/src/storage/database.js`.
- [ ] Assert migrations `001` through `010` were applied and a second call applies none.
- [ ] Drop only the isolated verification schema.
- [ ] Run `npm run check`, `npm run lint`, `TEST_DATABASE_URL=postgresql:///postgres npm test`, `npm run docs:check`, and `git diff --check`.
- [ ] Commit and push the verified correction to `main`.


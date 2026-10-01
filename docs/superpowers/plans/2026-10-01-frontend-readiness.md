# Frontend Readiness Implementation Plan

> Execute inline with executing-plans; keep the dirty root checkout intact.

**Goal:** Make Compose await actual frontend HTTP availability.
**Architecture:** Bounded local static HTTP healthcheck; existing backend and
public API assertions remain independent and unchanged.
**Tech Stack:** Docker Compose, pinned unprivileged nginx, Node TypeScript tests.

## Task 1 — RED contract

- [x] Append this test to `tests/deployment-artifacts.test.ts`:

```ts
void test('frontend readiness waits for local HTTP without weakening backend checks', async () => {
  const frontend = composeService(await readArtifact('deploy/compose.yaml'), 'frontend');
  for (const line of [
    '    healthcheck:',
    '      test: ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/index.html"]',
    '      interval: 2s', '      timeout: 3s', '      retries: 30', '      start_period: 10s',
  ]) assert.ok(frontend.includes(line), `Missing frontend readiness line: ${line}`);
});
```

- [x] Run `npx tsx --test --test-name-pattern='frontend readiness' tests/deployment-artifacts.test.ts`; observed missing healthcheck failure.

## Task 2 — GREEN configuration

- [x] Add the following under frontend in `deploy/compose.yaml`:

```yaml
    healthcheck:
      test: ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/index.html"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 10s
```

- [x] Run the same focused test, then the full deployment-artifacts test file;
  expect pass. Run `npm run check:backend`, `npm run lint:backend`, `npm run docs:check`.
- [x] Record controlled Docker delayed-start and never-ready evidence; destroy
  only owned temporary resources. No Mainnet calls.
- Evidence: pinned nginx with 8-second delay, no healthcheck returns running then
  UND_ERR_SOCKET; healthcheck returns healthy then HTTP200. Delay30s/wait3s
  fails in3.21s before public assertions. Owned container cleanup verified.
- Artifact tests44/44 and backend check/lint/docs pass. Full local smoke passes,
  owned project cleanup verified. Local review cycle1 has no blocking finding.
- [ ] Commit spec, plan, test and configuration. Local review cycle 1, PR and
  final GitHub cycle 2; wait for green deployment smoke before merging.

# Frontend HTTP readiness

Version 1.0.1 — issue #199.

## Evidence

Main smoke 36916558676 fails at PUBLIC_HEALTH / HTTP_HEADERS / UND_ERR_SOCKET.
The frontend has no healthcheck: Compose `up --wait` accepts its running state
before nginx serves HTTP. A bounded local reproduction with the pinned nginx
image and delayed startup reproduces this exact transport error after `--wait`.
The same container answers HTTP 200 once startup finishes. This demonstrates
the race mechanism, not a retrospective trace of the failed CI container.

## Decision

Add a frontend Compose healthcheck for local `/index.html`, using the existing
image's wget: `wget -q -T 2 -O /dev/null http://127.0.0.1:8080/index.html`.
Use exec form, interval 2s, timeout 3s, retries 30, start period 10s. The existing
120-second smoke startup deadline remains unchanged. Canonical forward rollout
and rollback both use `--wait --wait-timeout 60` for frontend, so the readiness
contract also applies outside the smoke. A service that cannot
serve its static entrypoint must not be considered ready.

This checks nginx/static availability, not backend health, token qualification
or trading readiness. Keep the app healthcheck and exact public health, CORS,
frontend and SSE assertions unchanged. Add no generic fetch retry or sleep.
No application, database, RPC, wallet, image-version or canary-gate change.

Alternative: polling public health in the smoke only would leave normal
deployment startup without this readiness contract. Explicit Compose readiness
is the recommended narrow fix under the user's standing approval.

## Verification

First add a failing deployment-artifact contract test, then add the healthcheck.
Run artifact tests and static checks. Prove delayed startup waits for healthy
with a single bounded local container, and prove never-ready startup fails.
Run full deployment smoke in CI; maximum two review cycles.

## Primary references

- https://docs.docker.com/reference/cli/docker/compose/up/
- https://docs.docker.com/compose/how-tos/startup-order/

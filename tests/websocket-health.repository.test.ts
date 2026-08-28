import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import {
  MAX_WEBSOCKET_HEALTH_GENERATION,
  MAX_WEBSOCKET_HEALTH_SLOT,
  type WebSocketHealthSnapshot,
} from '../src/domain/websocket-health.js';
import type { WebSocketHealthTransition } from '../src/ports/websocket-health-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresWebSocketHealthRepository,
  WebSocketHealthRepositoryError,
  type WebSocketHealthPool,
} from '../src/storage/websocket-health.repository.js';

void test('websocket health repository reads the inactive foundation and begins owner generation one on the database clock', async (context) => {
  await withRepository(context, 'websocket_health_owner', async ({ pool, repository }) => {
    const inactive = await repository.read();
    assert.equal(Object.isFrozen(inactive), true);
    assert.deepEqual(inactive, inactiveSnapshot(inactive.updatedAtMs));

    const before = await databaseNowMs(pool);
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const after = await databaseNowMs(pool);
    assert.equal(started.supervision, 'ACTIVE');
    assert.equal(started.ownerGeneration, 1n);
    assert.equal(started.revision, 1n);
    assert.equal(started.phase, 'CONNECTING');
    assert.equal(started.candidateProviderId, 'primary');
    assert.equal(started.candidateSessionGeneration, 1n);
    assert.equal(started.providerId, null);
    assert.equal(started.activeSessionGeneration, null);
    assert.deepEqual(started.recovery, {
      status: 'NOT_REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null,
    });
    assert.equal(started.updatedAtMs, started.heartbeatAtMs);
    assert.ok(started.updatedAtMs >= before && started.updatedAtMs <= after);

    const raw = await rawCanonicalRow(pool);
    assert.equal(raw.updated_at_ms, raw.heartbeat_at_ms);
    assert.equal(raw.acknowledged_at_ms, null);
  });
});

void test('websocket health repository restarts clean STOPPED and rejects a fresh active owner without mutation', async (context) => {
  await withRepository(context, 'websocket_health_restart', async ({ repository }) => {
    const first = await repository.beginOwner({ candidateProviderId: 'primary' });
    const beforeConflict = await repository.read();
    await expectCode(repository.beginOwner({ candidateProviderId: 'fallback-1' }), 'ACTIVE_INSTANCE');
    assert.deepEqual(await repository.read(), beforeConflict);

    const stopped = await repository.transition(transitionFrom(first, {
      phase: 'STOPPED',
      candidateProviderId: null,
      candidateSessionGeneration: null,
      recoveryStatus: 'NOT_REQUIRED',
      recoveryReasonCode: null,
    }));
    const restarted = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
    assert.equal(restarted.ownerGeneration, 2n);
    assert.equal(restarted.revision, stopped.revision + 1n);
    assert.equal(restarted.candidateSessionGeneration, 2n);
    assert.equal(restarted.candidateProviderId, 'fallback-1');
    assert.equal(restarted.phase, 'CONNECTING');
  });
});

void test('websocket health repository schedules stopped evidence retention unless recovery is unresolved', async (context) => {
  await withRepository(context, 'websocket_health_stopped_retention', async ({ repository }) => {
    const connecting = await repository.beginOwner({ candidateProviderId: 'primary' });
    assert.equal(await repository.recordObservation({
      ownerGeneration: connecting.ownerGeneration,
      sessionGeneration: requiredValue(connecting.candidateSessionGeneration),
      slot: 77n,
    }), 'RECORDED');

    const stopped = await repository.transition(transitionFrom(await repository.read(), {
      phase: 'STOPPED',
      candidateProviderId: null,
      candidateSessionGeneration: null,
      recoveryStatus: 'NOT_REQUIRED',
      recoveryReasonCode: null,
    }));
    assert.equal(stopped.lastObservation?.slot, 77n);
    assert.equal(
      requiredValue(stopped.evidencePurgeAfterMs) - stopped.updatedAtMs,
      4 * 60 * 60 * 1_000,
    );

    const restarted = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
    const unresolved = await repository.transition(transitionFrom(restarted, {
      phase: 'STOPPED',
      candidateProviderId: null,
      candidateSessionGeneration: null,
      disconnectReasonCode: 'CLEANUP_FAILED',
      recoveryStatus: 'FAILED',
      recoveryReasonCode: 'SESSION_FAILURE',
    }));
    assert.equal(unresolved.recovery.status, 'FAILED');
    assert.equal(unresolved.evidencePurgeAfterMs, null);
  });
});

void test('websocket health repository replaces stale active ownership and preserves its diagnostic watermark', async (context) => {
  await withRepository(context, 'websocket_health_stale', async ({ pool, repository }) => {
    const connecting = await repository.beginOwner({ candidateProviderId: 'primary' });
    assert.equal(await repository.recordObservation({
      ownerGeneration: connecting.ownerGeneration,
      sessionGeneration: requiredValue(connecting.candidateSessionGeneration),
      slot: 123n,
    }), 'RECORDED');
    const observed = await repository.read();
    const restartBefore = await databaseNowMs(pool);
    const running = await repository.transition(transitionFrom(await repository.read(), {
      phase: 'RUNNING',
      providerId: 'primary',
      activeSessionGeneration: connecting.candidateSessionGeneration,
      candidateProviderId: null,
      candidateSessionGeneration: null,
      acknowledged: true,
    }));
    await pool.query(`UPDATE listener_websocket_health
      SET heartbeat_at = clock_timestamp() - INTERVAL '31 seconds'
      WHERE service_key = 'transaction-listener'`);

    const restarted = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
    const restartAfter = await databaseNowMs(pool);
    assert.equal(restarted.ownerGeneration, running.ownerGeneration + 1n);
    assert.equal(restarted.revision, running.revision + 1n);
    assert.equal(restarted.phase, 'CONNECTING');
    assert.equal(restarted.candidateSessionGeneration, 2n);
    assert.equal(restarted.candidateProviderId, 'fallback-1');
    assert.equal(restarted.activeSessionGeneration, null);
    assert.equal(restarted.providerId, null);
    assert.equal(restarted.acknowledgedAtMs, null);
    assert.deepEqual(restarted.lastObservation, observed.lastObservation);
    assert.deepEqual(restarted.disconnect, {
      occurredAtMs: restarted.disconnect?.occurredAtMs,
      reasonCode: 'UNEXPECTED_RESTART',
    });
    assert.deepEqual(restarted.recovery, {
      status: 'REQUIRED', startedAtMs: null, completedAtMs: null,
      reasonCode: 'UNEXPECTED_RESTART',
    });
    const restartDisconnect = requiredValue(restarted.disconnect);
    assert.ok(restartDisconnect.occurredAtMs >= restartBefore
      && restartDisconnect.occurredAtMs <= restartAfter);
    assert.equal(restarted.updatedAtMs, restarted.heartbeatAtMs);
    assert.equal(restarted.updatedAtMs, restarted.disconnect?.occurredAtMs);
  });
});

void test('websocket health repository retries an UNRECOVERABLE predecessor through strict recovery even when fresh', async (context) => {
  await withRepository(context, 'websocket_health_unrecoverable', async ({ repository }) => {
    const first = await repository.beginOwner({ candidateProviderId: 'primary' });
    const unrecoverable = await repository.transition(transitionFrom(first, {
      phase: 'UNRECOVERABLE',
      candidateProviderId: null,
      candidateSessionGeneration: null,
      recoveryStatus: 'FAILED',
      recoveryReasonCode: 'CATCH_UP_WINDOW_EXCEEDED',
    }));
    assert.equal(unrecoverable.recovery.status, 'FAILED');

    const retried = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
    assert.equal(retried.ownerGeneration, 2n);
    assert.equal(retried.phase, 'CONNECTING');
    assert.deepEqual(retried.recovery, {
      status: 'REQUIRED', startedAtMs: null, completedAtMs: null,
      reasonCode: 'CATCH_UP_WINDOW_EXCEEDED',
    });
  });
});

void test('websocket health repository rejects fresh cleanup failure then restarts it as stale and abnormal', async (context) => {
  await withRepository(context, 'websocket_health_cleanup_restart', async ({ pool, repository }) => {
    const first = await repository.beginOwner({ candidateProviderId: 'primary' });
    const cleanupFailed = await repository.transition(transitionFrom(first, {
      phase: 'DEGRADED',
      disconnectReasonCode: 'CLEANUP_FAILED',
      recoveryStatus: 'FAILED',
      recoveryReasonCode: 'SESSION_FAILURE',
    }));
    assert.equal(cleanupFailed.disconnect?.reasonCode, 'CLEANUP_FAILED');
    const beforeFreshConflict = await repository.read();
    await expectCode(repository.beginOwner({ candidateProviderId: 'fallback-1' }), 'ACTIVE_INSTANCE');
    assert.deepEqual(await repository.read(), beforeFreshConflict);
    await pool.query(`UPDATE listener_websocket_health
      SET heartbeat_at = clock_timestamp() - INTERVAL '31 seconds'
      WHERE service_key = 'transaction-listener'`);

    const restarted = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
    assert.equal(restarted.ownerGeneration, 2n);
    assert.equal(restarted.phase, 'CONNECTING');
    assert.equal(restarted.disconnect?.reasonCode, 'UNEXPECTED_RESTART');
    assert.deepEqual(restarted.recovery, {
      status: 'REQUIRED', startedAtMs: null, completedAtMs: null,
      reasonCode: 'UNEXPECTED_RESTART',
    });
  });
});

void test('websocket health repository fences transitions by exact owner and revision and reports exhaustion', async (context) => {
  await withRepository(context, 'websocket_health_cas', async ({ pool, repository }) => {
    const first = await repository.beginOwner({ candidateProviderId: 'primary' });
    const transitionBefore = await databaseNowMs(pool);
    const waiting = await repository.transition(transitionFrom(first, { phase: 'WAITING_FOR_ACKS' }));
    const transitionAfter = await databaseNowMs(pool);
    assert.ok(waiting.updatedAtMs >= transitionBefore && waiting.updatedAtMs <= transitionAfter);
    assert.equal(waiting.updatedAtMs, waiting.heartbeatAtMs);
    const beforeStale = await repository.read();
    await expectCode(
      repository.transition(transitionFrom(first, { phase: 'WAITING_FOR_ACKS' })),
      'STALE_REVISION',
    );
    await expectCode(
      repository.transition({ ...transitionFrom(waiting), ownerGeneration: 2n }),
      'STALE_OWNER',
    );
    assert.deepEqual(await repository.read(), beforeStale);

    const stopped = await repository.transition(transitionFrom(waiting, {
      phase: 'STOPPED',
      candidateProviderId: null,
      candidateSessionGeneration: null,
    }));
    await pool.query(`UPDATE listener_websocket_health
      SET owner_generation = $1 WHERE service_key = 'transaction-listener'`,
    [MAX_WEBSOCKET_HEALTH_GENERATION.toString()]);
    await expectCode(repository.beginOwner({ candidateProviderId: 'primary' }), 'GENERATION_EXHAUSTED');

    await pool.query(`UPDATE listener_websocket_health
      SET owner_generation = $1, revision = $1 WHERE service_key = 'transaction-listener'`,
    [MAX_WEBSOCKET_HEALTH_GENERATION.toString()]);
    await expectCode(repository.transition({
      ...transitionFrom(stopped),
      ownerGeneration: MAX_WEBSOCKET_HEALTH_GENERATION,
      expectedRevision: MAX_WEBSOCKET_HEALTH_GENERATION,
    }), 'GENERATION_EXHAUSTED');
  });
});

void test('websocket health repository serializes concurrent owner acquisition across pools', async (context) => {
  const databaseUrl = databaseUrlFor(context);
  if (databaseUrl === null) return;
  const schema = schemaName('websocket_health_concurrent_owner');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const firstPool = schemaPool(databaseUrl, schema);
  const secondPool = schemaPool(databaseUrl, schema);
  const blockerPool = schemaPool(databaseUrl, schema);
  let blocker: pg.PoolClient | null = null;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool: firstPool });
    blocker = await blockerPool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM listener_websocket_health
      WHERE service_key = 'transaction-listener' FOR UPDATE`);
    const firstGate = signallingPool(firstPool);
    const secondGate = signallingPool(secondPool);
    const first = new PostgresWebSocketHealthRepository(firstGate.pool);
    const second = new PostgresWebSocketHealthRepository(secondGate.pool);
    let settled = 0;
    const contenders = [
      first.beginOwner({ candidateProviderId: 'primary' }),
      second.beginOwner({ candidateProviderId: 'fallback-1' }),
    ].map((promise) => promise.finally(() => { settled += 1; }));
    await Promise.all([firstGate.arrived, secondGate.arrived]);
    assert.equal(settled, 0);
    await blocker.query('COMMIT');
    blocker.release();
    blocker = null;
    const results = await Promise.allSettled(contenders);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assertRepositoryCode(rejected.reason, 'ACTIVE_INSTANCE');
    const snapshot = await first.read();
    assert.equal(snapshot.ownerGeneration, 1n);
    assert.equal(snapshot.revision, 1n);
  } finally {
    if (blocker !== null) {
      try {
        await blocker.query('ROLLBACK');
        blocker.release();
      } catch {
        blocker.release(true);
      }
    }
    await firstPool.end();
    await secondPool.end();
    await blockerPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('websocket health repository transition captures one database clock after its row lock', async (context) => {
  await withRepository(context, 'websocket_health_transition_clock_order', async ({ pool, repository }) => {
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const blocker = await pool.connect();
    let locked = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM listener_websocket_health
        WHERE service_key = 'transaction-listener' FOR UPDATE`);
      locked = true;
      const pending = repository.transition(transitionFrom(started, {
        phase: 'RUNNING',
        providerId: 'primary',
        activeSessionGeneration: 1n,
        candidateProviderId: null,
        candidateSessionGeneration: null,
        acknowledged: true,
        disconnectReasonCode: 'SOCKET_ERROR',
        recoveryStatus: 'RECOVERED',
        recoveryReasonCode: 'STARTUP',
      }));
      await waitForRowLock(pool, '%SELECT health.owner_generation::TEXT AS owner_generation%');
      await pool.query("SELECT pg_sleep(0.05)");
      const releasingWriteMs = await writeHealthClock(blocker);
      await blocker.query('COMMIT');
      locked = false;
      const transitioned = await pending;
      const operationTimes = [
        transitioned.heartbeatAtMs,
        transitioned.updatedAtMs,
        transitioned.acknowledgedAtMs,
        transitioned.disconnect?.occurredAtMs,
        transitioned.recovery.startedAtMs,
        transitioned.recovery.completedAtMs,
      ];
      assert.ok(operationTimes.every((value) => value !== null && value !== undefined));
      assert.equal(new Set(operationTimes).size, 1);
      assert.ok(requiredValue(transitioned.heartbeatAtMs) >= releasingWriteMs);
    } finally {
      if (locked) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('websocket health repository beginOwner captures its database clock after its row lock', async (context) => {
  await withRepository(context, 'websocket_health_begin_clock_order', async ({ pool, repository }) => {
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const unrecoverable = await repository.transition(transitionFrom(started, {
      phase: 'UNRECOVERABLE',
      candidateProviderId: null,
      candidateSessionGeneration: null,
      disconnectReasonCode: 'CLEANUP_FAILED',
      recoveryStatus: 'FAILED',
      recoveryReasonCode: 'CATCH_UP_WINDOW_EXCEEDED',
    }));
    const blocker = await pool.connect();
    let locked = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM listener_websocket_health
        WHERE service_key = 'transaction-listener' FOR UPDATE`);
      locked = true;
      const pending = repository.beginOwner({ candidateProviderId: 'fallback-1' });
      await waitForRowLock(pool, '%FOR UPDATE OF health%');
      await pool.query("SELECT pg_sleep(0.05)");
      const releasingWriteMs = await writeHealthClock(blocker);
      await blocker.query('COMMIT');
      locked = false;
      const restarted = await pending;
      assert.equal(restarted.ownerGeneration, unrecoverable.ownerGeneration + 1n);
      assert.equal(restarted.heartbeatAtMs, restarted.updatedAtMs);
      assert.equal(restarted.heartbeatAtMs, restarted.disconnect?.occurredAtMs);
      assert.ok(requiredValue(restarted.heartbeatAtMs) >= releasingWriteMs);
      assert.deepEqual(restarted.recovery, {
        status: 'REQUIRED', startedAtMs: null, completedAtMs: null,
        reasonCode: 'CATCH_UP_WINDOW_EXCEEDED',
      });
    } finally {
      if (locked) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('websocket health repository touch changes only owner heartbeat freshness', async (context) => {
  await withRepository(context, 'websocket_health_touch', async ({ pool, repository }) => {
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const before = await repository.read();
    await pool.query("SELECT pg_sleep(0.005)");
    const touchBefore = await databaseNowMs(pool);
    await repository.touch(started.ownerGeneration);
    const touchAfter = await databaseNowMs(pool);
    const after = await repository.read();
    const beforeHeartbeat = requiredValue(before.heartbeatAtMs);
    const afterHeartbeat = requiredValue(after.heartbeatAtMs);
    assert.ok(afterHeartbeat > beforeHeartbeat);
    assert.ok(afterHeartbeat >= touchBefore && afterHeartbeat <= touchAfter);
    assert.deepEqual({ ...after, heartbeatAtMs: before.heartbeatAtMs }, before);
    await expectCode(repository.touch(2n), 'STALE_OWNER');
    assert.deepEqual(await repository.read(), after);
  });
});

void test('websocket health repository touch captures its database clock after its row lock', async (context) => {
  await withRepository(context, 'websocket_health_touch_clock_order', async ({ pool, repository }) => {
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const blocker = await pool.connect();
    let locked = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM listener_websocket_health
        WHERE service_key = 'transaction-listener' FOR UPDATE`);
      locked = true;
      const pending = repository.touch(started.ownerGeneration);
      await waitForRowLock(pool, '%SET heartbeat_at = clock_timestamp()%');
      await pool.query("SELECT pg_sleep(0.05)");
      const releasingWriteMs = await writeHealthClock(blocker);
      await blocker.query('COMMIT');
      locked = false;
      await pending;
      const touched = await repository.read();
      assert.ok(requiredValue(touched.heartbeatAtMs) >= releasingWriteMs);
    } finally {
      if (locked) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('websocket health repository records candidate and active observations and fences provider ABA', async (context) => {
  await withRepository(context, 'websocket_health_observation', async ({ pool, repository }) => {
    const connecting = await repository.beginOwner({ candidateProviderId: 'primary' });
    const beforeRemap = await repository.read();
    await expectCode(repository.transition(transitionFrom(connecting, {
      candidateProviderId: 'fallback-1',
    })), 'STATE_CONFLICT');
    assert.deepEqual(await repository.read(), beforeRemap);

    const candidateObservationBefore = await databaseNowMs(pool);
    assert.equal(await repository.recordObservation({
      ownerGeneration: 1n, sessionGeneration: 1n, slot: MAX_WEBSOCKET_HEALTH_SLOT,
    }), 'RECORDED');
    const candidateObservationAfter = await databaseNowMs(pool);
    const candidateObserved = await repository.read();
    assert.equal(candidateObserved.lastObservation?.slot, MAX_WEBSOCKET_HEALTH_SLOT);
    const candidateObservation = requiredValue(candidateObserved.lastObservation);
    assert.ok(candidateObservation.observedAtMs >= candidateObservationBefore
      && candidateObservation.observedAtMs <= candidateObservationAfter);

    const running = await repository.transition(transitionFrom(await repository.read(), {
      phase: 'RUNNING', providerId: 'primary', activeSessionGeneration: 1n,
      candidateProviderId: null, candidateSessionGeneration: null, acknowledged: true,
    }));
    await expectCode(repository.transition(transitionFrom(running, {
      providerId: 'fallback-1',
    })), 'STATE_CONFLICT');
    assert.deepEqual(await repository.read(), running);
    await expectCode(repository.transition(transitionFrom(running, {
      phase: 'DEGRADED', candidateProviderId: 'fallback-1',
      candidateSessionGeneration: 4n,
    })), 'STATE_CONFLICT');
    assert.deepEqual(await repository.read(), running);
    assert.equal(await repository.recordObservation({
      ownerGeneration: 1n, sessionGeneration: 1n, slot: 100n,
    }), 'RECORDED');
    assert.equal(await repository.recordObservation({
      ownerGeneration: 1n, sessionGeneration: 1n, slot: 50n,
    }), 'RECORDED');
    assert.equal((await repository.read()).lastObservation?.slot, 50n);

    const disconnectBefore = await databaseNowMs(pool);
    const rotating = await repository.transition(transitionFrom(running, {
      phase: 'DEGRADED', providerId: 'primary', activeSessionGeneration: 1n,
      candidateProviderId: 'primary', candidateSessionGeneration: 3n,
      acknowledged: true, disconnectReasonCode: 'SOCKET_ERROR',
      recoveryStatus: 'REQUIRED', recoveryReasonCode: 'SESSION_FAILURE',
    }));
    const disconnectAfter = await databaseNowMs(pool);
    const rotatingDisconnect = requiredValue(rotating.disconnect);
    assert.ok(rotatingDisconnect.occurredAtMs >= disconnectBefore
      && rotatingDisconnect.occurredAtMs <= disconnectAfter);
    await expectCode(repository.transition(transitionFrom(rotating, {
      phase: 'RUNNING', providerId: 'fallback-1', activeSessionGeneration: 3n,
      candidateProviderId: null, candidateSessionGeneration: null,
    })), 'STATE_CONFLICT');
    assert.deepEqual(await repository.read(), rotating);
    await pool.query("SELECT pg_sleep(0.005)");
    const repeated = await repository.transition(transitionFrom(rotating, {
      disconnectReasonCode: 'SOCKET_ERROR',
    }));
    assert.equal(repeated.disconnect?.reasonCode, 'SOCKET_ERROR');
    assert.ok(requiredValue(repeated.disconnect?.occurredAtMs)
      > rotatingDisconnect.occurredAtMs);
    assert.equal(await repository.recordObservation({
      ownerGeneration: 1n, sessionGeneration: 3n, slot: 60n,
    }), 'RECORDED');
    const recoveryBefore = await databaseNowMs(pool);
    const recovering = await repository.transition(transitionFrom(repeated, {
      phase: 'RECOVERING', recoveryStatus: 'IN_PROGRESS',
      recoveryReasonCode: 'SESSION_FAILURE',
    }));
    const recoveryAfter = await databaseNowMs(pool);
    const recoveryStartedAt = requiredValue(recovering.recovery.startedAtMs);
    assert.ok(recoveryStartedAt >= recoveryBefore && recoveryStartedAt <= recoveryAfter);
    const completedBefore = await databaseNowMs(pool);
    const promoted = await repository.transition(transitionFrom(recovering, {
      phase: 'RUNNING', providerId: 'primary', activeSessionGeneration: 3n,
      candidateProviderId: null, candidateSessionGeneration: null,
      acknowledged: true, recoveryStatus: 'RECOVERED', recoveryReasonCode: 'SESSION_FAILURE',
    }));
    const completedAfter = await databaseNowMs(pool);
    const recoveryCompletedAt = requiredValue(promoted.recovery.completedAtMs);
    assert.ok(recoveryCompletedAt >= completedBefore && recoveryCompletedAt <= completedAfter);
    assert.equal(promoted.recovery.startedAtMs, recovering.recovery.startedAtMs);
    assert.equal(
      requiredValue(promoted.evidencePurgeAfterMs) - recoveryCompletedAt,
      4 * 60 * 60 * 1_000,
    );
    await expectCode(repository.transition(transitionFrom(promoted, {
      phase: 'DEGRADED', providerId: 'primary', activeSessionGeneration: 3n,
      candidateProviderId: 'primary', candidateSessionGeneration: 1n,
      acknowledged: true,
    })), 'STATE_CONFLICT');
    await expectCode(repository.transition(transitionFrom(promoted, {
      phase: 'RUNNING', providerId: 'primary', activeSessionGeneration: 4n,
      candidateProviderId: null, candidateSessionGeneration: null,
      acknowledged: true,
    })), 'STATE_CONFLICT');
    const required = await repository.transition(transitionFrom(promoted, {
      phase: 'DEGRADED', providerId: 'primary', activeSessionGeneration: 3n,
      candidateProviderId: null, candidateSessionGeneration: null,
      acknowledged: true, recoveryStatus: 'REQUIRED', recoveryReasonCode: 'SESSION_FAILURE',
    }));
    assert.equal(required.evidencePurgeAfterMs, null);
    await assertStaleObservationDoesNotMutate(repository, {
      ownerGeneration: 1n, sessionGeneration: 1n, slot: 70n,
    });
    await assertStaleObservationDoesNotMutate(repository, {
      ownerGeneration: 2n, sessionGeneration: 3n, slot: 70n,
    });
    assert.equal(await repository.recordObservation({
      ownerGeneration: 1n, sessionGeneration: 3n, slot: 40n,
    }), 'RECORDED');
    assert.equal((await repository.read()).lastObservation?.slot, 40n);
    assert.equal(connecting.candidateProviderId, 'primary');
  });
});

void test('websocket health repository keeps the slot from the latest completed concurrent observation', async (context) => {
  await withRepository(context, 'websocket_health_concurrent_observation', async ({ pool, repository }) => {
    const connecting = await repository.beginOwner({ candidateProviderId: 'primary' });
    await pool.query(`CREATE FUNCTION delay_first_websocket_observation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.last_observation_slot = 100 THEN PERFORM pg_sleep(0.05); END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER delay_first_websocket_observation
      BEFORE UPDATE OF last_observation_slot ON listener_websocket_health
      FOR EACH ROW EXECUTE FUNCTION delay_first_websocket_observation()`);
    const completions: bigint[] = [];
    const first = repository.recordObservation({
      ownerGeneration: connecting.ownerGeneration,
      sessionGeneration: requiredValue(connecting.candidateSessionGeneration),
      slot: 100n,
    }).then((result) => { completions.push(100n); return result; });
    await pool.query('SELECT pg_sleep(0.01)');
    const second = repository.recordObservation({
      ownerGeneration: connecting.ownerGeneration,
      sessionGeneration: requiredValue(connecting.candidateSessionGeneration),
      slot: 50n,
    }).then((result) => { completions.push(50n); return result; });
    assert.deepEqual(await Promise.all([first, second]), ['RECORDED', 'RECORDED']);
    assert.deepEqual(completions, [100n, 50n]);
    assert.equal((await repository.read()).lastObservation?.slot, 50n);
  });
});

void test('websocket health repository observation captures its database clock after its row lock', async (context) => {
  await withRepository(context, 'websocket_health_observation_clock_order', async ({ pool, repository }) => {
    const connecting = await repository.beginOwner({ candidateProviderId: 'primary' });
    const blocker = await pool.connect();
    let locked = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM listener_websocket_health
        WHERE service_key = 'transaction-listener' FOR UPDATE`);
      locked = true;
      const pending = repository.recordObservation({
        ownerGeneration: connecting.ownerGeneration,
        sessionGeneration: requiredValue(connecting.candidateSessionGeneration),
        slot: 100n,
      });
      await waitForRowLock(pool, '%last_observation_at = clock_timestamp()%');
      await pool.query("SELECT pg_sleep(0.05)");
      const releasingWriteMs = await writeObservationClock(blocker);
      await blocker.query('COMMIT');
      locked = false;
      assert.equal(await pending, 'RECORDED');
      const observed = requiredValue((await repository.read()).lastObservation);
      assert.equal(observed.slot, 100n);
      assert.ok(observed.observedAtMs >= releasingWriteMs);
    } finally {
      if (locked) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('websocket health repository rolls back trigger failures and exposes fixed redacted errors', async (context) => {
  await withRepository(context, 'websocket_health_rollback', async ({ pool, repository }) => {
    const started = await repository.beginOwner({ candidateProviderId: 'primary' });
    const before = await repository.read();
    await pool.query(`CREATE FUNCTION reject_websocket_health_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'postgres secret rpc url'; END $$`);
    await pool.query(`CREATE TRIGGER reject_websocket_health_update
      AFTER UPDATE ON listener_websocket_health FOR EACH ROW
      EXECUTE FUNCTION reject_websocket_health_update()`);
    await expectCode(
      repository.transition(transitionFrom(started, { phase: 'WAITING_FOR_ACKS' })),
      'DEPENDENCY_FAILED',
    );
    await pool.query('DROP TRIGGER reject_websocket_health_update ON listener_websocket_health');
    assert.deepEqual(await repository.read(), before);
    const reused = await repository.transition(transitionFrom(started, {
      phase: 'WAITING_FOR_ACKS',
    }));
    assert.equal(reused.phase, 'WAITING_FOR_ACKS');
  });

  const dependency = new PostgresWebSocketHealthRepository({
    async connect() { throw new Error('postgresql://user:secret@rpc.invalid/database'); },
  });
  await expectCode(dependency.read(), 'DEPENDENCY_FAILED');
  let traps = 0;
  const hostile = new Proxy({}, { ownKeys() { traps += 1; throw new Error('secret'); } });
  await expectCode(
    dependency.beginOwner(hostile as never),
    'STATE_CONFLICT',
  );
  assert.equal(traps, 0);
});

void test('websocket health repository decodes canonical scale-bearing NUMERIC integers in read, begin, and transition', async () => {
  const operationAt = new Date('2026-08-28T10:00:00.000Z');
  const previousAt = new Date(operationAt.getTime() - 1_000);
  const runningRow = databaseSnapshotRow({
    supervision: 'ACTIVE', owner_generation: '1', revision: '1',
    active_session_generation: '1', provider_id: 'primary', phase: 'RUNNING',
    acknowledged_at: previousAt, last_observation_at: previousAt,
    last_observation_slot: '1.0', heartbeat_at: previousAt, updated_at: previousAt,
  });
  let row = runningRow;
  let freshnessSql = '';
  const repository = new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query(text: string) {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [], rowCount: null };
          }
          if (text.includes('owner_is_fresh')) {
            freshnessSql = text;
            return { rows: [{ operation_at: operationAt, owner_is_fresh: false }], rowCount: 1 };
          }
          if (text.includes('SELECT health.owner_generation::TEXT')) {
            return {
              rows: [{ owner_generation: row.owner_generation, revision: row.revision }],
              rowCount: 1,
            };
          }
          if (text.includes('UPDATE listener_websocket_health health SET')) {
            row = databaseSnapshotRow({
              supervision: 'ACTIVE', owner_generation: '2', revision: '3',
              candidate_session_generation: '2', candidate_provider_id: 'fallback-1',
              phase: 'WAITING_FOR_ACKS', last_observation_at: previousAt,
              last_observation_slot: '1.0',
              disconnect_occurred_at: operationAt,
              disconnect_reason_code: 'UNEXPECTED_RESTART',
              recovery_status: 'REQUIRED', recovery_reason_code: 'UNEXPECTED_RESTART',
              heartbeat_at: operationAt, updated_at: operationAt,
            });
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('UPDATE listener_websocket_health SET')) {
            row = databaseSnapshotRow({
              supervision: 'ACTIVE', owner_generation: '2', revision: '2',
              candidate_session_generation: '2', candidate_provider_id: 'fallback-1',
              phase: 'CONNECTING', last_observation_at: previousAt,
              last_observation_slot: '1.0',
              disconnect_occurred_at: operationAt,
              disconnect_reason_code: 'UNEXPECTED_RESTART',
              recovery_status: 'REQUIRED', recovery_reason_code: 'UNEXPECTED_RESTART',
              heartbeat_at: operationAt, updated_at: operationAt,
            });
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [row], rowCount: 1 };
        },
        release() {},
      };
    },
  });

  const running = await repository.read();
  assert.equal(running.lastObservation?.slot, 1n);
  const connecting = await repository.beginOwner({ candidateProviderId: 'fallback-1' });
  assert.equal(connecting.ownerGeneration, 2n);
  assert.equal(connecting.revision, 2n);
  assert.equal(connecting.lastObservation?.slot, 1n);
  assert.match(freshnessSql,
    /COALESCE\(\s+health\.heartbeat_at >= operation\.at - INTERVAL '30 seconds', FALSE\s+\) AS owner_is_fresh/u);
  const waiting = await repository.transition(transitionFrom(connecting, {
    phase: 'WAITING_FOR_ACKS',
  }));
  assert.equal(waiting.ownerGeneration, 2n);
  assert.equal(waiting.revision, 3n);
  assert.equal(waiting.lastObservation?.slot, 1n);

  const zeroSlot = repositoryWithQueryResult({
    rows: [{ ...runningRow, last_observation_slot: '0.00' }], rowCount: 1,
  });
  assert.equal((await zeroSlot.read()).lastObservation?.slot, 0n);

  for (const invalidNumeric of ['1.1', '01.0', '1.', '+1', '1e0']) {
    const malformed = repositoryWithQueryResult({
      rows: [{ ...runningRow, last_observation_slot: invalidNumeric }],
      rowCount: 1,
    });
    await expectCode(malformed.read(), 'STATE_CONFLICT');
  }
  for (const bigintColumn of [
    'owner_generation', 'revision', 'active_session_generation',
  ] as const) {
    const malformed = repositoryWithQueryResult({
      rows: [{ ...runningRow, [bigintColumn]: '1.0' }], rowCount: 1,
    });
    await expectCode(malformed.read(), 'STATE_CONFLICT');
  }
});

void test('websocket health repository rejects non-boolean owner freshness without mutation', async () => {
  const operationAt = new Date('2026-08-28T10:00:00.000Z');
  const invalidRows: readonly Readonly<Record<string, unknown>>[] = [
    { operation_at: operationAt },
    { operation_at: operationAt, owner_is_fresh: 'false' },
    { operation_at: operationAt, owner_is_fresh: { value: false } },
  ];
  for (const operationRow of invalidRows) {
    const statements: string[] = [];
    const releases: boolean[] = [];
    let updates = 0;
    const repository = new PostgresWebSocketHealthRepository({
      async connect() {
        return {
          async query(text: string) {
            statements.push(text);
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              return { rows: [], rowCount: null };
            }
            if (text.includes('SELECT health.*')) {
              return { rows: [databaseSnapshotRow()], rowCount: 1 };
            }
            if (text.includes('owner_is_fresh')) {
              return { rows: [operationRow], rowCount: 1 };
            }
            updates += 1;
            return {
              rows: [databaseSnapshotRow({
                supervision: 'ACTIVE', owner_generation: '1', revision: '1',
                candidate_session_generation: '1', candidate_provider_id: 'primary',
                phase: 'CONNECTING', heartbeat_at: operationAt, updated_at: operationAt,
              })],
              rowCount: 1,
            };
          },
          release(evict = false) { releases.push(evict); },
        };
      },
    });

    await expectCode(repository.beginOwner({ candidateProviderId: 'primary' }), 'STATE_CONFLICT');
    assert.equal(updates, 0);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual(releases, [false]);
  }
});

void test('websocket health repository evicts rollback failures and redacts release failures', async () => {
  const statements: string[] = [];
  const releases: boolean[] = [];
  const rollbackFailure = new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query(text: string) {
          statements.push(text);
          if (text === 'BEGIN') return { rows: [], rowCount: null };
          if (text === 'ROLLBACK') throw new Error('postgres rollback secret');
          return { rows: [], rowCount: 0 };
        },
        release(evict = false) { releases.push(evict); },
      };
    },
  });
  await expectCode(
    rollbackFailure.beginOwner({ candidateProviderId: 'primary' }),
    'DEPENDENCY_FAILED',
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.deepEqual(releases, [true]);

  const releaseFailure = new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query() { return { rows: [databaseSnapshotRow()], rowCount: 1 }; },
        release() { throw new Error('postgres release secret'); },
      };
    },
  });
  await expectCode(releaseFailure.read(), 'DEPENDENCY_FAILED');
});

void test('websocket health repository records a repeated disconnect code as a new incident', async () => {
  const previousIncident = new Date('2026-08-28T10:00:00.000Z');
  const nextIncident = new Date('2026-08-28T10:00:01.000Z');
  const currentRow = databaseSnapshotRow({
    supervision: 'ACTIVE', owner_generation: '1', revision: '1',
    active_session_generation: '1', provider_id: 'primary', phase: 'DEGRADED',
    acknowledged_at: previousIncident,
    disconnect_occurred_at: previousIncident, disconnect_reason_code: 'SOCKET_ERROR',
    recovery_status: 'REQUIRED', recovery_reason_code: 'SESSION_FAILURE',
    heartbeat_at: previousIncident, updated_at: previousIncident,
  });
  const current = await repositoryWithQueryResult({ rows: [currentRow], rowCount: 1 }).read();
  let updateSql = '';
  const repository = new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query(text: string) {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [], rowCount: null };
          }
          if (text.includes('SELECT health.owner_generation::TEXT')) {
            return { rows: [{ owner_generation: '1', revision: '1' }], rowCount: 1 };
          }
          updateSql = text;
          return {
            rows: [databaseSnapshotRow({
              ...currentRow,
              revision: '2', disconnect_occurred_at: nextIncident,
              heartbeat_at: nextIncident, updated_at: nextIncident,
            })],
            rowCount: 1,
          };
        },
        release() {},
      };
    },
  });

  const repeated = await repository.transition(transitionFrom(current, {
    disconnectReasonCode: 'SOCKET_ERROR',
  }));

  assert.equal(repeated.disconnect?.occurredAtMs, nextIncident.getTime());
  assert.match(updateSql,
    /disconnect_occurred_at = CASE\s+WHEN \$9::TEXT IS NULL THEN health\.disconnect_occurred_at\s+ELSE operation\.at END/u);
  assert.doesNotMatch(updateSql, /health\.disconnect_reason_code = \$9/u);
});

void test('websocket health repository never trusts hostile database values or forged public errors', async () => {
  let rowTraps = 0;
  const rowProxy = new Proxy({}, {
    get() { rowTraps += 1; throw new Error('postgres secret getter'); },
    ownKeys() { rowTraps += 1; throw new Error('postgres secret keys'); },
  });
  const hostileRow = repositoryWithQueryResult({ rows: [rowProxy], rowCount: 1 });
  await expectCode(hostileRow.read(), 'STATE_CONFLICT');
  assert.equal(rowTraps, 0);

  let getterCalls = 0;
  const getterRow = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(getterRow, 'payload_version', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('postgres secret accessor'); },
  });
  const hostileGetter = repositoryWithQueryResult({ rows: [getterRow], rowCount: 1 });
  await expectCode(hostileGetter.read(), 'STATE_CONFLICT');
  assert.equal(getterCalls, 0);

  let dateCalls = 0;
  const dateSubclass = new (class HostileDate extends Date {
    public override getTime(): number {
      dateCalls += 1;
      throw new Error('postgres secret date');
    }
  })();
  const hostileDate = repositoryWithQueryResult({
    rows: [{ ...databaseSnapshotRow(), updated_at: dateSubclass }],
    rowCount: 1,
  });
  await expectCode(hostileDate.read(), 'STATE_CONFLICT');
  assert.equal(dateCalls, 0);

  const forged = new WebSocketHealthRepositoryError('STALE_OWNER');
  let releases = 0;
  const hostileRejection = new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query() { throw forged; },
        release() { releases += 1; },
      };
    },
  });
  await assert.rejects(hostileRejection.read(), (error: unknown) => {
    assertRepositoryCode(error, 'DEPENDENCY_FAILED');
    assert.notEqual(error, forged);
    return true;
  });
  assert.equal(releases, 1);
});

function transitionFrom(
  snapshot: WebSocketHealthSnapshot,
  overrides: Partial<WebSocketHealthTransition> = {},
): WebSocketHealthTransition {
  return {
    ownerGeneration: snapshot.ownerGeneration,
    expectedRevision: snapshot.revision,
    phase: snapshot.phase,
    providerId: snapshot.providerId,
    activeSessionGeneration: snapshot.activeSessionGeneration,
    candidateProviderId: snapshot.candidateProviderId,
    candidateSessionGeneration: snapshot.candidateSessionGeneration,
    acknowledged: snapshot.acknowledgedAtMs !== null,
    disconnectReasonCode: null,
    recoveryStatus: snapshot.recovery.status,
    recoveryReasonCode: snapshot.recovery.reasonCode,
    ...overrides,
  };
}

function inactiveSnapshot(updatedAtMs: number): WebSocketHealthSnapshot {
  return {
    payloadVersion: 1,
    supervision: 'INACTIVE',
    ownerGeneration: 0n,
    revision: 0n,
    activeSessionGeneration: null,
    candidateSessionGeneration: null,
    providerId: null,
    candidateProviderId: null,
    phase: 'STOPPED',
    acknowledgedAtMs: null,
    lastObservation: null,
    disconnect: null,
    recovery: {
      status: 'NOT_REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null,
    },
    heartbeatAtMs: null,
    updatedAtMs,
    evidencePurgeAfterMs: null,
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: WebSocketHealthRepositoryError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assertRepositoryCode(error, code);
    return true;
  });
}

function assertRepositoryCode(
  error: unknown,
  code: WebSocketHealthRepositoryError['code'],
): asserts error is WebSocketHealthRepositoryError {
  assert.ok(error instanceof WebSocketHealthRepositoryError);
  assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error), /postgres|rpc|url|secret|signature/iu);
}

function requiredValue<TValue>(value: TValue | null | undefined): TValue {
  if (value === null || value === undefined) assert.fail('Expected a persisted value.');
  return value;
}

async function assertStaleObservationDoesNotMutate(
  repository: PostgresWebSocketHealthRepository,
  input: Parameters<PostgresWebSocketHealthRepository['recordObservation']>[0],
): Promise<void> {
  const before = await repository.read();
  assert.equal(await repository.recordObservation(input), 'STALE_SESSION');
  assert.deepEqual(await repository.read(), before);
}

interface RepositoryFixture {
  readonly pool: InstanceType<typeof pg.Pool>;
  readonly repository: PostgresWebSocketHealthRepository;
}

async function withRepository(
  context: TestContext,
  prefix: string,
  action: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  const databaseUrl = databaseUrlFor(context);
  if (databaseUrl === null) return;
  const schema = schemaName(prefix);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = schemaPool(databaseUrl, schema);
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await action({ pool, repository: new PostgresWebSocketHealthRepository(pool) });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function databaseUrlFor(context: TestContext): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health repository test skipped');
    return null;
  }
  return databaseUrl;
}

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function schemaPool(databaseUrl: string, schema: string): InstanceType<typeof pg.Pool> {
  return new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
}

function signallingPool(pool: InstanceType<typeof pg.Pool>): {
  readonly pool: WebSocketHealthPool;
  readonly arrived: Promise<void>;
} {
  let signalled = false;
  let signal: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { signal = resolve; });
  return {
    arrived,
    pool: {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, values?: readonly unknown[]) {
            if (!signalled && text.includes('FOR UPDATE OF health')) {
              signalled = true;
              signal?.();
            }
            return client.query(text, values === undefined ? undefined : [...values]);
          },
          release(error?: boolean) { client.release(error); },
        };
      },
    },
  };
}

function repositoryWithQueryResult(result: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}): PostgresWebSocketHealthRepository {
  return new PostgresWebSocketHealthRepository({
    async connect() {
      return {
        async query() { return result; },
        release() {},
      };
    },
  });
}

function databaseSnapshotRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const now = new Date();
  return {
    payload_version: 1,
    supervision: 'INACTIVE',
    owner_generation: '0',
    revision: '0',
    active_session_generation: null,
    candidate_session_generation: null,
    provider_id: null,
    candidate_provider_id: null,
    phase: 'STOPPED',
    acknowledged_at: null,
    last_observation_at: null,
    last_observation_slot: null,
    disconnect_occurred_at: null,
    disconnect_reason_code: null,
    recovery_status: 'NOT_REQUIRED',
    recovery_started_at: null,
    recovery_completed_at: null,
    recovery_reason_code: null,
    heartbeat_at: null,
    updated_at: now,
    evidence_purge_after: null,
    ...overrides,
  };
}

async function databaseNowMs(pool: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await pool.query<{ readonly now_ms: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::TEXT AS now_ms",
  );
  return Number(result.rows[0]?.now_ms);
}

async function waitForRowLock(
  pool: InstanceType<typeof pg.Pool>,
  queryPattern: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ readonly waiting: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE $1
    ) AS waiting`, [queryPattern]);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('PostgreSQL WebSocket health row-lock wait was not observed.');
}

async function writeHealthClock(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ readonly operation_at: Date }>(
    `WITH operation AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE listener_websocket_health health
     SET heartbeat_at = operation.at, updated_at = operation.at
     FROM operation WHERE health.service_key = 'transaction-listener'
     RETURNING operation.at AS operation_at`,
  );
  const operationAt = result.rows[0]?.operation_at;
  assert.ok(operationAt instanceof Date);
  return operationAt.getTime();
}

async function writeObservationClock(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ readonly operation_at: Date }>(
    `WITH operation AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE listener_websocket_health health
     SET last_observation_at = operation.at, last_observation_slot = 999
     FROM operation WHERE health.service_key = 'transaction-listener'
     RETURNING operation.at AS operation_at`,
  );
  const operationAt = result.rows[0]?.operation_at;
  assert.ok(operationAt instanceof Date);
  return operationAt.getTime();
}

async function rawCanonicalRow(pool: InstanceType<typeof pg.Pool>): Promise<Readonly<Record<string, unknown>>> {
  const result = await pool.query(`SELECT
    floor(extract(epoch FROM updated_at) * 1000)::TEXT AS updated_at_ms,
    floor(extract(epoch FROM heartbeat_at) * 1000)::TEXT AS heartbeat_at_ms,
    floor(extract(epoch FROM acknowledged_at) * 1000)::TEXT AS acknowledged_at_ms
    FROM listener_websocket_health WHERE service_key = 'transaction-listener'`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  assert.ok(row !== undefined);
  return Object.freeze({
    updated_at_ms: row.updated_at_ms === null ? null : Number(row.updated_at_ms),
    heartbeat_at_ms: row.heartbeat_at_ms === null ? null : Number(row.heartbeat_at_ms),
    acknowledged_at_ms: row.acknowledged_at_ms === null ? null : Number(row.acknowledged_at_ms),
  });
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}

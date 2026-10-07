// Lot 4b Task 6: guarded re-exit of a dead SELL intent (createNextReExitIntent, migration 066).
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { reExitLogicalCommandId } from '../src/domain/fast-exit.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import { expireExecutionIntentsPreSubmissionInTransaction } from
  '../src/storage/execution-intent-expiration.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionSimulationRepository } from
  '../src/storage/execution-simulation.repository.js';
import { roleSource, withProvisionedDatabase } from './helpers/entry-envelope-fixture.js';
import {
  beginSellAttempt,
  claimSellReconciliation,
  createAmbiguousSellFixture,
  createExitPendingFixture,
  createSellFixture,
  exactBuyWalletPublicKey,
  fingerprint,
  generationId,
  landedFailedSellEvidence,
  requiredDatabaseUrl,
  sellEvidence,
  waitForDatabaseQuery,
  withTemporarySchema,
} from './helpers/live-sell-fixture.js';

type Pool = InstanceType<typeof pg.Pool>;

// Past the 30 s spacing even when a reconciliation stamped terminal_at a few seconds ahead.
const AGE_MS = 40_000;

// ---------------------------------------------------------------------------------------------
// 1. A SELL that failed before signature is re-exited after the spacing.
// ---------------------------------------------------------------------------------------------

void test('re-exit: a SELL failed before signature gets :retry-1 after 30 s, not before',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await failedBeforeSignatureFixture(pool);
      const live = new PostgresExecutionLiveRepository(pool);
      const before = await writeState(pool);
      assert.equal(await live.createNextReExitIntent(), null, 'younger than the spacing');
      assert.deepEqual(await writeState(pool), before);

      await ageIntent(pool, fixture.exitIntent.id, AGE_MS);
      const result = await live.createNextReExitIntent();
      await assertReExitCreated(pool, fixture, result, 1);
      // The new intent is live: nothing else to do until it dies too.
      assert.equal(await live.createNextReExitIntent(), null);
    });
  });

// ---------------------------------------------------------------------------------------------
// 2. Expired SELLs: expired in place by the re-exit, without the retention worker.
// ---------------------------------------------------------------------------------------------

void test('re-exit: a PENDING SELL past its TTL is expired in place, then re-exited 30 s later',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createExitPendingFixture(pool);
      const live = new PostgresExecutionLiveRepository(pool);
      assert.equal(await live.createNextReExitIntent(), null, 'not expired yet');
      assert.equal(await intentStatus(pool, fixture.exitIntent.id), 'PENDING');

      await makeExpirable(pool, fixture.exitIntent.id);
      assert.equal(await live.createNextReExitIntent(), null, 'the expiry commits alone');
      assert.deepEqual(await expiredIntent(pool, fixture.exitIntent.id), {
        status: 'EXPIRED', last_reason_code: 'INTENT_EXPIRED', terminal: true, completed: true,
        transitions: ['PENDING>EXPIRED'],
      });
      const afterExpiry = await writeState(pool);
      assert.equal(await live.createNextReExitIntent(), null, 'spacing');
      assert.deepEqual(await writeState(pool), afterExpiry);

      await ageIntent(pool, fixture.exitIntent.id, AGE_MS);
      await assertReExitCreated(pool, fixture, await live.createNextReExitIntent(), 1);
    });
  });

void test('re-exit: a RETRY_READY SELL waits for its expiry, then is re-exited 30 s later',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      await fixture.live.commitReconciliation(
        await claimSellReconciliation(pool, 'reexit-retry-ready'), noEffect,
      );
      const intentId = fixture.claim.intent.id;
      assert.equal(await intentStatus(pool, intentId), 'RETRY_READY');
      const live = new PostgresExecutionLiveRepository(pool);
      const before = await writeState(pool);
      assert.equal(await live.createNextReExitIntent(), null, 'RETRY_READY is not terminal');
      assert.deepEqual(await writeState(pool), before);

      await makeExpirable(pool, intentId);
      assert.equal(await live.createNextReExitIntent(), null);
      assert.deepEqual(await expiredIntent(pool, intentId), {
        status: 'EXPIRED', last_reason_code: 'INTENT_EXPIRED', terminal: true, completed: true,
        transitions: ['RETRY_READY>EXPIRED'],
      });
      assert.equal(await live.createNextReExitIntent(), null, 'spacing');
      await ageIntent(pool, intentId, AGE_MS);
      await assertReExitCreated(pool, await exitPendingOf(pool, intentId),
        await live.createNextReExitIntent(), 1);
    });
  });

void test('re-exit: a SELL that landed with an error (FAILED, RECONCILED) is re-exited 30 s later',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await landedFailedFixture(pool);
      const live = new PostgresExecutionLiveRepository(pool);
      assert.equal(await live.createNextReExitIntent(), null, 'spacing');
      await ageIntent(pool, fixture.claim.intent.id, AGE_MS);
      await assertReExitCreated(pool, await exitPendingOf(pool, fixture.claim.intent.id),
        await live.createNextReExitIntent(), 1);
    });
  });

// ---------------------------------------------------------------------------------------------
// 3. In flight or unknown: no re-exit, nothing written, and the trigger refuses it.
// ---------------------------------------------------------------------------------------------

void test('re-exit: no SELL in flight or unknown is replaced (repository and 066 trigger)',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    const cases: readonly Readonly<{
      name: string;
      build: (pool: Pool) => Promise<string>;
    }>[] = [
      { name: 'PENDING', build: async (pool) => {
        const fixture = await createExitPendingFixture(pool);
        await ageIntent(pool, fixture.exitIntent.id, AGE_MS);
        return fixture.exitIntent.id;
      } },
      { name: 'PROCESSING with a live lease', build: async (pool) => {
        const fixture = await createExitPendingFixture(pool);
        const begun = await beginSellAttempt(pool, fixture);
        // Past its TTL, but H2b still holds the lease: not expirable.
        await withReplica(pool, async (client) => {
          await client.query(`UPDATE execution_intents SET
            requested_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '121 seconds',
            expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
            WHERE id=$1`, [begun.claim.intent.id]);
        });
        return begun.claim.intent.id;
      } },
      { name: 'SIGNED_NOT_SUBMITTED', build: async (pool) =>
        (await createSellFixture(pool, 'PERSISTED')).claim.intent.id },
      { name: 'SUBMISSION_STARTED artifact', build: async (pool) =>
        (await createSellFixture(pool, 'SUBMISSION_STARTED')).claim.intent.id },
      { name: 'SUBMITTED (ACCEPTED artifact)', build: async (pool) =>
        (await createSellFixture(pool, 'ACCEPTED')).claim.intent.id },
      { name: 'AMBIGUOUS artifact', build: async (pool) =>
        (await createSellFixture(pool, 'AMBIGUOUS')).claim.intent.id },
      { name: 'CONFIRMED', build: async (pool) =>
        (await createSellFixture(pool, 'CONFIRMED')).claim.intent.id },
      { name: 'UNKNOWN_REQUIRES_RECONCILIATION (position UNKNOWN)', build: async (pool) => {
        const fixture = await createAmbiguousSellFixture(pool);
        await fixture.live.commitReconciliation(fixture.claim,
          sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs));
        return fixture.claim.intent.id;
      } },
    ];
    for (const { name, build } of cases) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const intentId = await build(pool);
        const live = new PostgresExecutionLiveRepository(pool);
        const before = await writeState(pool);
        assert.equal(await live.createNextReExitIntent(), null, name);
        assert.deepEqual(await writeState(pool), before, name);
        assert.deepEqual(await live.listCappedDeadExits(), [], name);
        const positionId = await positionOf(pool, intentId);
        assert.equal(await directReExit(pool, positionId), '55000', name);
      });
    }
  });

void test('re-exit: a dead SELL is still refused while any guard condition fails',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    const cases: readonly Readonly<{
      name: string;
      fixture: 'FAILED' | 'LANDED_FAILED' | 'LANDED_FAILED_AFTER_UNKNOWN';
      mutate: (client: PoolClient, ids: Readonly<{ intentId: string; positionId: string }>)
        => Promise<void>;
    }>[] = [
      { name: 'LOCKED exit authorization', fixture: 'FAILED', mutate: async (client, ids) => {
        await client.query(`UPDATE execution_exit_authorizations SET state='LOCKED',
          locked_intent_id=$2,locked_attempt_number=1,state_revision=state_revision+1
          WHERE position_id=$1`, [ids.positionId, ids.intentId]);
      } },
      { name: 'unknown_block', fixture: 'FAILED', mutate: async (client) => {
        await client.query(`UPDATE execution_wallet_risk_state SET unknown_block=TRUE
          WHERE generation_id=$1`, [generationId]);
      } },
      { name: 'artifact AMBIGUOUS', fixture: 'LANDED_FAILED', mutate: async (client, ids) => {
        await client.query(`UPDATE execution_signed_transactions SET state='AMBIGUOUS',
          reconciled_at=NULL,purge_after=NULL WHERE intent_id=$1`, [ids.intentId]);
      } },
      { name: 'artifact CONFIRMED', fixture: 'LANDED_FAILED', mutate: async (client, ids) => {
        await client.query(`UPDATE execution_signed_transactions SET state='CONFIRMED',
          reconciled_at=NULL,purge_after=NULL,submitted_at=submission_started_at,
          confirmed_at=submission_started_at,confirmed_slot=778 WHERE intent_id=$1`,
        [ids.intentId]);
      } },
      { name: 'MATCHED evidence', fixture: 'LANDED_FAILED', mutate: async (client, ids) => {
        await client.query(`UPDATE execution_reconciliation_evidence SET result='MATCHED',
          reason_code='INTENT_SUCCEEDED' WHERE intent_id=$1`, [ids.intentId]);
      } },
      { name: 'unresolved UNKNOWN evidence', fixture: 'LANDED_FAILED_AFTER_UNKNOWN',
        mutate: async (client, ids) => {
          await client.query(`UPDATE execution_reconciliation_evidence SET
            resolved_by_evidence_id=NULL,resolved_at=NULL,purge_after=NULL
            WHERE intent_id=$1 AND result='UNKNOWN'`, [ids.intentId]);
        } },
      { name: 'unresolved MISMATCH evidence', fixture: 'LANDED_FAILED_AFTER_UNKNOWN',
        mutate: async (client, ids) => {
          await client.query(`UPDATE execution_reconciliation_evidence SET result='MISMATCH',
            reason_code='RESIDUAL_TOKEN_BALANCE',
            resolved_by_evidence_id=NULL,resolved_at=NULL,purge_after=NULL
            WHERE intent_id=$1 AND result='UNKNOWN'`, [ids.intentId]);
        } },
    ];
    for (const { name, fixture, mutate } of cases) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const intentId = fixture === 'FAILED'
          ? (await failedBeforeSignatureFixture(pool)).exitIntent.id
          : (await landedFailedFixture(pool, fixture === 'LANDED_FAILED_AFTER_UNKNOWN'))
            .claim.intent.id;
        await ageIntent(pool, intentId, AGE_MS);
        const positionId = await positionOf(pool, intentId);
        const ids = Object.freeze({ intentId, positionId });
        // Positive control: the same direct replacement passes the trigger before the mutation.
        assert.equal(await directReExit(pool, positionId), 'OK', name);
        await withReplica(pool, (client) => mutate(client, ids));
        assert.equal(await directReExit(pool, positionId), '55000', name);
        const live = new PostgresExecutionLiveRepository(pool);
        const before = await writeState(pool);
        assert.equal(await live.createNextReExitIntent(), null, name);
        assert.deepEqual(await writeState(pool), before, name);
      });
    }
  });

void test('066 trigger: a direct replacement must be the exact next retry of a dead, spaced SELL',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await failedBeforeSignatureFixture(pool);
      const intentId = fixture.exitIntent.id;
      const positionId = fixture.entry.position?.positionId;
      assert.ok(positionId !== undefined);
      const root = `maximum-holding:${positionId}`;
      // Spacing: the dead intent is younger than 30 s.
      assert.equal(await directReExit(pool, positionId), '55000');
      await ageIntent(pool, intentId, AGE_MS);
      assert.equal(await directReExit(pool, positionId), 'OK');
      for (const [name, override] of [
        ['skips a retry', { logicalCommandId: `${root}:retry-2` }],
        ['same key root only', { logicalCommandId: `${root}:retry-0` }],
        ['other strategy', { strategyId: 'fast-entry-exit-v1' }],
        ['other amount', { baseAmountRaw: '94' }],
        ['protective minimum', { minimumAmountOutRaw: '2' }],
        ['not live reserved', { liveReserved: false }],
      ] as const) {
        assert.equal(await directReExit(pool, positionId, override), '55000', name);
      }
      // Same intent id, nothing replaced.
      assert.equal(await directReExit(pool, positionId, { sameIntent: true }), '55000');
      // An exit reconciliation fingerprint on the row.
      assert.equal(await directReExit(pool, positionId, {
        positionMutation: `exit_reconciliation_fingerprint='${'f'.repeat(64)}'`,
      }), '55000');
      // EXIT_PENDING -> OPEN is still illegal.
      assert.equal(await directReExit(pool, positionId, {
        positionMutation: `state='OPEN',exit_intent_id=NULL`, keepIntent: true,
      }), '55000');
      // Cap: the dead intent is already :retry-3.
      await withReplica(pool, async (client) => {
        await client.query(`UPDATE execution_intents SET logical_command_id=$2,
          logical_order_key=$2 WHERE id=$1`, [intentId, `${root}:retry-3`]);
      });
      assert.equal(await directReExit(pool, positionId), '55000');
      assert.equal(await directReExit(pool, positionId,
        { logicalCommandId: `${root}:retry-4` }), '55000');
    });
  });

// ---------------------------------------------------------------------------------------------
// 4. Cap: at most three re-exits per position, and a capped position starves nobody.
// ---------------------------------------------------------------------------------------------

void test('re-exit: three re-exits at most, then the position is listed and the next one served',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createExitPendingFixture(pool);
      const positionId = fixture.entry.position?.positionId;
      assert.ok(positionId !== undefined);
      const live = new PostgresExecutionLiveRepository(pool);
      let current = fixture.exitIntent.id;
      for (const retry of [1, 2, 3]) {
        await makeExpirable(pool, current);
        assert.equal(await live.createNextReExitIntent(), null);
        assert.equal(await intentStatus(pool, current), 'EXPIRED');
        await ageIntent(pool, current, AGE_MS);
        const created = await live.createNextReExitIntent();
        await assertReExitCreated(pool, fixture, created, retry);
        assert.ok(created !== null);
        current = created.intent.id;
      }
      // The capped position is not touched by the re-exit, not even to expire its last SELL:
      // the retention worker does that.
      await makeExpirable(pool, current);
      const beforeCap = await writeState(pool);
      assert.equal(await live.createNextReExitIntent(), null);
      assert.deepEqual(await writeState(pool), beforeCap);
      assert.deepEqual(await live.listCappedDeadExits(), []);
      await retentionExpiry(pool);
      assert.equal(await intentStatus(pool, current), 'EXPIRED');
      await ageIntent(pool, current, AGE_MS);
      assert.deepEqual(await live.listCappedDeadExits(), [positionId]);
      const capped = await writeState(pool);
      assert.equal(await live.createNextReExitIntent(), null);
      assert.equal(await live.createNextReExitIntent(), null);
      assert.deepEqual(await writeState(pool), capped);
      assert.equal(await sellIntentCount(pool, positionId), 4);

      // A second, younger dead-exit position is still served behind the capped one.
      const clone = await cloneDeadExitPosition(pool, positionId);
      const served = await live.createNextReExitIntent();
      assert.equal(served?.positionId, clone.positionId);
      assert.equal(served?.intent.logicalCommandId, `maximum-holding:${clone.positionId}:retry-1`);
      assert.deepEqual(await live.listCappedDeadExits(), [positionId]);
    });
  });

// ---------------------------------------------------------------------------------------------
// 5. Exactly one new SELL.
// ---------------------------------------------------------------------------------------------

void test('re-exit: two concurrent re-exits create exactly one SELL intent', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await failedBeforeSignatureFixture(pool);
    await ageIntent(pool, fixture.exitIntent.id, AGE_MS);
    const results = await Promise.all([
      new PostgresExecutionLiveRepository(pool).createNextReExitIntent(),
      new PostgresExecutionLiveRepository(pool).createNextReExitIntent(),
    ]);
    assert.equal(results.filter((result) => result !== null).length, 1);
    const positionId = fixture.entry.position?.positionId;
    assert.ok(positionId !== undefined);
    assert.equal(await sellIntentCount(pool, positionId), 2);
  });
});

void test('re-exit racing the NO_EFFECT reconciliation waits for it and creates one SELL after',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      await fixture.live.commitReconciliation(fixture.claim,
        sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs));
      const terminalClaim = await claimSellReconciliation(pool, 'reexit-race');
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);
      const live = new PostgresExecutionLiveRepository(pool);
      const intentId = fixture.claim.intent.id;
      const positionId = await positionOf(pool, intentId);

      const blocker = await pool.connect();
      let blockerOpen = false;
      let reconciliation: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [
          generationId,
        ]);
        reconciliation = fixture.live.commitReconciliation(terminalClaim, noEffect);
        await waitForDatabaseQuery(pool, '%hashtextextended($1, 51005)%');
        // The ambiguous SELL is still UNKNOWN: nothing to re-exit.
        assert.equal(await live.createNextReExitIntent(), null);
        assert.equal(await sellIntentCount(pool, positionId), 1);
        await blocker.query('COMMIT');
        blockerOpen = false;
        await reconciliation;
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled([reconciliation].filter((value) => value !== undefined));
      }
      assert.equal(await intentStatus(pool, intentId), 'RETRY_READY');
      assert.equal(await live.createNextReExitIntent(), null);
      await makeExpirable(pool, intentId);
      assert.equal(await live.createNextReExitIntent(), null);
      await ageIntent(pool, intentId, AGE_MS);
      const created = await live.createNextReExitIntent();
      assert.equal(created?.previousIntentId, intentId);
      assert.equal(await sellIntentCount(pool, positionId), 2);
    });
  });

// ---------------------------------------------------------------------------------------------
// 6. Lapsed-lease fencing: an expired PROCESSING SELL can no longer persist signed bytes.
// ---------------------------------------------------------------------------------------------

void test('re-exit: a PROCESSING SELL whose lease lapsed is expired and its signer is fenced',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      let expiredIntentId: string | null = null;
      await assert.rejects(createSellFixture(pool, 'PERSISTED', async (_live, input) => {
        const intentId = input.artifact.intentId;
        await withReplica(pool, async (client) => {
          await client.query(`UPDATE execution_intents SET
            requested_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '121 seconds',
            expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
            lease_expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
            WHERE id=$1 AND status='PROCESSING'`, [intentId]);
        });
        assert.equal(await new PostgresExecutionLiveRepository(pool).createNextReExitIntent(),
          null);
        assert.equal(await intentStatus(pool, intentId), 'EXPIRED');
        expiredIntentId = intentId;
      }), (error: unknown) => error instanceof ExecutionLiveRepositoryError
        && error.code === 'LEASE_LOST');
      assert.ok(expiredIntentId !== null);
      assert.equal(await intentStatus(pool, expiredIntentId), 'EXPIRED');
      const artifacts = await pool.query(`SELECT 1 FROM execution_signed_transactions
        WHERE intent_id=$1`, [expiredIntentId]);
      assert.equal(artifacts.rowCount, 0);
      const attempt = await pool.query(`SELECT status,reason_code FROM execution_attempts
        WHERE intent_id=$1`, [expiredIntentId]);
      assert.deepEqual(attempt.rows, [{ status: 'ABANDONED', reason_code: 'INTENT_EXPIRED' }]);
    });
  });

// ---------------------------------------------------------------------------------------------
// 7. The recovery role.
// ---------------------------------------------------------------------------------------------

void test('PostgreSQL 16 recovery role re-exits a failed SELL; an invalid update is 55000',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const fixture = await failedBeforeSignatureFixture(pool);
      const positionId = fixture.entry.position?.positionId;
      assert.ok(positionId !== undefined);
      const recovery = new PostgresExecutionLiveRepository(
        roleSource(pool, 'sol_token_executor_live_recovery'),
      );
      assert.equal(await recovery.createNextReExitIntent(), null);
      // An invalid replacement (the BUY intent) reaches the trigger under the role.
      const client = await roleSource(pool, 'sol_token_executor_live_recovery').connect();
      try {
        await assert.rejects(client.query(`UPDATE execution_live_positions SET
          exit_intent_id=buy_intent_id,state_revision=state_revision+1
          WHERE position_id=$1`, [positionId]), (error: unknown) =>
          databaseErrorCode(error) === '55000');
      } finally {
        client.release();
      }
      await ageIntent(pool, fixture.exitIntent.id, AGE_MS);
      assert.deepEqual(await recovery.listCappedDeadExits(), []);
      await assertReExitCreated(pool, fixture, await recovery.createNextReExitIntent(), 1);

      // In-place expiry under the role (attempt abandoned, transition journaled).
      const created = await currentExitIntent(pool, positionId);
      await makeExpirable(pool, created);
      assert.equal(await recovery.createNextReExitIntent(), null);
      assert.equal(await intentStatus(pool, created), 'EXPIRED');
    });
  });

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

type ExitPendingFixture = Readonly<{
  exitIntent: Readonly<{ id: string; decisionEventId: string }>;
  entry: Readonly<{ position: Readonly<{ positionId: string }> | null }>;
}>;

async function failedBeforeSignatureFixture(pool: Pool) {
  const fixture = await createExitPendingFixture(pool);
  const begun = await beginSellAttempt(pool, fixture);
  await new PostgresExecutionSimulationRepository(pool).complete(
    begun.claim, providerFailureDraft(begun.claim, begun.attempt.attemptNumber),
    new AbortController().signal,
  );
  assert.equal(await intentStatus(pool, fixture.exitIntent.id), 'FAILED');
  return fixture;
}

async function landedFailedFixture(pool: Pool, afterUnknown = false) {
  const fixture = await createSellFixture(pool, 'CONFIRMED');
  let claim = fixture.claim;
  let observedAtMs = fixture.observedAtMs;
  if (afterUnknown) {
    await fixture.live.commitReconciliation(claim,
      sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs));
    claim = await claimSellReconciliation(pool, 'reexit-landed-failed-after-unknown');
    observedAtMs += 2_000;
  }
  const result = await fixture.live.commitReconciliation(claim,
    landedFailedSellEvidence(fixture, observedAtMs));
  assert.equal(result.result, 'NO_EFFECT');
  assert.equal(await intentStatus(pool, fixture.claim.intent.id), 'FAILED');
  return fixture;
}

function providerFailureDraft(claim: ClaimedExecutionIntent, attemptNumber: number) {
  return createExecutionSimulationArtifactDraft({
    intentId: claim.intent.id, attemptNumber, intentStateRevision: claim.intent.stateRevision,
    strategyId: claim.intent.strategyId, strategyVersion: claim.intent.strategyVersion,
    decisionFingerprint: claim.intent.decisionFingerprint,
    resultKind: 'PROVIDER_FAILED', effectiveVenue: null, providerId: 'primary',
    executorPublicKey: exactBuyWalletPublicKey, expectedGenesisHash: exactBuyWalletPublicKey,
    observedGenesisHash: null, configurationFingerprint: fingerprint,
    quoteFingerprint: null, snapshotFingerprint: null, buildFingerprint: null,
    messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, snapshotSlot: null, feeContextSlot: null,
    simulationSlot: null, amountInRaw: null, expectedAmountOutRaw: null,
    protectedAmountOutRaw: null, feesRaw: null, estimatedFeeLamports: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    rpcCallsUsed: 1, rpcCallsLimit: 8, quoteStatus: 'FAILED', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', failureStage: 'PROVIDER', failureCode: 'RPC_UNAVAILABLE',
    terminalReasonCode: 'EXECUTION_PROVIDER_FAILED', logsFingerprint: null, logsLineCount: null,
  });
}

async function assertReExitCreated(
  pool: Pool,
  fixture: ExitPendingFixture,
  result: Awaited<ReturnType<PostgresExecutionLiveRepository['createNextReExitIntent']>>,
  retry: number,
): Promise<void> {
  const positionId = fixture.entry.position?.positionId;
  assert.ok(positionId !== undefined);
  assert.ok(result !== null, `re-exit ${retry} created`);
  assert.equal(result.kind, 'CREATED');
  assert.equal(result.positionId, positionId);
  const root = `maximum-holding:${positionId}`;
  assert.equal(result.intent.logicalCommandId, `${root}:retry-${retry}`);
  assert.equal(result.intent.strategyId, 'maximum-holding-exit');
  assert.equal(result.intent.side, 'SELL');
  assert.equal(result.intent.venuePolicy, 'CANONICAL_EXIT');
  assert.equal(result.intent.minimumAmountOutRaw, 1n);
  assert.equal(result.intent.baseAmountRaw, 95n);
  assert.equal(result.intent.status, 'PENDING');
  assert.equal(result.intent.decisionEventId, fixture.exitIntent.decisionEventId);
  assert.equal(result.intent.expiresAtMs - result.intent.requestedAtMs, 120_000);
  const row = (await pool.query(`SELECT position.state,position.exit_intent_id,
    intent.live_reserved,intent.requested_at >= position.opened_at AS after_open,
    previous.status AS previous_status
    FROM execution_live_positions position
    JOIN execution_intents intent ON intent.id=position.exit_intent_id
    JOIN execution_intents previous ON previous.id=$2
    WHERE position.position_id=$1`, [positionId, result.previousIntentId])).rows[0];
  assert.deepEqual(row, {
    state: 'EXIT_PENDING', exit_intent_id: result.intent.id, live_reserved: true,
    after_open: true, previous_status: (row as { previous_status: string }).previous_status,
  });
  assert.ok(['FAILED', 'EXPIRED'].includes((row as { previous_status: string }).previous_status));
  assert.equal(reExitLogicalCommandId(
    retry === 1 ? root : `${root}:retry-${retry - 1}`,
  ), result.intent.logicalCommandId);
}

async function exitPendingOf(pool: Pool, intentId: string): Promise<ExitPendingFixture> {
  const row = (await pool.query<{ position_id: string; decision_event_id: string }>(`SELECT
    position.position_id,intent.decision_event_id
    FROM execution_live_positions position JOIN execution_intents intent ON intent.id=$1
    WHERE position.exit_intent_id=$1`, [intentId])).rows[0];
  assert.ok(row !== undefined);
  return Object.freeze({
    exitIntent: Object.freeze({ id: intentId, decisionEventId: row.decision_event_id }),
    entry: Object.freeze({ position: Object.freeze({ positionId: row.position_id }) }),
  });
}

async function positionOf(pool: Pool, intentId: string): Promise<string> {
  const row = (await pool.query<{ position_id: string }>(`SELECT position_id
    FROM execution_live_positions WHERE exit_intent_id=$1`, [intentId])).rows[0];
  assert.ok(row !== undefined);
  return row.position_id;
}

async function currentExitIntent(pool: Pool, positionId: string): Promise<string> {
  const row = (await pool.query<{ exit_intent_id: string }>(`SELECT exit_intent_id
    FROM execution_live_positions WHERE position_id=$1`, [positionId])).rows[0];
  assert.ok(row !== undefined);
  return row.exit_intent_id;
}

async function intentStatus(pool: Pool, intentId: string): Promise<string> {
  const row = (await pool.query<{ status: string }>(
    'SELECT status FROM execution_intents WHERE id=$1', [intentId],
  )).rows[0];
  assert.ok(row !== undefined);
  return row.status;
}

async function sellIntentCount(pool: Pool, positionId: string): Promise<number> {
  const row = (await pool.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count
    FROM execution_intents WHERE side='SELL' AND position_id=$1`, [positionId])).rows[0];
  return row?.count ?? -1;
}

async function expiredIntent(pool: Pool, intentId: string) {
  const row = (await pool.query<Record<string, unknown>>(`SELECT status,last_reason_code,
    terminal_at IS NOT NULL AS terminal,reconciliation_completed_at IS NOT NULL AS completed
    FROM execution_intents WHERE id=$1`, [intentId])).rows[0];
  const transitions = (await pool.query<{ step: string }>(`SELECT
    previous_status || '>' || next_status AS step FROM execution_intent_transitions
    WHERE intent_id=$1 AND next_status='EXPIRED' ORDER BY sequence`, [intentId])).rows;
  return { ...row, transitions: transitions.map((transition) => transition.step) };
}

/** Every row a re-exit may write, to prove that a refused call writes nothing. */
async function writeState(pool: Pool): Promise<unknown> {
  const intents = await pool.query(`SELECT id,status,state_revision::TEXT AS revision
    FROM execution_intents ORDER BY id`);
  const positions = await pool.query(`SELECT position_id,state,exit_intent_id,
    state_revision::TEXT AS revision FROM execution_live_positions ORDER BY position_id`);
  const transitions = await pool.query(`SELECT COUNT(*)::INTEGER AS count
    FROM execution_intent_transitions`);
  const attempts = await pool.query(`SELECT intent_id,attempt_number,status
    FROM execution_attempts ORDER BY intent_id,attempt_number`);
  return {
    intents: intents.rows, positions: positions.rows,
    transitions: transitions.rows, attempts: attempts.rows,
  };
}

async function retentionExpiry(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await expireExecutionIntentsPreSubmissionInTransaction(client, 10), 1);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function withReplica(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await operation(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Moves an intent's timeline back (test clock): its terminal time ages past the spacing. */
async function ageIntent(pool: Pool, intentId: string, ageMs: number): Promise<void> {
  await withReplica(pool, async (client) => {
    const updated = await client.query(`UPDATE execution_intents SET
      requested_at=requested_at-($2::BIGINT*INTERVAL '1 millisecond'),
      expires_at=expires_at-($2::BIGINT*INTERVAL '1 millisecond'),
      terminal_at=terminal_at-($2::BIGINT*INTERVAL '1 millisecond'),
      reconciliation_completed_at=reconciliation_completed_at
        -($2::BIGINT*INTERVAL '1 millisecond'),
      purge_after=purge_after-($2::BIGINT*INTERVAL '1 millisecond')
      WHERE id=$1`, [intentId, ageMs]);
    assert.equal(updated.rowCount, 1);
  });
}

/** Moves a live intent's TTL (and any lease) into the past, as 120 s of wall time would. */
async function makeExpirable(pool: Pool, intentId: string): Promise<void> {
  await withReplica(pool, async (client) => {
    const updated = await client.query(`UPDATE execution_intents SET
      requested_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '121 seconds',
      expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
      lease_expires_at=CASE WHEN lease_expires_at IS NULL THEN NULL ELSE
        date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second' END
      WHERE id=$1 AND terminal_at IS NULL`, [intentId]);
    assert.equal(updated.rowCount, 1);
  });
}

interface DirectReExitOverride {
  readonly logicalCommandId?: string;
  readonly strategyId?: string;
  readonly baseAmountRaw?: string;
  readonly minimumAmountOutRaw?: string;
  readonly liveReserved?: boolean;
  readonly sameIntent?: boolean;
  readonly keepIntent?: boolean;
  readonly positionMutation?: string;
}

/**
 * Replaces the position's exit intent with a hand-made PENDING SELL in one rolled-back
 * transaction, only the position UPDATE running with the triggers on. Returns 'OK' or the
 * SQLSTATE of the refusal.
 */
async function directReExit(
  pool: Pool,
  positionId: string,
  override: DirectReExitOverride = {},
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    const current = (await client.query<{ exit_intent_id: string; logical_command_id: string }>(
      `SELECT position.exit_intent_id,intent.logical_command_id
      FROM execution_live_positions position
      JOIN execution_intents intent ON intent.id=position.exit_intent_id
      WHERE position.position_id=$1`, [positionId])).rows[0];
    assert.ok(current !== undefined);
    const nextKey = override.logicalCommandId
      ?? reExitLogicalCommandId(current.logical_command_id)
      ?? `${current.logical_command_id.replace(/:retry-\d+$/u, '')}:retry-4`;
    const newIntentId = override.sameIntent === true
      ? current.exit_intent_id
      : `execution_intent_${randomBytes(32).toString('hex')}`;
    if (override.sameIntent !== true) {
      await client.query(`CREATE TEMP TABLE direct_reexit ON COMMIT DROP AS
        SELECT * FROM execution_intents WHERE id=$1`, [current.exit_intent_id]);
      await client.query(`UPDATE direct_reexit SET id=$1,logical_order_key=$2,
        logical_command_id=$2,strategy_id=COALESCE($3,strategy_id),
        base_amount_raw=COALESCE($4::NUMERIC,base_amount_raw),
        minimum_amount_out_raw=COALESCE($5::NUMERIC,1),live_reserved=$6,
        status='PENDING',attempt_count=0,last_reason_code=NULL,terminal_at=NULL,
        reconciliation_completed_at=NULL,purge_after=NULL,lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL,state_revision=0,
        requested_at=date_trunc('milliseconds',statement_timestamp()),
        expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '120 seconds',
        created_at=date_trunc('milliseconds',statement_timestamp()),
        updated_at=date_trunc('milliseconds',statement_timestamp())`, [
        newIntentId, nextKey, override.strategyId ?? null, override.baseAmountRaw ?? null,
        override.minimumAmountOutRaw ?? null, override.liveReserved ?? true,
      ]);
      await client.query('INSERT INTO execution_intents SELECT * FROM direct_reexit');
    }
    await client.query('SET LOCAL session_replication_role=origin');
    await client.query('SAVEPOINT direct_reexit_update');
    try {
      const assignments = [
        ...(override.keepIntent === true ? [] : ['exit_intent_id=$2']),
        'state_revision=state_revision+1',
        ...(override.positionMutation === undefined ? [] : [override.positionMutation]),
      ].join(',');
      const values = override.keepIntent === true ? [positionId] : [positionId, newIntentId];
      const updated = await client.query(`UPDATE execution_live_positions SET ${assignments}
        WHERE position_id=$1`, values);
      assert.equal(updated.rowCount, 1);
      return 'OK';
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === null) throw error;
      return code;
    }
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

/**
 * A second position of the same generation (opened 5 s later, same mint) stuck EXIT_PENDING
 * behind its own FAILED deadline SELL, aged past the spacing. The one-active-position index is
 * dropped in this temporary schema only.
 */
async function cloneDeadExitPosition(
  pool: Pool,
  positionId: string,
): Promise<Readonly<{ positionId: string }>> {
  const clonePositionId = `execution_live_position_${randomBytes(32).toString('hex')}`;
  const cloneBuyIntentId = `execution_intent_${randomBytes(32).toString('hex')}`;
  const cloneExitIntentId = `execution_intent_${randomBytes(32).toString('hex')}`;
  const cloneAuthorizationId = `execution_exit_authorization_${randomBytes(32).toString('hex')}`;
  const key = `maximum-holding:${clonePositionId}`;
  await withReplica(pool, async (client) => {
    await client.query('DROP INDEX execution_live_positions_one_active_per_generation');
    await client.query(`CREATE TEMP TABLE clone_buy ON COMMIT DROP AS
      SELECT intent.* FROM execution_intents intent
      JOIN execution_live_positions position ON position.buy_intent_id=intent.id
      WHERE position.position_id=$1`, [positionId]);
    await client.query(`UPDATE clone_buy SET id=$1,logical_order_key=$2,logical_command_id=$2`,
      [cloneBuyIntentId, `clone:${cloneBuyIntentId}`]);
    await client.query('INSERT INTO execution_intents SELECT * FROM clone_buy');
    await client.query(`CREATE TEMP TABLE clone_position ON COMMIT DROP AS
      SELECT * FROM execution_live_positions WHERE position_id=$1`, [positionId]);
    await client.query(`UPDATE clone_position SET position_id=$1,buy_intent_id=$2,
      exit_intent_id=NULL,state='EXIT_PENDING',
      opened_at=opened_at+INTERVAL '5 seconds',exit_deadline_at=exit_deadline_at+INTERVAL '5 seconds'`,
    [clonePositionId, cloneBuyIntentId]);
    await client.query('INSERT INTO execution_live_positions SELECT * FROM clone_position');
    await client.query(`CREATE TEMP TABLE clone_exit ON COMMIT DROP AS
      SELECT * FROM execution_intents WHERE logical_command_id=$1`, [`maximum-holding:${positionId}`]);
    await client.query(`UPDATE clone_exit SET id=$1,logical_order_key=$2,logical_command_id=$2,
      position_id=$3,status='FAILED',last_reason_code='EXECUTION_PROVIDER_FAILED',
      attempt_count=0,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      requested_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '60 seconds',
      expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '60 seconds',
      terminal_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '40 seconds',
      reconciliation_completed_at=date_trunc('milliseconds',statement_timestamp())
        -INTERVAL '40 seconds',
      purge_after=date_trunc('milliseconds',statement_timestamp())
        -INTERVAL '40 seconds'+INTERVAL '4 hours'`, [cloneExitIntentId, key, clonePositionId]);
    await client.query('INSERT INTO execution_intents SELECT * FROM clone_exit');
    await client.query(`UPDATE execution_live_positions SET exit_intent_id=$2
      WHERE position_id=$1`, [clonePositionId, cloneExitIntentId]);
    await client.query(`CREATE TEMP TABLE clone_authorization ON COMMIT DROP AS
      SELECT * FROM execution_exit_authorizations WHERE position_id=$1`, [positionId]);
    await client.query(`UPDATE clone_authorization SET authorization_id=$1,position_id=$2,
      state='ACTIVE',locked_intent_id=NULL,locked_attempt_number=NULL,terminal_at=NULL,
      purge_after=NULL`, [cloneAuthorizationId, clonePositionId]);
    await client.query('INSERT INTO execution_exit_authorizations SELECT * FROM clone_authorization');
  });
  return Object.freeze({ positionId: clonePositionId });
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor
    && typeof descriptor.value === 'string' ? descriptor.value : null;
}

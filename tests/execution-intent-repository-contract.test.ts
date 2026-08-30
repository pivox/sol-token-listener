import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import type {
  ClaimedExecutionIntent,
  ExecutionClaimPurpose,
  ExecutionIntentRepository,
  ExecutionIntentTransitionEvidenceV1,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';

void test('execution intent repository is a domain-only, strict persistence boundary', async () => {
  const source = await readFile(
    new URL('../src/ports/execution-intent-repository.ts', import.meta.url),
    'utf8',
  );
  const imports = source.match(/^import[\s\S]*?;$/gmu)?.join('\n') ?? '';

  assert.match(source, /import\s+type\s+\{[\s\S]*?\}\s+from '\.\.\/domain\/execution-intent\.js';/);
  assert.deepEqual([...imports.matchAll(/from '([^']+)'/gu)].map((match) => match[1]), [
    '../domain/execution-intent.js',
  ]);
  assert.doesNotMatch(imports, /(?:\.\.\/executor\/|\.\.\/execution\/|@solana\/web3\.js|wallet|transport|transaction-builder|signer|submission)/i);
});

void test('execution intent repository contract supports frozen execution lifecycle values', async () => {
  const repository = new StrictFakeExecutionIntentRepository();
  const draft = createExecutionIntentDraft({
    strategyId: 'strategy', strategyVersion: 1, positionId: 'position', logicalCommandId: 'command',
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'event', decisionFingerprint: 'a'.repeat(64), requestedAtMs: 1, expiresAtMs: 2,
  });
  const created = await repository.create(draft);
  const purpose: ExecutionClaimPurpose = 'EXECUTE';
  const claim = await repository.claim({ ownerId: 'worker', leaseMs: 30_000, purpose });
  assert.ok(claim);
  const attempt = await repository.beginAttempt(claim);
  const evidence = Object.freeze({
    payloadVersion: 1,
    attemptNumber: attempt.attemptNumber,
    sourceEventId: 'event',
    observedAtMs: 3,
  } satisfies ExecutionIntentTransitionEvidenceV1);
  const transition = Object.freeze({
    intentId: created.intent.id,
    expectedStatus: 'PENDING',
    nextStatus: 'PROCESSING',
    leaseToken: claim.leaseToken,
    reasonCode: 'INTENT_LEASE_LOST',
    humanMessage: 'claimed by worker',
    activationPhase: 'NONE',
    evidence,
  } satisfies ExecutionIntentTransitionInput);

  assert.ok(Object.isFrozen(created.intent));
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(transition));
  assert.equal(await repository.finishAttempt(claim, {
    attemptNumber: attempt.attemptNumber,
    status: 'COMPLETED',
    effectiveVenue: 'PUMP_FUN',
    providerId: 'provider',
    reasonCode: 'INTENT_DUPLICATE',
  }), true);
  assert.equal(await repository.renew(claim, 30_000), true);
  assert.equal((await repository.transition(claim, transition)).id, created.intent.id);
  assert.equal(await repository.release(claim), true);
  assert.equal(await repository.expirePreSubmission(10), 0);
  assert.equal((await repository.read(created.intent.id))?.id, created.intent.id);
});

class StrictFakeExecutionIntentRepository implements ExecutionIntentRepository {
  private intent: ExecutionIntentV1 | null = null;

  public async create(draft: Parameters<ExecutionIntentRepository['create']>[0]) {
    this.intent = Object.freeze({
      ...draft, status: 'PENDING', attemptCount: 0, lastReasonCode: null, terminalAtMs: null,
      reconciliationCompletedAtMs: null, purgeAfterMs: null, createdAtMs: 1, updatedAtMs: 1,
    });
    return Object.freeze({ kind: 'CREATED' as const, intent: this.intent });
  }

  public async claim(_options: Parameters<ExecutionIntentRepository['claim']>[0]): Promise<ClaimedExecutionIntent | null> {
    return this.intent === null ? null : Object.freeze({
      intent: this.intent, leaseOwner: 'worker', leaseToken: 'lease', leaseExpiresAtMs: 30_001,
    });
  }

  public async beginAttempt(claim: ClaimedExecutionIntent) {
    return Object.freeze({ intentId: claim.intent.id, attemptNumber: 1, startedAtMs: 2 });
  }

  public async finishAttempt(_claim: ClaimedExecutionIntent, _input: Parameters<ExecutionIntentRepository['finishAttempt']>[1]): Promise<boolean> { return true; }

  public async renew(_claim: ClaimedExecutionIntent, _leaseMs: number): Promise<boolean> { return true; }
  public async release(_claim: ClaimedExecutionIntent): Promise<boolean> { return true; }
  public async transition(_claim: ClaimedExecutionIntent, _input: ExecutionIntentTransitionInput): Promise<ExecutionIntentV1> { assert.ok(this.intent); return this.intent; }
  public async expirePreSubmission(_limit: number): Promise<number> { return 0; }
  public async read(intentId: string): Promise<ExecutionIntentV1 | null> { return this.intent?.id === intentId ? this.intent : null; }
}

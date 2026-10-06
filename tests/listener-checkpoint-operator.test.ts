import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  CheckpointRebaseOperator,
  CheckpointRebaseRefusal,
  type CheckpointRebaseGap,
  type CheckpointRebasePlan,
  type CheckpointRebaseRepository,
  type CheckpointRebaseRpc,
  type ProcessingCheckpointSnapshot,
} from '../src/application/checkpoint-rebase-operator.js';
import { parseCheckpointOperatorCommand } from '../src/cli/listener-checkpoint-operator.js';

const genesis = 'expected-mainnet-genesis';
const signature = bs58.encode(Buffer.alloc(64, 7));

void test('operator CLI is read-only by default and only accepts the explicit rebase confirmation', () => {
  assert.deepEqual(parseCheckpointOperatorCommand(['inspect']), { action: 'inspect', confirmed: false });
  assert.deepEqual(parseCheckpointOperatorCommand([
    'rebase', '--program', 'launchpad', '--reason', 'invalid-future-checkpoint',
  ]), { action: 'rebase', program: 'launchpad', reason: 'invalid-future-checkpoint', confirmed: false });
  assert.equal(parseCheckpointOperatorCommand([
    'rebase', '--program', 'market', '--reason', 'invalid-future-checkpoint',
    '--confirm-invalid-checkpoint-rebase',
  ]).confirmed, true);
  assert.throws(() => parseCheckpointOperatorCommand([
    'rebase', '--program', 'launchpad', '--reason', 'invalid-future-checkpoint', '--force',
  ]), /Unsupported checkpoint operator argument/u);
});

void test('checkpoint rebase dry-run reports the gap and never writes', async () => {
  const repository = new FakeRepository(checkpoint(488_462_493n, 'old-signature'));
  const operator = new CheckpointRebaseOperator(repository, rpc(100n, signature));

  const result = await operator.execute('launchpad', 'invalid-future-checkpoint', false, genesis);

  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.plan.previous.slot, 488_462_493n);
  assert.equal(result.plan.finalizedHeadSlot, 100n);
  assert.equal(result.plan.next.slot, 100n);
  assert.equal(repository.writeCount, 0);
});

void test('confirmed checkpoint rebase persists once and a repeat is idempotent', async () => {
  const repository = new FakeRepository(checkpoint(488_462_493n, 'old-signature'));
  const operator = new CheckpointRebaseOperator(repository, rpc(100n, signature));

  const first = await operator.execute('launchpad', 'invalid-future-checkpoint', true, genesis);
  const second = await operator.execute('launchpad', 'invalid-future-checkpoint', true, genesis);

  assert.equal(first.status, 'APPLIED');
  assert.equal(second.status, 'ALREADY_APPLIED');
  assert.equal(repository.writeCount, 1);
  assert.equal(repository.current?.slot, 100n);
  assert.equal(repository.latestGap?.previousSignature, 'old-signature');
});

void test('rebase refuses a checkpoint at or below finalized head', async () => {
  const repository = new FakeRepository(checkpoint(100n, 'normal-signature'));
  const operator = new CheckpointRebaseOperator(repository, rpc(100n, signature));

  await assert.rejects(
    operator.execute('launchpad', 'invalid-future-checkpoint', false, genesis),
    (error: unknown) => error instanceof CheckpointRebaseRefusal
      && error.code === 'CHECKPOINT_NOT_ABOVE_FINALIZED_HEAD',
  );
  assert.equal(repository.writeCount, 0);
});

void test('rebase refuses a finalized signature newer than the sampled head', async () => {
  const repository = new FakeRepository(checkpoint(488_462_493n, 'old-signature'));
  const operator = new CheckpointRebaseOperator(repository, rpc(100n, signature, 101n));

  await assert.rejects(
    operator.execute('launchpad', 'invalid-future-checkpoint', false, genesis),
    (error: unknown) => error instanceof CheckpointRebaseRefusal
      && error.code === 'REBASE_SIGNATURE_ABOVE_FINALIZED_HEAD',
  );
});

void test('rebase resamples finalized head after reading the latest signature', async () => {
  const repository = new FakeRepository(checkpoint(488_462_493n, 'old-signature'));
  let headReads = 0;
  const rpcWithAdvancingHead: CheckpointRebaseRpc = Object.freeze({
    getGenesisHash: async () => genesis,
    getFinalizedHead: async () => { headReads += 1; return headReads === 1 ? 100n : 101n; },
    getLatestFinalizedSignature: async () => Object.freeze({
      signature, slot: 101n, confirmationStatus: 'finalized' as const,
    }),
  });
  const operator = new CheckpointRebaseOperator(repository, rpcWithAdvancingHead);

  const result = await operator.execute('launchpad', 'invalid-future-checkpoint', false, genesis);

  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.plan.finalizedHeadSlot, 101n);
  assert.equal(headReads, 2);
});

function checkpoint(slot: bigint, value: string): ProcessingCheckpointSnapshot {
  return Object.freeze({ key: 'launchpad', source: 'transaction-inbox', program: 'launchpad',
    slot, signature: value, transactionIndex: null, payload: Object.freeze({}), updatedAtMs: 1_800_000_000_000 });
}

function rpc(head: bigint, latestSignature: string, signatureSlot = head): CheckpointRebaseRpc {
  return Object.freeze({
    getGenesisHash: async () => genesis,
    getFinalizedHead: async () => head,
    getLatestFinalizedSignature: async () => Object.freeze({
      signature: latestSignature, slot: signatureSlot, confirmationStatus: 'finalized' as const,
    }),
  });
}

class FakeRepository implements CheckpointRebaseRepository {
  public writeCount = 0;
  public current: ProcessingCheckpointSnapshot | null;
  public latestGap: CheckpointRebaseGap | null = null;

  public constructor(initial: ProcessingCheckpointSnapshot) {
    this.current = initial;
  }

  public async inspect(key: ProcessingCheckpointSnapshot['key']) {
    assert.equal(key, this.current?.key);
    return Object.freeze({
      checkpoint: this.current,
      latestGap: this.latestGap,
      auditTableAvailable: true,
    });
  }

  public async apply(plan: CheckpointRebasePlan): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    this.writeCount += 1;
    this.latestGap = Object.freeze({ program: plan.previous.key,
      previousSlot: plan.previous.slot, previousSignature: plan.previous.signature,
      newSlot: plan.next.slot, newSignature: plan.next.signature,
      finalizedHeadSlot: plan.finalizedHeadSlot, genesisHash: plan.genesisHash,
      reason: plan.reason, recordedAtMs: plan.recordedAtMs });
    const current = this.current;
    assert.ok(current);
    this.current = Object.freeze({ ...current, slot: plan.next.slot,
      signature: plan.next.signature, transactionIndex: null, updatedAtMs: plan.recordedAtMs });
    return 'APPLIED';
  }
}

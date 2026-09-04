import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import { inspectUnsignedBuildPlan } from '../executor-simulation/instruction-inspector.js';
import { compileInspectedV0Message } from '../executor-simulation/message-compiler.js';
import { isInternalExecutionSimulationGatewayError } from
  '../executor-simulation/solana-simulation-gateway.js';
import type {
  ExecutionSimulationEvidenceV1,
  ExecutionSimulationGateway,
  ExecutionSimulationGatewayRequestV1,
} from '../ports/execution-simulation-gateway.js';
import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';

export interface LiveTransactionCandidateV1 {
  readonly payloadVersion: 1;
}

export interface LivePreparedTransactionMaterialV1 {
  readonly payloadVersion: 1;
  readonly walletPublicKey: string;
  readonly side: 'BUY' | 'SELL';
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly snapshotSlot: bigint;
  readonly quoteFingerprint: string;
  readonly quoteObservedAtMs: number;
  readonly quoteExpiresAtMs: number;
  readonly signedSimulationAccountAddresses: readonly [
    feePayer: string,
    userBaseAta: string,
    userQuoteAta: string,
  ];
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly messageHash: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly signedTransactionBytes: readonly number[];
  readonly signedTransactionHash: string;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

export interface LiveTransactionQuoteWindowV1 {
  readonly quoteObservedAtMs: number;
  readonly quoteExpiresAtMs: number;
}

export interface LiveTransactionPreparationResultV1 {
  readonly payloadVersion: 1;
  readonly evidence: ExecutionSimulationEvidenceV1;
  readonly candidate: LiveTransactionCandidateV1;
}

interface CandidateBinding {
  readonly material: LivePreparedTransactionMaterialV1;
  consumed: boolean;
}

export class LiveTransactionCandidateAuthority {
  private readonly bindings = new WeakMap<object, CandidateBinding>();

  public issue(material: LivePreparedTransactionMaterialV1): LiveTransactionCandidateV1 {
    if (!frozenPlainObject(material)) throw new TypeError('Invalid live transaction material.');
    const candidate = Object.freeze(Object.assign(Object.create(null), {
      payloadVersion: 1 as const,
    })) as LiveTransactionCandidateV1;
    this.bindings.set(candidate, { material, consumed: false });
    return candidate;
  }

  public consume(candidate: unknown): LivePreparedTransactionMaterialV1 | null {
    if (!frozenPlainObject(candidate)) return null;
    const binding = this.bindings.get(candidate);
    if (binding === undefined || binding.consumed) return null;
    binding.consumed = true;
    return binding.material;
  }
}

export class LiveTransactionPreparationError extends Error {
  public readonly code = 'LIVE_TRANSACTION_PREPARATION_FAILED' as const;

  public constructor() {
    super('Live transaction preparation failed.');
    this.name = 'LiveTransactionPreparationError';
  }
}

export class LiveTransactionPreparer {
  public constructor(
    private readonly simulationGateway: ExecutionSimulationGateway,
    private readonly signer: ExecutionTransactionSigner,
    private readonly candidateAuthority: LiveTransactionCandidateAuthority,
    private readonly maximumTransactionBytes: number,
  ) {
    if (!Number.isSafeInteger(maximumTransactionBytes)
      || maximumTransactionBytes < 1 || maximumTransactionBytes > 1_232) fail();
  }

  public async prepare(
    input: ExecutionSimulationGatewayRequestV1,
    quoteWindowValue: LiveTransactionQuoteWindowV1,
    beforeSign: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<LiveTransactionPreparationResultV1> {
    let quoteWindow: LiveTransactionQuoteWindowV1;
    let evidence: ExecutionSimulationEvidenceV1;
    let inspected: ReturnType<typeof inspectUnsignedBuildPlan>;
    let compiled: ReturnType<typeof compileInspectedV0Message>;
    let signedSimulationAccountAddresses:
      LivePreparedTransactionMaterialV1['signedSimulationAccountAddresses'];
    try {
      quoteWindow = quoteWindowFrom(quoteWindowValue);
      evidence = await this.simulationGateway.simulate(input, signal);
      inspected = inspectUnsignedBuildPlan(input.plan);
      if (this.signer.publicKey !== inspected.feePayer
        || evidence.snapshotFingerprint !== inspected.identity.snapshotFingerprint
        || input.snapshot.slot !== inspected.identity.snapshotSlot
        || input.snapshot.providerId.length < 1) fail();
      compiled = compileInspectedV0Message(Object.freeze({
        feePayer: inspected.feePayer,
        instructions: inspected.instructions,
        recentBlockhash: evidence.blockhash,
        maximumTransactionBytes: this.maximumTransactionBytes,
      }));
      if (compiled.messageHash !== evidence.messageHash) fail();
      signedSimulationAccountAddresses = simulationAccountAddresses(inspected);
    } catch (error) {
      rethrowPreparationError(error);
    }

    await beforeSign();

    try {
      const signed = await this.signer.signMessage(Uint8Array.from(compiled.messageBytes));
      if (!frozenPlainObject(signed) || !(signed.signature instanceof Uint8Array)
        || isProxy(signed.signature) || signed.signature.length !== 64) fail();
      const signature = Uint8Array.from(signed.signature);
      const transaction = VersionedTransaction.deserialize(
        Uint8Array.from(compiled.unsignedTransactionBytes),
      );
      if (transaction.signatures.length !== 1) fail();
      transaction.signatures[0] = signature;
      const signedBytes = transaction.serialize();
      if (signedBytes.length > this.maximumTransactionBytes) fail();
      const material: LivePreparedTransactionMaterialV1 = Object.freeze({
        payloadVersion: 1,
        walletPublicKey: inspected.feePayer,
        side: inspected.side,
        effectiveVenue: inspected.venue,
        snapshotSlot: inspected.identity.snapshotSlot,
        quoteFingerprint: inspected.identity.quoteFingerprint,
        quoteObservedAtMs: quoteWindow.quoteObservedAtMs,
        quoteExpiresAtMs: quoteWindow.quoteExpiresAtMs,
        signedSimulationAccountAddresses,
        buildFingerprint: evidence.buildFingerprint,
        snapshotFingerprint: evidence.snapshotFingerprint,
        messageHash: evidence.messageHash,
        blockhash: evidence.blockhash,
        lastValidBlockHeight: evidence.lastValidBlockHeight,
        signature: bs58.encode(signature),
        signedTransactionBytes: Object.freeze([...signedBytes]),
        signedTransactionHash: sha256(signedBytes),
        unsignedSimulation: evidence,
      });
      return Object.freeze({
        payloadVersion: 1,
        evidence,
        candidate: this.candidateAuthority.issue(material),
      });
    } catch (error) {
      rethrowPreparationError(error);
    }
  }
}

function simulationAccountAddresses(
  inspected: ReturnType<typeof inspectUnsignedBuildPlan>,
): LivePreparedTransactionMaterialV1['signedSimulationAccountAddresses'] {
  const userBaseAccounts = inspected.expectedAccounts.filter(
    (account) => account.role === 'USER_BASE_ATA',
  );
  const userQuoteAccounts = inspected.expectedAccounts.filter(
    (account) => account.role === 'USER_QUOTE_ATA',
  );
  const userBaseAta = userBaseAccounts[0];
  const userQuoteAta = userQuoteAccounts[0];
  if (userBaseAccounts.length !== 1 || userQuoteAccounts.length !== 1
    || userBaseAta === undefined || userQuoteAta === undefined) fail();
  return Object.freeze([
    inspected.feePayer,
    userBaseAta.address,
    userQuoteAta.address,
  ]);
}

function rethrowPreparationError(error: unknown): never {
  if (isInternalExecutionSimulationGatewayError(error)) throw error;
  if (error instanceof LiveTransactionPreparationError) throw error;
  throw new LiveTransactionPreparationError();
}

function quoteWindowFrom(value: unknown): LiveTransactionQuoteWindowV1 {
  if (!frozenPlainObject(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('quoteObservedAtMs')
    || !keys.includes('quoteExpiresAtMs')) fail();
  const observed = Object.getOwnPropertyDescriptor(value, 'quoteObservedAtMs');
  const expires = Object.getOwnPropertyDescriptor(value, 'quoteExpiresAtMs');
  if (observed === undefined || !('value' in observed) || !observed.enumerable
    || expires === undefined || !('value' in expires) || !expires.enumerable
    || !timestamp(observed.value) || !timestamp(expires.value)
    || observed.value >= expires.value) fail();
  return value as LiveTransactionQuoteWindowV1;
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function frozenPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.isFrozen(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(): never { throw new LiveTransactionPreparationError(); }

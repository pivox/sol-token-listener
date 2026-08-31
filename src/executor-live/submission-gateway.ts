import { createHash, createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { ExecutionLiveGateway } from '../ports/execution-live-gateway.js';
import type { AuthenticatedPersistedSignedTransactionV1 } from '../ports/execution-live-repository.js';

export type LiveSubmissionGatewayErrorCode =
  | 'PERSISTED_TRANSACTION_INVALID'
  | 'SUBMISSION_AMBIGUOUS'
  | 'SUBMISSION_SIGNATURE_MISMATCH';

export class LiveSubmissionGatewayError extends Error {
  public constructor(
    public readonly code: LiveSubmissionGatewayErrorCode,
    public readonly dispatchMayHaveOccurred: boolean,
  ) {
    super('Live transaction submission failed.');
    this.name = 'LiveSubmissionGatewayError';
  }
}

const SPKI_ED25519_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class LiveSubmissionGateway {
  public constructor(private readonly provider: ExecutionLiveGateway) {}

  public async submitPersisted(
    persisted: AuthenticatedPersistedSignedTransactionV1,
    signal: AbortSignal,
  ): Promise<Readonly<{ readonly signature: string }>> {
    let bytes: Uint8Array;
    try {
      if (signal.aborted) invalid();
      bytes = persistedBytes(persisted);
    } catch (error) {
      if (error instanceof LiveSubmissionGatewayError) throw error;
      invalid();
    }
    let result: Readonly<{ readonly signature: string }>;
    try {
      result = await this.provider.sendRawTransaction(Object.freeze({
        payloadVersion: 1,
        transactionBase64: Buffer.from(bytes).toString('base64'),
        skipPreflight: true,
        maxRetries: 0,
        preflightCommitment: 'confirmed',
      }), signal);
    } catch {
      throw new LiveSubmissionGatewayError('SUBMISSION_AMBIGUOUS', true);
    }
    if (!frozenPlainObject(result) || typeof result.signature !== 'string'
      || !canonicalSignature(result.signature)
      || result.signature !== persisted.artifact.signature) {
      throw new LiveSubmissionGatewayError('SUBMISSION_SIGNATURE_MISMATCH', true);
    }
    return Object.freeze({ signature: result.signature });
  }
}

function persistedBytes(inputValue: unknown): Uint8Array {
  if (!frozenPlainObject(inputValue) || inputValue.payloadVersion !== 1
    || inputValue.state !== 'SUBMISSION_STARTED'
    || typeof inputValue.stateRevision !== 'bigint' || inputValue.stateRevision < 1n
    || !frozenPlainObject(inputValue.artifact)) invalid();
  const input = inputValue as unknown as AuthenticatedPersistedSignedTransactionV1;
  const artifact = input.artifact;
  const bytes = Uint8Array.from(artifact.signedTransactionBytes);
  if (bytes.length < 1 || bytes.length > 1_232
    || sha256(bytes) !== artifact.signedTransactionHash) invalid();
  const transaction = VersionedTransaction.deserialize(bytes);
  const messageBytes = transaction.message.serialize();
  const signature = transaction.signatures[0];
  if (!Buffer.from(transaction.serialize()).equals(bytes)
    || transaction.version !== 0 || transaction.signatures.length !== 1
    || signature?.length !== 64 || bs58.encode(signature) !== artifact.signature
    || transaction.message.header.numRequiredSignatures !== 1
    || transaction.message.addressTableLookups.length !== 0
    || transaction.message.staticAccountKeys[0]?.toBase58() !== artifact.walletPublicKey
    || transaction.message.recentBlockhash !== artifact.blockhash
    || sha256(messageBytes) !== artifact.messageHash) invalid();
  const publicBytes = canonicalPublicKey(artifact.walletPublicKey).toBytes();
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PUBLIC_PREFIX, publicBytes]),
    format: 'der', type: 'spki',
  });
  if (!verify(null, messageBytes, key, signature)) invalid();
  return bytes;
}

function frozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.isFrozen(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function canonicalPublicKey(value: unknown): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 64) invalid();
  const key = new PublicKey(value);
  if (key.toBase58() !== value) invalid();
  return key;
}

function canonicalSignature(value: string): boolean {
  try {
    return bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value;
  } catch { return false; }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalid(): never {
  throw new LiveSubmissionGatewayError('PERSISTED_TRANSACTION_INVALID', false);
}

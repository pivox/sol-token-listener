import { constants } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import {
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import type { LiveExecutorConfig } from './config.js';

interface LiveKeypairStats {
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface LiveKeypairFileHandle {
  stat(): Promise<LiveKeypairStats>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface LiveKeypairFilesystem {
  open(path: string, flags: number): Promise<LiveKeypairFileHandle>;
}

export type LiveKeypairErrorCode = 'KEYPAIR_UNAVAILABLE' | 'KEYPAIR_PERMISSIONS_INVALID';

export class LiveKeypairError extends Error {
  public constructor(public readonly code: LiveKeypairErrorCode) {
    super('Live executor keypair unavailable.');
    this.name = 'LiveKeypairError';
  }
}

const nodeFilesystem: LiveKeypairFilesystem = Object.freeze({
  open: async (path: string, flags: number): Promise<LiveKeypairFileHandle> => openFile(path, flags),
});
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export async function loadLiveTransactionSigner(
  config: Pick<LiveExecutorConfig, 'executorPublicKey' | 'keypairPath'>,
  filesystem: LiveKeypairFilesystem = nodeFilesystem,
): Promise<ExecutionTransactionSigner> {
  let handle: LiveKeypairFileHandle | null = null;
  let raw: Buffer | null = null;
  let parsed: number[] | null = null;
  let secret: Uint8Array | null = null;
  let seed: Buffer | null = null;
  let pkcs8: Buffer | null = null;
  try {
    validateInputs(config, filesystem);
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== 'number') throw permissions();
    handle = await filesystem.open(config.keypairPath, constants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    const ownerUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const permissionBits = stats.mode & 0o777;
    if (ownerUid === null || !stats.isFile() || stats.isSymbolicLink()
      || stats.uid !== ownerUid
      || (permissionBits !== 0o400 && permissionBits !== 0o600)
      || stats.size < 129 || stats.size > 1_024) {
      throw permissions();
    }
    raw = await handle.readFile();
    if (raw.length !== stats.size) throw unavailable();
    const encoded = raw.toString('utf8');
    const candidate: unknown = JSON.parse(encoded);
    if (!Array.isArray(candidate) || isProxy(candidate)
      || Object.getPrototypeOf(candidate) !== Array.prototype
      || candidate.length !== 64 || Reflect.ownKeys(candidate).length !== 65
      || candidate.some((byte) => typeof byte !== 'number'
        || !Number.isInteger(byte) || byte < 0 || byte > 255)
      || JSON.stringify(candidate) !== encoded) throw unavailable();
    parsed = candidate;
    secret = Uint8Array.from(parsed);
    seed = Buffer.from(secret.subarray(0, 32));
    pkcs8 = Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]);
    const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(publicDer) || publicDer.length !== SPKI_ED25519_PUBLIC_PREFIX.length + 32
      || !publicDer.subarray(0, SPKI_ED25519_PUBLIC_PREFIX.length).equals(SPKI_ED25519_PUBLIC_PREFIX)) {
      throw unavailable();
    }
    const publicBytes = publicDer.subarray(SPKI_ED25519_PUBLIC_PREFIX.length);
    const publicKey = bs58.encode(publicBytes);
    if (publicKey !== config.executorPublicKey
      || !Buffer.from(secret.subarray(32)).equals(publicBytes)) throw unavailable();
    return createSigner(publicKey, privateKey);
  } catch (error) {
    if (error instanceof LiveKeypairError) throw error;
    throw unavailable();
  } finally {
    parsed?.fill(0);
    secret?.fill(0);
    seed?.fill(0);
    pkcs8?.fill(0);
    raw?.fill(0);
    if (handle !== null) {
      try { await handle.close(); } catch { /* The primary fixed error remains authoritative. */ }
    }
  }
}

function createSigner(publicKey: string, initialKey: KeyObject): ExecutionTransactionSigner {
  let privateKey: KeyObject | null = initialKey;
  return Object.freeze({
    publicKey,
    signMessage(messageBytes: Uint8Array) {
      try {
        if (privateKey === null) throw new Error('Live transaction signer is closed.');
        if (!(messageBytes instanceof Uint8Array) || isProxy(messageBytes)
          || messageBytes.length < 1 || messageBytes.length > 1_232) throw unavailable();
        const signature = sign(null, messageBytes, privateKey);
        if (signature.length !== 64) throw unavailable();
        return Promise.resolve(Object.freeze({ signature: Uint8Array.from(signature) }));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : unavailable());
      }
    },
    close() {
      privateKey = null;
      return Promise.resolve();
    },
  });
}

function validateInputs(
  config: unknown,
  filesystem: unknown,
): void {
  if (typeof config !== 'object' || config === null || isProxy(config)
    || !hasOwnDataProperty(config, 'executorPublicKey', 'string')
    || !hasOwnDataProperty(config, 'keypairPath', 'string')
    || typeof filesystem !== 'object' || filesystem === null || isProxy(filesystem)
    || !hasOwnDataProperty(filesystem, 'open', 'function')) throw unavailable();
}

function hasOwnDataProperty(
  value: object,
  key: PropertyKey,
  expectedType: 'function' | 'string',
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    && typeof descriptor.value === expectedType;
}

function unavailable(): LiveKeypairError { return new LiveKeypairError('KEYPAIR_UNAVAILABLE'); }
function permissions(): LiveKeypairError {
  return new LiveKeypairError('KEYPAIR_PERMISSIONS_INVALID');
}

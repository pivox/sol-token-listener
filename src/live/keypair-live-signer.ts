import { createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface SignedLiveTransaction {
  readonly signature: string;
  readonly bytes: Uint8Array;
}

/** Signing is isolated here; importing this module never reads key material. */
export class KeypairLiveSigner {
  public constructor(private readonly keypair: Keypair) {}

  public get publicKey(): string { return this.keypair.publicKey.toBase58(); }

  public sign(transaction: VersionedTransaction): SignedLiveTransaction {
    transaction.sign([this.keypair]);
    const bytes = transaction.serialize();
    const verified = verifySerializedLiveTransaction(bytes, this.keypair.publicKey.toBase58());
    return Object.freeze({ signature: verified, bytes });
  }
}

export function verifySerializedLiveTransaction(bytes: Uint8Array, expectedWallet: string): string {
  const transaction = VersionedTransaction.deserialize(bytes);
  const signatureBytes = transaction.signatures[0];
  const payer = transaction.message.staticAccountKeys[0];
  if (signatureBytes === undefined || signatureBytes.every((byte) => byte === 0)
    || payer?.toBase58() !== expectedWallet
    || !verify(null, transaction.message.serialize(), ed25519PublicKey(payer.toBytes()), signatureBytes)) {
    throw new Error('Signed transaction signature verification failed.');
  }
  return bs58.encode(signatureBytes);
}

function ed25519PublicKey(rawKey: Uint8Array) {
  if (rawKey.length !== 32) throw new TypeError('Ed25519 public key must contain 32 bytes.');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(rawKey)]), format: 'der', type: 'spki' });
}

/** Call only from the isolated live entrypoint after all activation checks. */
export async function loadLiveKeypairFile(
  keypairFile: string,
  expectedWallet: string,
  projectRoot = process.cwd(),
): Promise<KeypairLiveSigner> {
  const absolute = resolve(keypairFile);
  if (!isAbsolute(keypairFile) || isInside(resolve(projectRoot), absolute)) {
    throw new Error('Live keypair path must be absolute and outside the project.');
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let parsed: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('Live keypair file must be a regular file with owner-only permissions.');
    }
    parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
  if (!Array.isArray(parsed) || parsed.length !== 64
    || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('Live keypair file must contain a 64-byte JSON secret key.');
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  if (keypair.publicKey.toBase58() !== expectedWallet) {
    throw new Error('Live keypair does not match the explicitly expected wallet.');
  }
  return new KeypairLiveSigner(keypair);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path));
}

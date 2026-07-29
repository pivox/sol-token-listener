import { PublicKey } from '@solana/web3.js';
import { PumpSwapDecodingError } from './errors.js';

export class PumpSwapBorshReader {
  private position = 0;
  public constructor(private readonly bytes: Uint8Array) {}
  public get offset(): number { return this.position; }
  public get remaining(): number { return this.bytes.length - this.position; }
  public readU8(): bigint { return BigInt(this.readBytes(1)[0] ?? 0); }
  public readBool(): boolean {
    const value = Number(this.readU8());
    if (value === 0) return false;
    if (value === 1) return true;
    throw invalid(`Booléen Borsh invalide: ${value}.`);
  }
  public readU16(): bigint {
    return BigInt(this.view(2).getUint16(0, true));
  }
  public readU32(): bigint {
    return BigInt(this.view(4).getUint32(0, true));
  }
  public readU64(): bigint { return this.view(8).getBigUint64(0, true); }
  public readU128(): bigint {
    const low = this.view(16).getBigUint64(0, true);
    const high = this.viewAt(16, 8).getBigUint64(0, true);
    return (high << 64n) | low;
  }
  public readI64(): bigint { return this.view(8).getBigInt64(0, true); }
  public readI128(): bigint {
    const low = this.view(16).getBigUint64(0, true);
    const high = this.viewAt(16, 8).getBigInt64(0, true);
    return (high << 64n) | low;
  }
  public readPubkey(): string {
    return new PublicKey(this.readBytes(32)).toBase58();
  }
  public readString(maximum = 1_024): string {
    const length = this.view(4).getUint32(0, true);
    if (length > maximum) throw invalid(`Chaîne Borsh trop longue: ${length}.`);
    try {
      return new TextDecoder('utf-8', { fatal: true })
        .decode(this.readBytes(length));
    } catch (cause) {
      throw new PumpSwapDecodingError(
        'PUMPSWAP_BORSH_INVALID',
        'Chaîne Borsh UTF-8 invalide.',
        null,
        { cause },
      );
    }
  }
  public readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw invalid(`Longueur Borsh invalide: ${length}.`);
    }
    if (this.remaining < length) {
      throw new PumpSwapDecodingError(
        'PUMPSWAP_BORSH_TRUNCATED',
        `Données Borsh tronquées à l’octet ${this.position}.`,
      );
    }
    const value = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  private view(length: number): DataView {
    const data = this.readBytes(length);
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private viewAt(total: number, offset: number): DataView {
    const data = this.bytes.subarray(this.position - total + offset, this.position);
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
}

function invalid(message: string): PumpSwapDecodingError {
  return new PumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', message);
}

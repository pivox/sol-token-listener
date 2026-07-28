import { PublicKey } from '@solana/web3.js';
import { PumpDecodingError } from './errors.js';

export class PumpBorshReader {
  private position = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  public get offset(): number {
    return this.position;
  }

  public get remaining(): number {
    return this.bytes.length - this.position;
  }

  public readBool(): boolean {
    const value = this.readBytes(1)[0];
    if (value === 0) return false;
    if (value === 1) return true;
    throw new PumpDecodingError(
      'PUMP_BORSH_INVALID',
      false,
      `Booléen Borsh invalide: ${value}.`,
    );
  }

  public readU16(): bigint {
    const data = this.readBytes(2);
    return BigInt(new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getUint16(0, true));
  }

  public readU32Length(maximum = 1_048_576): number {
    const data = this.readBytes(4);
    const value = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getUint32(0, true);
    if (value > maximum) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        `Longueur Borsh ${value} supérieure à ${maximum}.`,
      );
    }
    return value;
  }

  public readU64(): bigint {
    const data = this.readBytes(8);
    return new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getBigUint64(0, true);
  }

  public readI64(): bigint {
    const data = this.readBytes(8);
    return new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getBigInt64(0, true);
  }

  public readPubkey(): string {
    return new PublicKey(this.readBytes(32)).toBase58();
  }

  public readString(maxBytes: number): string {
    const length = this.readU32Length(maxBytes);
    const bytes = this.readBytes(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        'Chaîne Borsh UTF-8 invalide.',
        null,
        cause,
      );
    }
  }

  public readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        `Longueur Borsh invalide: ${length}.`,
      );
    }
    if (this.remaining < length) {
      throw new PumpDecodingError(
        'PUMP_BORSH_TRUNCATED',
        true,
        `Données Borsh tronquées à l’octet ${this.position}.`,
      );
    }
    const result = this.bytes.subarray(
      this.position,
      this.position + length,
    );
    this.position += length;
    return result;
  }
}

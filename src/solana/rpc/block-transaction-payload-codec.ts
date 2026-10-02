import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const MAX_COMPRESSED_TRANSACTION_BYTES = 1048576;
export const MAX_BLOCK_COMPRESSION_INPUT_BYTES = 33554432;

export class BlockTransactionPayloadCodecError extends Error {
  constructor() {
    super('Block transaction payload codec failed');
    this.name = 'BlockTransactionPayloadCodecError';
  }
}

export function encodeBlockTransactionPayload(
  serialized: Uint8Array,
  remainingCompressionBytes: number,
): Readonly<{ payload: string; compressionInputBytes: number }> {
  try {
    if (!Number.isSafeInteger(remainingCompressionBytes)
      || remainingCompressionBytes < 0
      || remainingCompressionBytes > MAX_BLOCK_COMPRESSION_INPUT_BYTES
      || serialized.byteLength === 0) {
      throw new BlockTransactionPayloadCodecError();
    }

    const originalLength = serialized.byteLength;
    const hash = createHash('sha256').update(serialized).digest('hex');
    let bytes = Buffer.from(serialized.buffer, serialized.byteOffset, originalLength);
    let mode: 'r' | 'd' = 'r';
    let compressionInputBytes = 0;
    if (originalLength <= MAX_COMPRESSED_TRANSACTION_BYTES && originalLength <= remainingCompressionBytes) {
      compressionInputBytes = originalLength;
      const compressed = deflateRawSync(bytes, { level: 1 });
      // Both tags have identical metadata length; compare without creating two strings.
      if (base64Length(compressed.byteLength) < base64Length(originalLength)) {
        bytes = compressed;
        mode = 'd';
      }
    }

    return { payload: `b1:${mode}:${originalLength}:${hash}:${bytes.toString('base64')}`, compressionInputBytes };
  } catch {
    throw new BlockTransactionPayloadCodecError();
  }
}

/** Only process-created cache values are supported; this is not a V8 schema validator. */
export function decodeBlockTransactionPayload(payload: string): unknown {
  try {
    const fields = payload.split(':');
    const [version, mode, lengthText, hash, encoded] = fields;
    if (fields.length !== 5 || version !== 'b1' || (mode !== 'r' && mode !== 'd')
      || lengthText === undefined || hash === undefined || encoded === undefined
      || !/^[1-9][0-9]*$/.test(lengthText)
      || hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new BlockTransactionPayloadCodecError();
    }

    const originalLength = Number(lengthText);
    if (!Number.isSafeInteger(originalLength) || String(originalLength) !== lengthText
      || (mode === 'd' && originalLength > MAX_COMPRESSED_TRANSACTION_BYTES)) {
      throw new BlockTransactionPayloadCodecError();
    }

    const rawBase64Length = base64Length(originalLength);
    if ((mode === 'r' && encoded.length !== rawBase64Length)
      || (mode === 'd' && encoded.length > rawBase64Length)
      || !isCanonicalBase64(encoded)) {
      throw new BlockTransactionPayloadCodecError();
    }

    const storedBytes = Buffer.from(encoded, 'base64');
    if (storedBytes.toString('base64') !== encoded) {
      throw new BlockTransactionPayloadCodecError();
    }
    let original = storedBytes;
    if (mode === 'd') {
      // Node returns this info shape, although its typings declare only Buffer.
      const inflated = inflateRawSync(storedBytes, { maxOutputLength: originalLength, info: true }) as unknown as {
        buffer: Buffer;
        engine: { readonly bytesWritten: number };
      };
      if (inflated.engine.bytesWritten !== storedBytes.byteLength) {
        throw new BlockTransactionPayloadCodecError();
      }
      original = inflated.buffer;
    }
    if (original.byteLength !== originalLength || createHash('sha256').update(original).digest('hex') !== hash) {
      throw new BlockTransactionPayloadCodecError();
    }
    return deserialize(original) as unknown;
  } catch {
    throw new BlockTransactionPayloadCodecError();
  }
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function isCanonicalBase64(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) return false;
  const paddingIndex = encoded.indexOf('=');
  if (paddingIndex === -1) return true;
  const padding = encoded.slice(paddingIndex);
  if (padding !== '=' && padding !== '==') return false;
  const lastValue = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(encoded[paddingIndex - 1] ?? '');
  return lastValue >= 0 && (lastValue & (padding.length === 2 ? 15 : 3)) === 0;
}

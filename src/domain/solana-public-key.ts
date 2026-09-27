const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MIN_PUBLIC_KEY_TEXT_BYTES = 32;
const MAX_PUBLIC_KEY_TEXT_BYTES = 44;
const PUBLIC_KEY_BYTES = 32;

const BASE58_VALUES = new Map(
  Array.from(BASE58_ALPHABET, (character, index) => [character, index] as const),
);

export function isCanonicalSolanaPublicKey(value: string): boolean {
  const textBytes = Buffer.byteLength(value, 'utf8');
  if (textBytes < MIN_PUBLIC_KEY_TEXT_BYTES || textBytes > MAX_PUBLIC_KEY_TEXT_BYTES
    || value !== value.trim()) return false;

  let leadingZeroBytes = 0;
  for (const character of value) {
    if (character !== '1') break;
    leadingZeroBytes += 1;
  }
  const decodedLittleEndian = [0];
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return false;
    let carry = digit;
    for (const [index, decoded] of decodedLittleEndian.entries()) {
      const next = decoded * 58 + carry;
      decodedLittleEndian.splice(index, 1, next & 0xff);
      carry = next >> 8;
    }
    while (carry > 0) {
      decodedLittleEndian.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const nonZeroBytes = decodedLittleEndian.length === 1 && decodedLittleEndian[0] === 0
    ? 0
    : decodedLittleEndian.length;
  return leadingZeroBytes + nonZeroBytes === PUBLIC_KEY_BYTES;
}

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const digits = new Map(Array.from(alphabet, (character, index) => [character, BigInt(index)]));

export function isSolanaPublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = digits.get(character);
    if (digit === undefined) return false;
    decoded = decoded * 58n + digit;
  }
  let decodedBytes = 0;
  for (let remaining = decoded; remaining > 0n; remaining >>= 8n) decodedBytes += 1;
  let leadingZeroBytes = 0;
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  return decodedBytes + leadingZeroBytes === 32;
}

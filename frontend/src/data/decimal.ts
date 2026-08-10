const DECIMAL_INTEGER = /^-?[0-9]+$/u;
const GROUP_SEPARATOR = '\u202f';

export class DecimalFormatError extends TypeError {
  public constructor() {
    super('La valeur entière décimale est invalide.');
    this.name = 'DecimalFormatError';
  }
}

export function formatInteger(raw: string): string {
  const value = parseInteger(raw);
  const canonical = value.toString();
  const negative = canonical.startsWith('-');
  const digits = negative ? canonical.slice(1) : canonical;
  const grouped = digits.replace(/\B(?=(?:[0-9]{3})+(?![0-9]))/gu, GROUP_SEPARATOR);
  return negative ? `-${grouped}` : grouped;
}

export function formatBasisPoints(raw: string): string {
  const value = parseInteger(raw);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}%`;
}

export function formatRawAmount(raw: string, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new DecimalFormatError();
  }
  const value = parseInteger(raw);
  const canonical = value.toString();
  if (decimals === 0) return canonical;
  const negative = canonical.startsWith('-');
  const digits = (negative ? canonical.slice(1) : canonical).padStart(decimals + 1, '0');
  const split = digits.length - decimals;
  const formatted = `${digits.slice(0, split)}.${digits.slice(split)}`;
  return negative ? `-${formatted}` : formatted;
}

function parseInteger(raw: string): bigint {
  if (!DECIMAL_INTEGER.test(raw)) throw new DecimalFormatError();
  try {
    return BigInt(raw);
  } catch {
    throw new DecimalFormatError();
  }
}

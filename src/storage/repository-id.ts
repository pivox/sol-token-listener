import { createHash } from 'node:crypto';

export function createRepositoryId(namespace: string, parts: readonly (string | number | bigint | null)[]): string {
  const canonical = parts.map((part) => {
    const value = part === null ? '<null>' : String(part);
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
  }).join('|');
  const digest = createHash('sha256').update(`${namespace}\u001f${canonical}`).digest('hex');
  return `${namespace}_${digest}`;
}

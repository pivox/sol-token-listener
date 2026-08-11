import type { ReactNode } from 'react';

export function ShortIdentifier({ value }: { readonly value: string }): ReactNode {
  if (value.length <= 16) return <code>{value}</code>;
  return <code title={value}>{value.slice(0, 8)}…{value.slice(-6)}</code>;
}

export function Timestamp({ value }: { readonly value: string | null }): ReactNode {
  if (value === null) return <span>Indisponible</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>Invalide</span>;
  return <time dateTime={value}>{date.toLocaleString('fr-FR')}</time>;
}

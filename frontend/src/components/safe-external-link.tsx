import type { ReactNode } from 'react';

export interface SafeExternalLinkProps {
  readonly href: string | null;
  readonly children: ReactNode;
}

export function SafeExternalLink({ href, children }: SafeExternalLinkProps): ReactNode {
  const safeHref = safeExternalUrl(href);
  if (safeHref === null) return <span>{children}</span>;
  return <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function safeExternalUrl(value: string | null): string | null {
  if (value?.trim() !== value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
  ) return null;
  return url.href;
}

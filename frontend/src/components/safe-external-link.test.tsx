import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeExternalLink } from './safe-external-link.js';

describe('safe external link', () => {
  it('opens only absolute HTTP(S) URLs with isolation attributes', () => {
    render(<SafeExternalLink href="https://project.example/path">Projet</SafeExternalLink>);
    const link = screen.getByRole('link', { name: 'Projet' });
    expect(link).toHaveAttribute('href', 'https://project.example/path');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each(['javascript:alert(1)', 'data:text/html,bad', '/relative', 'https://user:pass@example.com'])('renders unsafe URL %s as text', (href) => {
    render(<SafeExternalLink href={href}>Non fiable</SafeExternalLink>);
    expect(screen.queryByRole('link', { name: 'Non fiable' })).not.toBeInTheDocument();
    expect(screen.getByText('Non fiable')).toBeInTheDocument();
  });
});

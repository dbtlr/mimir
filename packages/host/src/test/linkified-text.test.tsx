import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LinkifiedText } from '../components/linkified-text';

describe('linkifiedText', () => {
  it('renders a URL as an anchor that opens in a new tab, with the text around it intact', () => {
    const { container } = render(
      <p>
        <LinkifiedText>Pick a variant from https://example.com/a/b.</LinkifiedText>
      </p>,
    );
    const link = screen.getByRole('link', { name: 'https://example.com/a/b' });
    expect(link.getAttribute('href')).toBe('https://example.com/a/b');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toBe('Pick a variant from https://example.com/a/b.');
  });

  it('renders text without a URL as plain text', () => {
    render(
      <p>
        <LinkifiedText>needs a token</LinkifiedText>
      </p>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('needs a token')).toBeDefined();
  });
});

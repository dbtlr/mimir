import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { BandSection } from '../components/band-section';
import type { BandGroup } from '../lib/attention-bands';
import { project } from './fixtures';

function band(over: Partial<BandGroup> & Pick<BandGroup, 'band' | 'label'>): BandGroup {
  return { projects: [project({ id: 'ONE' }), project({ id: 'TWO' })], ...over };
}

describe('bandSection', () => {
  it('renders the band label and its project count', () => {
    render(<BandSection band={band({ band: 'live', label: 'Live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('a non-collapsible band shows its cards directly', () => {
    render(<BandSection band={band({ band: 'live', label: 'Live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('ONE')).toBeDefined();
    expect(screen.getByText('TWO')).toBeDefined();
  });

  it('a collapsible band is a re-collapsible disclosure (aria-expanded toggles)', async () => {
    render(
      <BandSection
        band={band({ band: 'at_rest', label: 'At rest' })}
        onOpen={vi.fn()}
        collapsible
      />,
    );
    const toggle = screen.getByRole('button', { name: /at rest/i });
    // collapsed by default: cards absent, aria-expanded false
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ONE')).toBeNull();

    await userEvent.click(toggle);
    // expanded: cards visible, aria-expanded true
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ONE')).toBeDefined();
    expect(screen.getByText('TWO')).toBeDefined();

    await userEvent.click(toggle);
    // re-collapsed: cards hidden again (the old one-way expand would keep them)
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ONE')).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LaneSection } from '../components/lane-section';
import type { LaneGroup } from '../lib/lanes';
import { project } from './fixtures';

function lane(over: Partial<LaneGroup> & Pick<LaneGroup, 'lane' | 'label'>): LaneGroup {
  return { projects: [project({ id: 'ONE' }), project({ id: 'TWO' })], ...over };
}

describe('laneSection', () => {
  it('renders the lane label with its project count', () => {
    render(<LaneSection lane={lane({ label: 'Live', lane: 'live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('Live · 2')).toBeDefined();
  });

  it('a non-collapsible lane shows its cards directly', () => {
    render(<LaneSection lane={lane({ label: 'Live', lane: 'live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('project ONE')).toBeDefined();
    expect(screen.getByText('project TWO')).toBeDefined();
  });

  it('a collapsible lane folds to a key-chip strip, unfolding to the cards', async () => {
    render(
      <LaneSection
        lane={lane({ label: 'At rest', lane: 'at_rest' })}
        onOpen={vi.fn()}
        collapsible
      />,
    );
    const toggle = screen.getByRole('button', { name: /at rest/i });
    // folded: key chips present, cards (their titles) absent, aria-expanded false
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('ONE')).toBeDefined(); // key chip
    expect(screen.queryByText('project ONE')).toBeNull(); // card hidden

    await userEvent.click(toggle);
    // unfolded: cards visible, aria-expanded true
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('project ONE')).toBeDefined();
    expect(screen.getByText('project TWO')).toBeDefined();

    await userEvent.click(toggle);
    // re-folded: cards hidden again (the old one-way expand would keep them)
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('project ONE')).toBeNull();
  });
});

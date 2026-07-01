import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { LaneSection } from '../components/lane-section';
import type { LaneGroup } from '../lib/lanes';
import { project } from './fixtures';

function lane(over: Partial<LaneGroup> & Pick<LaneGroup, 'lane' | 'label'>): LaneGroup {
  return { projects: [project({ id: 'ONE' }), project({ id: 'TWO' })], ...over };
}

describe('laneSection', () => {
  it('renders the lane label and its project count', () => {
    render(<LaneSection lane={lane({ label: 'Live', lane: 'live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('a non-collapsible lane shows its cards directly', () => {
    render(<LaneSection lane={lane({ label: 'Live', lane: 'live' })} onOpen={vi.fn()} />);
    expect(screen.getByText('ONE')).toBeDefined();
    expect(screen.getByText('TWO')).toBeDefined();
  });

  it('a collapsible lane is a re-collapsible disclosure (aria-expanded toggles)', async () => {
    render(
      <LaneSection
        lane={lane({ label: 'At rest', lane: 'at_rest' })}
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

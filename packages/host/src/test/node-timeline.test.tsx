import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FeedList } from '../components/node-timeline';
import { buildFeed } from '../lib/timeline';
import type { HistoryEntry } from '../lib/timeline';

const blocked: HistoryEntry = {
  at: new Date('2026-06-04T09:00:00.000Z'),
  from: 'none',
  kind: 'hold',
  reason: 'Pick a variant from https://muninn.bifrost.lol/a/eHHTAO7KRz.',
  to: 'blocked',
};

describe('feedList transitions', () => {
  it('links a URL in a transition reason, opening in a new tab, with the text around it intact', () => {
    const items = buildFeed(new Date('2026-06-01T10:00:00.000Z'), [blocked], []);
    render(<FeedList items={items} pending={false} empty="nothing" />);

    const link = screen.getByRole('link', { name: 'https://muninn.bifrost.lol/a/eHHTAO7KRz' });
    expect(link.getAttribute('href')).toBe('https://muninn.bifrost.lol/a/eHHTAO7KRz');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.closest('p')?.textContent).toContain(
      ' — Pick a variant from https://muninn.bifrost.lol/a/eHHTAO7KRz.',
    );
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectCard } from '../components/project-card';
import { project } from './fixtures';

describe('projectCard row 1 (MMR-226)', () => {
  it('renders the key, title, and opens the project on click', async () => {
    const onOpen = vi.fn();
    render(
      <ProjectCard project={project({ id: 'MMR', title: 'Mimir' })} onOpen={onOpen} lane="live" />,
    );
    expect(screen.getByText('MMR')).toBeDefined();
    expect(screen.getByText('Mimir')).toBeDefined();
    await userEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('MMR');
  });
});

describe('projectCard leaf-count row (MMR-226)', () => {
  it('renders live/ready/review plus a folded held figure off the live lane', () => {
    render(
      <ProjectCard
        project={project({
          id: 'VIT',
          leaf_counts: { awaiting: 5, blocked: 2, in_progress: 3, ready: 4, under_review: 1 },
        })}
        onOpen={vi.fn()}
        lane="awaiting_you"
      />,
    );
    for (const label of ['live', 'ready', 'review', 'held']) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText('7')).toBeDefined(); // held = 5 awaiting + 2 blocked
  });

  it('trades held for a "moved …" recency tail on the live lane', () => {
    render(
      <ProjectCard
        project={project({
          attention: { lane: 'live', last_activity: '2026-06-20T00:00:00.000Z', stale: false },
          id: 'LGR',
          leaf_counts: { awaiting: 4, in_progress: 3, ready: 2 },
        })}
        onOpen={vi.fn()}
        lane="live"
      />,
    );
    expect(screen.getByText('live')).toBeDefined();
    expect(screen.getByText('ready')).toBeDefined();
    expect(screen.queryByText('held')).toBeNull();
    expect(screen.getByText(/^moved /)).toBeDefined();
  });
});

describe('projectCard per-lane signal (MMR-226)', () => {
  it('awaiting-you shows a pluralized verdict-waiting signal', () => {
    render(
      <ProjectCard
        project={project({ id: 'A', leaf_counts: { under_review: 2 } })}
        onOpen={vi.fn()}
        lane="awaiting_you"
      />,
    );
    expect(screen.getByText(/2 verdicts waiting/)).toBeDefined();
  });

  it('needs-unsticking shows a blocked signal', () => {
    render(
      <ProjectCard
        project={project({ id: 'B', leaf_counts: { blocked: 1 } })}
        onOpen={vi.fn()}
        lane="needs_unsticking"
      />,
    );
    expect(screen.getByText(/1 blocked/)).toBeDefined();
  });
});

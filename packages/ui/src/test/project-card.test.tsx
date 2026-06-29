import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ProjectCard } from '../components/project-card';
import { project } from './fixtures';

describe('projectCard going-cold marker', () => {
  it('a stale project shows a going-cold marker', () => {
    render(
      <ProjectCard
        project={project({
          attention: { band: 'live', last_activity: '2026-01-01T00:00:00.000Z', stale: true },
          id: 'COLD',
        })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/going cold/i)).toBeDefined();
  });

  it('a fresh project shows no going-cold marker', () => {
    render(
      <ProjectCard
        project={project({
          attention: { band: 'live', last_activity: '2026-06-20T00:00:00.000Z', stale: false },
          id: 'WARM',
        })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByText(/going cold/i)).toBeNull();
  });
});

describe('projectCard vitals panel (MMR-106)', () => {
  it('renders the five-count legend from leaf_counts', () => {
    render(
      <ProjectCard
        project={project({ id: 'VIT', leaf_counts: { blocked: 1, ready: 4, under_review: 2 } })}
        onOpen={vi.fn()}
      />,
    );
    for (const label of ['review', 'in prog', 'ready', 'await', 'blocked']) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText('2')).toBeDefined(); // under_review count
    expect(screen.getByText('4')).toBeDefined(); // ready count
  });

  it('omits the vitals panel entirely when leaf_counts is absent (degraded payload)', () => {
    render(<ProjectCard project={project({ id: 'BARE' })} onOpen={vi.fn()} />, {});
    expect(screen.queryByText('ready')).toBeNull();
  });
});

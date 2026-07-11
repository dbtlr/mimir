import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { WireArtifactSummary } from '../api/types';
import { ArtifactList } from '../components/artifact-list';

// Fixed clock (date only — timers stay real for userEvent): Fri 2026-06-19,
// so the week starts Mon 06-15 and 06-12 falls in LAST WEEK.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 19, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

const items: WireArtifactSummary[] = [
  {
    created_at: new Date(2026, 5, 18).toISOString(),
    id: 'MMR-a8',
    project: 'MMR',
    tags: ['kind:spec'],
    title: 'Artifacts browser',
  },
  {
    created_at: new Date(2026, 5, 12).toISOString(),
    id: 'NOVA-a1',
    project: 'NOVA',
    tags: [],
    title: 'Nova kickoff',
  },
  {
    created_at: new Date(2026, 3, 2).toISOString(),
    id: 'MMR-a2',
    project: 'MMR',
    tags: ['kind:session'],
    title: 'Session log',
  },
];

describe('artifactList', () => {
  it('groups rows by recency with microlabel headers', () => {
    render(<ArtifactList items={items} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'THIS WEEK' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'LAST WEEK' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'APRIL 2026' })).toBeDefined();
  });

  it('group headers are mono, built from raw utilities (not .microlabel, which pins sans)', () => {
    render(<ArtifactList items={items} selectedId={undefined} onSelect={vi.fn()} />);
    const heading = screen.getByRole('heading', { name: 'THIS WEEK' });
    expect(heading.className).toContain('font-mono');
    // `.microlabel` is unlayered CSS whose font-sans beats the layered
    // font-mono utility — it must not appear alongside font-mono.
    expect(heading.className).not.toContain('microlabel');
  });

  it('older rows demote only the title — the meta line keeps full contrast', () => {
    render(<ArtifactList items={items} selectedId={undefined} onSelect={vi.fn()} />);
    // 'Session log' (April) is older than last week → demoted.
    const row = screen.getByRole('button', { name: /Session log/ });
    expect(row.className).not.toContain('opacity');
    const title = screen.getByText('Session log');
    expect(title.className).toContain('dark:opacity-75');
    expect(title.className).toContain('light:text-ink');
    // Recent rows are not demoted at all.
    expect(screen.getByText('Artifacts browser').className).not.toContain('opacity');
  });

  it('a row carries title and the project · kind · date meta line', () => {
    render(<ArtifactList items={items} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /MMR · spec · 06-18/ })).toBeDefined();
    // No kind: tag → the kind segment is omitted, never blank.
    expect(screen.getByRole('button', { name: /NOVA · 06-12/ })).toBeDefined();
  });

  it('selecting a row fires onSelect', async () => {
    const onSelect = vi.fn();
    render(<ArtifactList items={items} selectedId={undefined} onSelect={onSelect} />);
    await userEvent.click(screen.getByText('Nova kickoff'));
    expect(onSelect).toHaveBeenCalledWith('NOVA-a1');
  });

  it('the selected row reads aria-current and "frozen <date>"', () => {
    render(<ArtifactList items={items} selectedId="MMR-a8" onSelect={vi.fn()} />);
    const selected = screen.getByRole('button', { name: /frozen 06-18/ });
    expect(selected).toHaveAttribute('aria-current', 'true');
  });

  it('empty state when no artifacts', () => {
    render(<ArtifactList items={[]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText(/no artifacts/i)).toBeDefined();
  });
});

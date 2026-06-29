import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import type { WireArtifactSummary } from '../api/types';
import { ArtifactList } from '../components/artifact-list';

const items: WireArtifactSummary[] = [
  {
    created_at: '2026-06-16T00:00:00.000Z',
    id: 'MMR-a8',
    project: 'MMR',
    tags: ['kind:spec'],
    title: 'Artifacts browser',
  },
  {
    created_at: '2026-06-10T00:00:00.000Z',
    id: 'NOVA-a1',
    project: 'NOVA',
    tags: [],
    title: 'Nova kickoff',
  },
];

describe('artifactList', () => {
  it('renders a row per artifact and selecting fires onSelect', async () => {
    const onSelect = vi.fn();
    render(<ArtifactList items={items} selectedId={undefined} onSelect={onSelect} />);
    expect(screen.getByText('Artifacts browser')).toBeDefined();
    expect(screen.getByText('NOVA-a1')).toBeDefined();
    await userEvent.click(screen.getByText('Nova kickoff'));
    expect(onSelect).toHaveBeenCalledWith('NOVA-a1');
  });

  it('empty state when no artifacts', () => {
    render(<ArtifactList items={[]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText(/no artifacts/i)).toBeDefined();
  });
});

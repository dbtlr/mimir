import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, vi } from 'vitest';

import { ArtifactReader } from '../components/artifact-reader';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('artifactReader', () => {
  it('renders the markdown body, metadata, and backlinks', async () => {
    apiGet.mockResolvedValue({
      content: '# Heading\n\n- one\n- two\n',
      created_at: '2026-06-16T00:00:00.000Z',
      id: 'MMR-a8',
      links: ['MMR-52'],
      project: 'MMR',
      tags: ['kind:spec'],
      title: 'Artifacts browser',
    });
    render(<ArtifactReader id="MMR-a8" onBack={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await expect(screen.findByRole('heading', { name: 'Heading' })).resolves.toBeDefined();
    expect(screen.getByText('one')).toBeDefined();
    expect(screen.getByText('Artifacts browser')).toBeDefined();
    expect(screen.getByText('MMR-52')).toBeDefined();
  });

  it('back fires onBack', async () => {
    apiGet.mockResolvedValue({
      content: 'body',
      created_at: '2026-06-16T00:00:00.000Z',
      id: 'MMR-a8',
      links: [],
      project: 'MMR',
      tags: [],
      title: 'x',
    });
    const onBack = vi.fn();
    render(<ArtifactReader id="MMR-a8" onBack={onBack} onOpenNode={vi.fn()} />, { wrapper });
    await screen.findByText('body');
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it('backlink click opens the node', async () => {
    apiGet.mockResolvedValue({
      content: 'body',
      created_at: '2026-06-16T00:00:00.000Z',
      id: 'MMR-a8',
      links: ['MMR-52'],
      project: 'MMR',
      tags: [],
      title: 'x',
    });
    const onOpenNode = vi.fn();
    render(<ArtifactReader id="MMR-a8" onBack={vi.fn()} onOpenNode={onOpenNode} />, { wrapper });
    await userEvent.click(await screen.findByText('MMR-52'));
    expect(onOpenNode).toHaveBeenCalledWith('MMR-52');
  });
});

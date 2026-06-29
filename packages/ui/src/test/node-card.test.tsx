import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, vi } from 'vitest';

import { NodeCard } from '../components/node-card';
import { task } from './fixtures';

vi.mock('../api/mutations', () => ({ useTransition: () => ({ mutate: vi.fn() }) }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('nodeCard', () => {
  it('opens the node when the title region is clicked', async () => {
    const onOpen = vi.fn();
    render(<NodeCard node={task({ id: 'MMR-9', status: 'ready' })} onOpen={onOpen} />, { wrapper });
    await userEvent.click(screen.getByText('task MMR-9'));
    expect(onOpen).toHaveBeenCalledWith('MMR-9');
  });

  it('shows the actions kebab for a live card', () => {
    render(<NodeCard node={task({ id: 'MMR-9', status: 'ready' })} onOpen={vi.fn()} />, {
      wrapper,
    });
    expect(screen.getByLabelText('Actions')).toBeDefined();
  });

  it('offline disables the actions kebab', () => {
    render(<NodeCard node={task({ id: 'MMR-9', status: 'ready' })} onOpen={vi.fn()} offline />, {
      wrapper,
    });
    expect(screen.getByLabelText('Actions')).toHaveProperty('disabled', true);
  });

  it('a done card shows the kebab — terminal cards offer Reopen (MMR-104)', () => {
    render(<NodeCard node={task({ id: 'MMR-9', status: 'done' })} onOpen={vi.fn()} />, { wrapper });
    expect(screen.queryByLabelText('Actions')).not.toBeNull();
  });

  it('shows the ancestry breadcrumb when provided', () => {
    render(
      <NodeCard
        node={task({ id: 'MMR-9', status: 'ready' })}
        onOpen={vi.fn()}
        ancestry="Build › Phase 5"
      />,
      { wrapper },
    );
    expect(screen.getByText('Build › Phase 5')).toBeDefined();
  });

  it('renders no breadcrumb when ancestry is empty or absent', () => {
    render(
      <NodeCard node={task({ id: 'MMR-9', status: 'ready' })} onOpen={vi.fn()} ancestry="" />,
      { wrapper },
    );
    expect(screen.queryByText('Build › Phase 5')).toBeNull();
  });

  const sortable = { handleProps: {}, setNodeRef: () => {} };

  it('renders the grip handle when sortable', () => {
    render(
      <NodeCard
        node={task({ id: 'MMR-9', status: 'ready' })}
        onOpen={vi.fn()}
        sortable={sortable}
      />,
      {
        wrapper,
      },
    );
    expect(screen.getByLabelText('Reorder')).toBeDefined();
  });

  it('offline hides the grip handle even when sortable', () => {
    render(
      <NodeCard
        node={task({ id: 'MMR-9', status: 'ready' })}
        onOpen={vi.fn()}
        sortable={sortable}
        offline
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText('Reorder')).toBeNull();
  });

  it('no grip when not sortable (held/done columns)', () => {
    render(<NodeCard node={task({ id: 'MMR-9', status: 'ready' })} onOpen={vi.fn()} />, {
      wrapper,
    });
    expect(screen.queryByLabelText('Reorder')).toBeNull();
  });
});

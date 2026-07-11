import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireNode, WireTreeNode } from '../api/types';
import { TreeView } from '../components/tree';
import { task } from './fixtures';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('../api/mutations', () => ({
  useTransition: () => ({ mutate }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

/** A leaf task tree node (no children). */
function leaf(overrides: Partial<WireNode> & { status: WireNode['status'] }): WireTreeNode {
  return { ...task(overrides), children: [] };
}

/** A container tree node (initiative/phase/project) with its children. */
function branch(
  overrides: Partial<WireNode> & { status: WireNode['status'] },
  children: WireTreeNode[],
): WireTreeNode {
  return { ...task(overrides), children };
}

function project(children: WireTreeNode[]): WireTreeNode {
  return branch({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, children);
}

beforeEach(() => {
  mutate.mockClear();
});

describe('treeView', () => {
  it('renders the empty state verbatim for a childless project', () => {
    render(<TreeView root={project([])} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('An empty project.')).toBeDefined();
  });

  it('renders an initiative header, a phase panel, and its leaf rows', () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'Build the thing', type: 'initiative' }, [
        branch(
          {
            distribution: { in_progress: 1 },
            id: 'MMR-3',
            status: 'in_progress',
            title: 'Scaffold',
            type: 'phase',
          },
          [leaf({ id: 'MMR-10', status: 'ready', title: 'wire it up' })],
        ),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });

    expect(screen.getByText('INITIATIVE')).toBeDefined();
    expect(screen.getByText('Build the thing')).toBeDefined();
    expect(screen.getByText('Scaffold')).toBeDefined();
    expect(screen.getByText('MMR-3')).toBeDefined();
    expect(screen.getByText('wire it up')).toBeDefined();
    // leaf trailing status word
    expect(screen.getByText('Ready')).toBeDefined();
  });

  it('derives the initiative leaf-count summary from the distribution', () => {
    const root = project([
      branch(
        {
          distribution: { done: 3, ready: 2, under_review: 1 },
          id: 'MMR-2',
          status: 'in_progress',
          title: 'Build',
          type: 'initiative',
        },
        [branch({ id: 'MMR-3', status: 'in_progress', title: 'P', type: 'phase' }, [])],
      ),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('3 done · 2 live · 1 review')).toBeDefined();
  });

  it('reads a standing home as STANDING / OPEN FOR FILING with ∞, never a leaf-count summary', () => {
    const root = project([
      branch(
        {
          distribution: { ready: 2 },
          id: 'MMR-9',
          open_ended: true,
          status: 'in_progress',
          title: 'Storage',
          type: 'initiative',
        },
        [leaf({ id: 'MMR-30', status: 'ready', title: 'file me' })],
      ),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('STANDING')).toBeDefined();
    expect(screen.getByText('OPEN FOR FILING')).toBeDefined();
    expect(screen.getByText('∞')).toBeDefined();
    // the "2 live" headline the leaf-count summary would build is suppressed
    expect(screen.queryByText('2 live')).toBeNull();
  });

  it('rewrites the phase interpreted word for in_progress to IN MOTION', () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'Live phase', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'in_progress', title: 'a' }),
        ]),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('IN MOTION')).toBeDefined();
  });

  it('opens the node when a leaf row is clicked', async () => {
    const onOpen = vi.fn();
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'P', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'ready', title: 'open me' }),
        ]),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={onOpen} />, { wrapper });
    await userEvent.click(screen.getByText('open me'));
    expect(onOpen).toHaveBeenCalledWith('MMR-10');
  });

  function underReviewTree(): WireTreeNode {
    return project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'P', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'under_review', title: 'needs a look' }),
        ]),
      ]),
    ]);
  }

  it('an under-review leaf carries inline Approve / Return and its status word', () => {
    render(<TreeView root={underReviewTree()} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Return…' })).toBeDefined();
    expect(screen.getByText('Under review')).toBeDefined();
  });

  it('inline Approve fires the done verb', async () => {
    render(<TreeView root={underReviewTree()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mutate).toHaveBeenCalledWith({ verb: 'done' });
  });

  it('inline Return opens the reason dialog and mutates with the return verb', async () => {
    render(<TreeView root={underReviewTree()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Return…' }));
    await userEvent.type(await screen.findByRole('textbox'), 'needs tests');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(mutate).toHaveBeenCalledWith({ reason: 'needs tests', verb: 'return' });
  });

  it('offline inerts the inline verdict buttons', () => {
    render(<TreeView root={underReviewTree()} onOpenNode={vi.fn()} offline />, { wrapper });
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Return…' })).toHaveProperty('disabled', true);
  });

  it('folds consecutive done phases into one recessed row with an ordinal range and count', () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch(
          { distribution: { done: 5 }, id: 'MMR-3', status: 'done', title: 'A', type: 'phase' },
          [leaf({ id: 'MMR-10', status: 'done', title: 'a' })],
        ),
        branch(
          { distribution: { done: 3 }, id: 'MMR-4', status: 'done', title: 'B', type: 'phase' },
          [leaf({ id: 'MMR-11', status: 'done', title: 'b' })],
        ),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('Phases 0–1')).toBeDefined();
    expect(screen.getByText('DONE · 8')).toBeDefined();
  });

  it('folds a panel’s parked leaves into one trailing row', () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'P', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'ready', title: 'live one' }),
          leaf({ id: 'MMR-11', status: 'parked', title: 'p1' }),
          leaf({ id: 'MMR-12', status: 'parked', title: 'p2' }),
        ]),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('2 parked · expand')).toBeDefined();
  });

  it('the parked fold row flips its label and chevron state when expanded', async () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'I', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'P', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'ready', title: 'live one' }),
          leaf({ id: 'MMR-11', status: 'parked', title: 'p1' }),
        ]),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    const toggle = screen.getByText('1 parked · expand');
    expect(toggle.closest('button')).toHaveProperty('ariaExpanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByText('1 parked · collapse')).toBeDefined();
    expect(screen.getByText('1 parked · collapse').closest('button')).toHaveProperty(
      'ariaExpanded',
      'true',
    );
  });

  it('marks disclosure headers with aria-expanded', () => {
    const root = project([
      branch({ id: 'MMR-2', status: 'in_progress', title: 'Init', type: 'initiative' }, [
        branch({ id: 'MMR-3', status: 'in_progress', title: 'Phase', type: 'phase' }, [
          leaf({ id: 'MMR-10', status: 'ready', title: 'a' }),
        ]),
      ]),
    ]);
    render(<TreeView root={root} onOpenNode={vi.fn()} />, { wrapper });
    // both the initiative header and the (default-open) phase header expose state
    for (const name of ['Init', 'Phase']) {
      expect(screen.getByText(name).closest('button')).toHaveProperty('ariaExpanded', 'true');
    }
  });

  it('opens the node when the trailing status word of an under-review row is clicked', async () => {
    const onOpen = vi.fn();
    render(<TreeView root={underReviewTree()} onOpenNode={onOpen} />, { wrapper });
    await userEvent.click(screen.getByText('Under review'));
    expect(onOpen).toHaveBeenCalledWith('MMR-10');
  });
});

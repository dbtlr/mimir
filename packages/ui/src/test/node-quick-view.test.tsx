import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { WireNode } from '../api/types';
import { QuickShelf, QuickViewPanel } from '../components/node-quick-view';
import { task } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

const mutate = vi.fn();
vi.mock('../api/mutations', () => ({ useTransition: () => ({ mutate }) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The panel's exit-slide duration (mirrors CLOSE_MS in the component). */
const CLOSE_MS = 180;

/** Stub `matchMedia` to a fixed `matches` — the panel's Esc guard reads it. */
function stubMatchMedia(matches: boolean): void {
  globalThis.matchMedia = ((query: string) =>
    ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }) as MediaQueryList) as typeof globalThis.matchMedia;
}

/** Resolve the detail + annotations fetches the open quick view fires. */
function mockDetail(detail: WireNode) {
  apiGet.mockImplementation((path: string) =>
    path.endsWith('/annotations')
      ? Promise.resolve({ items: [], total: 0 })
      : Promise.resolve(detail),
  );
}

describe('quickViewPanel — desktop drop panel', () => {
  it('clicking Approve runs the done verb for an under-review node', async () => {
    mutate.mockClear();
    const node = task({ id: 'MMR-30', status: 'under_review', title: 'sign off' });
    mockDetail(node);
    render(<QuickViewPanel node={node} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByText('Approve'));
    expect(mutate).toHaveBeenCalledWith({ verb: 'done' });
  });

  it('clicking Return… opens the reason dialog rather than mutating immediately', async () => {
    mutate.mockClear();
    const node = task({ id: 'MMR-31', status: 'under_review', title: 'sign off' });
    mockDetail(node);
    render(<QuickViewPanel node={node} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByText('Return…'));
    expect(screen.getByPlaceholderText(/context for the next agent/i)).toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('the Full dossier link routes via onOpenNode', async () => {
    const onOpenNode = vi.fn();
    const node = task({ id: 'MMR-32', status: 'ready', title: 'preview me' });
    mockDetail(node);
    render(<QuickViewPanel node={node} onClose={vi.fn()} onOpenNode={onOpenNode} />, { wrapper });
    await userEvent.click(screen.getByText('Full dossier ↗'));
    expect(onOpenNode).toHaveBeenCalledWith('MMR-32');
  });

  it('a non-under-review node shows the status context, not the verdict buttons', () => {
    const node = task({ id: 'MMR-33', status: 'ready', title: 'preview me' });
    mockDetail(node);
    render(<QuickViewPanel node={node} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.getByText('Ready')).toBeDefined();
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('offline inerts Approve', () => {
    const node = task({ id: 'MMR-34', status: 'under_review', title: 'sign off' });
    mockDetail(node);
    render(<QuickViewPanel node={node} onClose={vi.fn()} onOpenNode={vi.fn()} offline />, {
      wrapper,
    });
    expect(screen.getByText('Approve')).toHaveProperty('disabled', true);
  });

  it('esc closes the panel on a desktop viewport (deferred by the exit slide)', async () => {
    const original = globalThis.matchMedia;
    stubMatchMedia(true);
    try {
      const onClose = vi.fn();
      const node = task({ id: 'MMR-35', status: 'ready', title: 'preview me' });
      mockDetail(node);
      render(<QuickViewPanel node={node} onClose={onClose} onOpenNode={vi.fn()} />, { wrapper });
      await userEvent.keyboard('{Escape}');
      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it('the panel Esc handler no-ops below md, so it cannot close the mobile shelf', () => {
    // The default test matchMedia reports no match (mobile) — the shared panel
    // is always mounted, and its Esc listener must not close the shelf (MMR-223 §6).
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const node = task({ id: 'MMR-36', status: 'ready', title: 'preview me' });
      mockDetail(node);
      render(<QuickViewPanel node={node} onClose={onClose} onOpenNode={vi.fn()} />, { wrapper });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      vi.advanceTimersByTime(CLOSE_MS + 40);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('quickShelf — mobile shelf', () => {
  it('the primary verb runs the first legal transition', async () => {
    mutate.mockClear();
    const node = task({ id: 'MMR-8', status: 'ready', title: 'go' });
    mockDetail(node);
    render(<QuickShelf node={node} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    // availableTransitions('ready')[0] === 'start'
    await userEvent.click(screen.getByText('Start'));
    expect(mutate).toHaveBeenCalledWith({ verb: 'start' });
  });

  it('the Verbs… menu surfaces the remaining transitions (park needs a reason)', async () => {
    mutate.mockClear();
    const node = task({ id: 'MMR-9', status: 'ready', title: 'go' });
    mockDetail(node);
    render(<QuickShelf node={node} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByText('Verbs…'));
    await userEvent.click(await screen.findByText('Park'));
    // Park carries a reason → the dialog opens instead of an immediate mutate.
    expect(screen.getByPlaceholderText(/context for the next agent/i)).toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('the Dossier ↗ button routes via onOpenNode', async () => {
    const onOpenNode = vi.fn();
    const node = task({ id: 'MMR-10', status: 'ready', title: 'go' });
    mockDetail(node);
    render(<QuickShelf node={node} onClose={vi.fn()} onOpenNode={onOpenNode} />, { wrapper });
    await userEvent.click(screen.getByText('Dossier ↗'));
    expect(onOpenNode).toHaveBeenCalledWith('MMR-10');
  });

  it('closing via ✕ calls onClose after the exit animation', async () => {
    const onClose = vi.fn();
    const node = task({ id: 'MMR-11', status: 'ready', title: 'go' });
    mockDetail(node);
    render(<QuickShelf node={node} onClose={onClose} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Close quick view' }));
    // Close plays a 180ms slide-down before the parent unmounts, so onClose fires deferred.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('offline inerts the verb buttons', () => {
    const node = task({ id: 'MMR-12', status: 'ready', title: 'go' });
    mockDetail(node);
    render(<QuickShelf node={node} onClose={vi.fn()} onOpenNode={vi.fn()} offline />, { wrapper });
    expect(screen.getByText('Start')).toHaveProperty('disabled', true);
    expect(screen.getByText('Verbs…')).toHaveProperty('disabled', true);
  });
});

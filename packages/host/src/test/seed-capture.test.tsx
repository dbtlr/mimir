import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { seedCreate } from '../api/fns/browse';
import { routeTree } from '../router';
import { engineSeed } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveBareRecords } from './node-fns';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

// The project gate and the task pages these cases open read the record by server function.
beforeEach(() => {
  serveViews();
  serveBareRecords();
});
const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function mockApi() {
  serveShell({
    projects: [
      engineProject({ id: 'MMR', title: 'Mimir' }),
      engineProject({ id: 'NRN', status: 'ready', title: 'Norn' }),
    ],
  });
  serveBrowse();
}

function renderApp(initial = '/p/MMR/seeds') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree,
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } })
      }
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

describe('seed capture popover (12c, MMR-247)', () => {
  it('files the right body (project/title/kind, no requester) and resets on success', async () => {
    mockApi();
    vi.mocked(seedCreate).mockResolvedValue(engineSeed({ id: 'MMR-s7' }));
    renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    // the popover is up
    await screen.findByLabelText('Seed');

    await user.click(screen.getByRole('button', { name: 'bug' }));
    await user.type(screen.getByLabelText('Seed'), 'Tree lens loses scroll');
    await user.click(screen.getByRole('button', { name: 'File ↵' }));

    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledWith({
        data: { kind: 'bug', project: 'MMR', title: 'Tree lens loses scroll' },
      });
    });
    // never carries requester — a console-filed seed is self-filed
    expect(vi.mocked(seedCreate).mock.calls[0]?.[0].data).not.toHaveProperty('requester');
    // success toasts and the popover closes (fields reset behind it)
    expect(toast.success).toHaveBeenCalledWith('Filed MMR-s7');
    await waitFor(() => {
      expect(screen.queryByLabelText('Seed')).toBeNull();
    });
  });

  it('enter files; Shift+Enter adds a body line — the whole blob rides `title` (MMR-263)', async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    const field = await screen.findByLabelText('Seed');
    await user.click(screen.getByRole('button', { name: 'bug' }));

    await user.type(field, 'title line');
    // Shift+Enter inserts a newline — it must NOT file.
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(field, 'body line');
    expect(seedCreate).not.toHaveBeenCalled();

    // A bare Enter files the whole capture blob as `title` (the Engine splits it).
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledWith({
        data: { kind: 'bug', project: 'MMR', title: 'title line\nbody line' },
      });
    });
  });

  it('opens on the global `s` hotkey', async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Seeds' });

    await user.keyboard('s');
    await expect(screen.findByLabelText('Seed')).resolves.toBeDefined();
  });
});

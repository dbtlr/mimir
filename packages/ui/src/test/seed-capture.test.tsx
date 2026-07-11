import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, vi } from 'vitest';

import { router } from '../router';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function mockApi() {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/health') {
      return Promise.resolve({ schema: 1, status: 'ok', version: '0.0.0' });
    }
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [
          { id: 'MMR', status: 'in_progress', title: 'Mimir' },
          { id: 'NRN', status: 'ready', title: 'Norn' },
        ],
        total: 2,
      });
    }
    if (path.startsWith('/api/seeds?')) {
      return Promise.resolve({ items: [], total: 0 });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderApp(initial = '/seeds') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
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
    apiSend.mockResolvedValue({ id: 'MMR-s7' });
    renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    // the popover is up
    await screen.findByLabelText('Title');

    await user.click(screen.getByRole('button', { name: 'bug' }));
    await user.type(screen.getByLabelText('Title'), 'Tree lens loses scroll');
    await user.click(screen.getByRole('button', { name: 'File ↵' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds', {
        kind: 'bug',
        project: 'MMR',
        title: 'Tree lens loses scroll',
      });
    });
    // never carries requester — a console-filed seed is self-filed
    const body = apiSend.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('requester');
    // success toasts and the popover closes (fields reset behind it)
    expect(toast.success).toHaveBeenCalledWith('Filed MMR-s7');
    await waitFor(() => {
      expect(screen.queryByLabelText('Title')).toBeNull();
    });
  });

  it('opens on the global `s` hotkey', async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Seeds' });

    await user.keyboard('s');
    await expect(screen.findByLabelText('Title')).resolves.toBeDefined();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { NodeDrawer } from '../components/node-drawer';
import { task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (orig) => ({
  // import() type captures the whole module for orig<>(); no clean type-import equiv
  // oxlint-disable-next-line typescript/consistent-type-imports
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('nodeDrawer', () => {
  it('renders the full record with annotations and artifact titles', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-16') {
        return Promise.resolve(
          task({
            artifacts: [
              {
                id: 'MMR-a3',
                title: 'console design notes',
                tags: [],
                created_at: '2026-06-10T00:00:00.000Z',
              },
            ],
            deps: {
              blocking: [{ id: 'MMR-51', status: 'awaiting' }],
              depends_on: [{ id: 'MMR-15', status: 'done' }],
            },
            id: 'MMR-16',
            priority: 'p1',
            size: 'large',
            status: 'in_progress',
            tags: [{ tag: 'release:v0.5', note: null, created_at: '2026-06-10T00:00:00.000Z' }],
            title: 'Web UI chunk 1',
          }),
        );
      }
      if (path === '/api/nodes/MMR-16/annotations') {
        return Promise.resolve({
          items: [
            {
              content: 'Groomed: read-only console first.',
              created_at: '2026-06-10T01:00:00.000Z',
            },
          ],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(<NodeDrawer nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await expect(screen.findByText('Web UI chunk 1')).resolves.toBeDefined();
    await expect(screen.findByText('Groomed: read-only console first.')).resolves.toBeDefined();
    await expect(screen.findByText('console design notes')).resolves.toBeDefined();
    expect(screen.getByText('MMR-15')).toBeDefined();
    expect(screen.getByText('MMR-51')).toBeDefined();
    expect(screen.getByText('release:v0.5')).toBeDefined();
    expect(screen.getByText('p1')).toBeDefined();
    expect(screen.getByText('In progress')).toBeDefined();
  });

  it('timeline merges transitions + annotations oldest-first, with the creation anchor', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-60') {
        return Promise.resolve(
          task({
            created_at: '2026-06-01T10:00:00.000Z',
            history: [
              {
                kind: 'lifecycle',
                from: 'todo',
                to: 'in_progress',
                at: '2026-06-02T09:00:00.000Z',
                reason: null,
              },
              {
                kind: 'hold',
                from: 'none',
                to: 'parked',
                at: '2026-06-04T09:00:00.000Z',
                reason: 'waiting on Saga',
              },
            ],
            id: 'MMR-60',
            status: 'parked',
            title: 'task timeline',
          }),
        );
      }
      if (path === '/api/nodes/MMR-60/annotations') {
        return Promise.resolve({
          items: [{ content: 'looked into the facet', created_at: '2026-06-03T09:00:00.000Z' }],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(<NodeDrawer nodeId="MMR-60" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    // default "All" tab: every event, humanized (scoped to the feed rows —
    // "Parked" also appears as the header status badge)
    await screen.findByText('Created');
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const idx = (needle: string) => rows.findIndex((t) => t.includes(needle));
    expect(idx('Started')).toBeGreaterThanOrEqual(0);
    expect(idx('Parked')).toBeGreaterThanOrEqual(0);
    expect(idx('waiting on Saga')).toBeGreaterThanOrEqual(0);

    // chronological order, oldest-first
    expect(idx('Created')).toBeLessThan(idx('Started'));
    expect(idx('Started')).toBeLessThan(idx('looked into the facet'));
    expect(idx('looked into the facet')).toBeLessThan(idx('Parked'));
  });

  it('timeline tabs split the feed: Activity hides notes, Notes hides transitions', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-60') {
        return Promise.resolve(
          task({
            history: [
              {
                kind: 'lifecycle',
                from: 'todo',
                to: 'in_progress',
                at: '2026-06-02T09:00:00.000Z',
                reason: null,
              },
            ],
            id: 'MMR-60',
            status: 'in_progress',
            title: 'task timeline',
          }),
        );
      }
      if (path === '/api/nodes/MMR-60/annotations') {
        return Promise.resolve({
          items: [{ content: 'a freeform note', created_at: '2026-06-03T09:00:00.000Z' }],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(<NodeDrawer nodeId="MMR-60" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await userEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Started')).toBeDefined();
    expect(screen.queryByText('a freeform note')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByText('a freeform note')).toBeDefined();
    expect(screen.queryByText('Started')).toBeNull();
  });

  it('closed drawer renders nothing', () => {
    render(<NodeDrawer nodeId={undefined} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.queryByTestId('drawer-body')).toBeNull();
  });

  it('shows the transition kebab for a live node', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-51') {
        return Promise.resolve(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
      }
      if (path === '/api/nodes/MMR-51/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await expect(screen.findByLabelText('Actions')).resolves.toBeDefined();
  });

  it("offline disables the drawer's transition kebab", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-51') {
        return Promise.resolve(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
      }
      if (path === '/api/nodes/MMR-51/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await expect(screen.findByLabelText('Actions')).resolves.toHaveProperty('disabled', true);
  });

  it('edit button toggles the drawer into the task form, prefilled with node values', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-51') {
        return Promise.resolve(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2 edit test' }));
      }
      if (path === '/api/nodes/MMR-51/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    // Wait for data to load
    await screen.findByText('Chunk 2 edit test');
    // Click the Edit button
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    // Task form should be visible with the title prefilled
    const titleInput = screen.getByLabelText(/title/i);
    expect(titleInput).toBeDefined();
    expect((titleInput as HTMLInputElement).value).toBe('Chunk 2 edit test');
    // Save button should be present
    expect(screen.getByRole('button', { name: /save/i })).toBeDefined();
  });

  it('edit PATCH omits empty optional fields (no null values sent to server)', async () => {
    // Fixture: task with null description and external_ref (the default fixture state)
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-65') {
        return Promise.resolve(
          task({
            description: null,
            external_ref: null,
            id: 'MMR-65',
            status: 'ready',
            title: 'Regression task',
          }),
        );
      }
      if (path === '/api/nodes/MMR-65/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    // apiSend must resolve so the mutate call succeeds
    apiSend.mockResolvedValue({ id: 'MMR-65' });

    render(<NodeDrawer nodeId="MMR-65" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });

    await screen.findByText('Regression task');
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    // Save immediately without changing any fields
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // The PATCH body must NOT include description:null or external_ref:null
    expect(apiSend).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/api/nodes/'),
      expect.not.objectContaining({ description: null }),
    );
    expect(apiSend).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/api/nodes/'),
      expect.not.objectContaining({ external_ref: null }),
    );
  });

  it('edit button is absent when offline', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-51') {
        return Promise.resolve(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
      }
      if (path === '/api/nodes/MMR-51/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('Chunk 2');
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('clicking an artifact navigates to the reader with provenance', async () => {
    navigate.mockClear();
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-16') {
        return Promise.resolve(
          task({
            artifacts: [
              {
                id: 'MMR-a3',
                title: 'console notes',
                tags: [],
                created_at: '2026-06-10T00:00:00.000Z',
              },
            ],
            id: 'MMR-16',
            status: 'in_progress',
            title: 'chunk 1',
          }),
        );
      }
      if (path === '/api/nodes/MMR-16/annotations') {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(await screen.findByText('console notes'));
    expect(navigate).toHaveBeenCalledWith({
      search: { a: 'MMR-a3', from: 'MMR-16' },
      to: '/artifacts',
    });
  });
});

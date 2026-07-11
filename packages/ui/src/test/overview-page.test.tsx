import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireAttention } from '../api/types';
import { router } from '../router';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

function attn(lane: WireAttention['lane'], lastActivity: string, stale = false): WireAttention {
  return { lane, last_activity: lastActivity, stale };
}

function proj(id: string, attention?: WireAttention) {
  return { attention, distribution: {}, id, status: 'in_progress', title: `${id} project` };
}

function archivedProj(id: string) {
  return {
    archived_at: '2026-06-30T12:00:00.000Z',
    artifact_count: 12,
    distribution: {},
    id,
    leaf_counts: { done: 40, ready: 1 },
    status: 'done',
    title: `${id} project`,
  };
}

function renderOverview() {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('overviewPage attention-router (MMR-102)', () => {
  it('renders the populated lanes in highest-wins order, At rest collapsed', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [
            proj('REVIEW', attn('awaiting_you', '2026-06-20T00:00:00.000Z')),
            proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z')),
            proj('RESTED', attn('at_rest', '2026-06-01T00:00:00.000Z')),
          ],
          total: 3,
        });
      }
      return Promise.resolve({ items: [], total: 0 }); // ready + attention strips
    });
    renderOverview();

    await expect(screen.findByText('Awaiting you · 1')).resolves.toBeDefined();
    expect(screen.getByText('Live · 1')).toBeDefined();
    // needs_unsticking has no members → its header is omitted
    expect(screen.queryByText(/Needs unsticking/)).toBeNull();
    // At rest is folded: its key chip shows, but the full card is hidden until unfold
    expect(screen.getByText('RESTED')).toBeDefined(); // key chip
    expect(screen.queryByText('RESTED project')).toBeNull(); // card hidden
    const strip = screen.getByRole('button', { name: /at rest/i });
    await userEvent.click(strip);
    expect(screen.getByText('RESTED project')).toBeDefined();
  });

  it('renders the page header with the project count and the new-project triggers', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [
            proj('REVIEW', attn('awaiting_you', '2026-06-20T00:00:00.000Z')),
            proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z')),
          ],
          total: 2,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByRole('heading', { name: 'Projects' })).resolves.toBeDefined();
    expect(screen.getByText('2')).toBeDefined(); // project count meta, no archived clause
    // Two triggers share the sheet: the desktop header action + the mobile
    // dashed end-of-list row (MMR-230).
    expect(screen.getAllByRole('button', { name: /new project/i })).toHaveLength(2);
  });

  it('appends the archived clause to the header count when archived projects exist (MMR-230)', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z'))],
          total: 1,
        });
      }
      if (path === '/api/projects?status=archived') {
        return Promise.resolve({ items: [archivedProj('OLD'), archivedProj('OLDER')], total: 2 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    // The clause renders as its own span beside the live count (MMR-125's
    // separate-span form), not a merged "1 · 2 archived" string.
    await expect(screen.findByText('· 2 archived')).resolves.toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
  });

  it('the new-project triggers open the create sheet (MMR-230)', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z'))],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    const [headerTrigger] = await screen.findAllByRole('button', { name: /new project/i });
    if (headerTrigger === undefined) {
      throw new Error('missing new-project trigger');
    }
    await userEvent.click(headerTrigger);
    await expect(screen.findByLabelText(/title/i)).resolves.toBeDefined();
    expect(screen.getByText(/lands in At rest until work starts moving/)).toBeDefined();
  });

  it('degrades to a flat Overview grid when the attention facet is absent', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({ items: [proj('OLDCACHE')], total: 1 }); // no attention
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByText('Overview')).resolves.toBeDefined();
    expect(screen.getByText('OLDCACHE')).toBeDefined();
    expect(screen.queryByText('Awaiting you')).toBeNull();
  });

  it('omits the archived shelf and header clause at zero archived (MMR-125)', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z'))],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByRole('heading', { name: 'Projects' })).resolves.toBeDefined();
    expect(screen.queryByText(/archived/i)).toBeNull();
  });

  it('renders the archived shelf below the lanes and the header archived clause (MMR-125)', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z'))],
          total: 1,
        });
      }
      if (path === '/api/projects?status=archived') {
        return Promise.resolve({ items: [archivedProj('OLD'), archivedProj('DUSTY')], total: 2 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByText('· 2 archived')).resolves.toBeDefined(); // header clause
    // folded by default: the count row shows, the frozen cards don't
    const bar = screen.getByRole('button', { name: 'Archived, 2 projects' });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('OLD project')).toBeNull();

    await userEvent.click(bar);
    expect(screen.getByText('OLD project')).toBeDefined();
    expect(screen.getByText('DUSTY project')).toBeDefined();
    expect(
      screen.getAllByText('41 tasks · 12 artifacts · readable, nothing writable'),
    ).toHaveLength(2);
  });

  it('unarchive removes the project from the shelf via refetch — no confirmation (MMR-125)', async () => {
    let archivedReads = 0;
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z'))],
          total: 1,
        });
      }
      if (path === '/api/projects?status=archived') {
        archivedReads += 1;
        return Promise.resolve(
          archivedReads === 1
            ? { items: [archivedProj('OLD')], total: 1 }
            : { items: [], total: 0 },
        );
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    apiSend.mockResolvedValue({ id: 'OLD' });
    renderOverview();

    await userEvent.click(await screen.findByRole('button', { name: 'Archived, 1 project' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive OLD project' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/OLD/unarchive', undefined);
    // the write invalidates ['projects']; the refetch empties the shelf
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Archived,/ })).toBeNull();
    });
    // the shelf unmounted while holding focus — it must not strand focus on
    // <body>; the main landmark is the fallback
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('main'));
    });
  });

  it('shows an empty state when there are no projects', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByText(/no projects yet/i)).resolves.toBeDefined();
  });
});

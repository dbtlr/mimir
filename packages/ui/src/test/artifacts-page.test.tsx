import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireArtifactSummary } from '../api/types';
import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

const summary = (n: number, over: Partial<WireArtifactSummary> = {}): WireArtifactSummary => ({
  created_at: '2026-06-16T00:00:00.000Z',
  id: `MMR-a${String(n)}`,
  links: [],
  project: 'MMR',
  tags: [],
  title: `Artifact ${String(n)}`,
  ...over,
});

function renderArtifactsPage(url = '/p/MMR/artifacts') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

/** Serve the given artifact rows (total = rows) and one project, MMR. */
function serveRows(items: WireArtifactSummary[]) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/projects') && !path.includes('status=archived')) {
      return Promise.resolve({ items: [{ id: 'MMR', status: 'ready' }], total: 1 });
    }
    if (path.startsWith('/api/artifacts?')) {
      return Promise.resolve({ items, total: items.length });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

/** The last `/api/artifacts?` request, as parsed params. */
function lastArtifactsParams(): URLSearchParams {
  const paths = apiGet.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => p.startsWith('/api/artifacts?'));
  const last = paths.at(-1) ?? '';
  return new URLSearchParams(last.slice(last.indexOf('?') + 1));
}

describe('artifactsPage', () => {
  it('renders the header count, the search box, and rows linking to their pages', async () => {
    serveRows([summary(8, { title: 'Artifacts browser' })]);
    renderArtifactsPage();
    const link = await screen.findByRole('link', { name: 'Artifacts browser' });
    expect(link).toHaveAttribute('href', '/p/MMR/a8');
    expect(screen.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByText('1 frozen')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search artifacts' })).toBeInTheDocument();
  });

  it('groups rows under day headers, newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 9, 12));
    try {
      serveRows([
        summary(3, { created_at: new Date(2026, 9, 9, 9).toISOString() }),
        summary(2, { created_at: new Date(2026, 9, 8, 9).toISOString() }),
        summary(1, { created_at: new Date(2025, 9, 6, 9).toISOString() }),
      ]);
      renderArtifactsPage();
      await screen.findByText('Artifact 1');
      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
      expect(headings).toStrictEqual(['Today', 'Yesterday', 'Oct 6, 2025']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the kind chip and the summary on a row', async () => {
    serveRows([summary(8, { summary: 'What the spec froze.', tags: ['kind:spec'] })]);
    renderArtifactsPage();
    await screen.findByText('Artifact 8');
    expect(screen.getByText('spec')).toBeInTheDocument();
    expect(screen.getByText('What the spec froze.')).toBeInTheDocument();
  });

  it('the "on" ids open the records they name', async () => {
    serveRows([summary(8, { links: ['MMR-140'] })]);
    const testRouter = renderArtifactsPage();
    await userEvent.click(await screen.findByRole('link', { name: 'MMR-140' }));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/140');
    });
  });

  it('choosing a kind sets the tag param and refetches filtered', async () => {
    serveRows([summary(8, { tags: ['kind:spec'] })]);
    const testRouter = renderArtifactsPage();
    await screen.findByText('Artifact 8');
    await userEvent.click(screen.getByRole('button', { name: /Any kind/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'spec' }));
    await waitFor(() => {
      expect(testRouter.state.location.search).toEqual({ tag: 'kind:spec' });
    });
    await waitFor(() => {
      expect(lastArtifactsParams().get('tag')).toBe('kind:spec');
    });
  });

  it('scopes the read to the project in the path and offers no project chip', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage();
    await screen.findByText('Artifact 8');
    expect(lastArtifactsParams().get('project')).toBe('MMR');
    expect(screen.queryByRole('button', { name: /All projects/ })).toBeNull();
  });

  it('a ?a= param opens no reader and reaches no query', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?a=MMR-a8');
    await screen.findByText('Artifact 8');
    expect(screen.queryByTestId('artifact-reader')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Provenance' })).toBeNull();
    expect(lastArtifactsParams().has('a')).toBe(false);
  });

  it('a numeric q in the URL is the text it was typed as', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?q=2026');
    await screen.findByText('Artifact 8');
    expect(lastArtifactsParams().get('q')).toBe('2026');
  });

  it('date filters in the URL render as removable chips and reach the query', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?atOrAfter=2026-06-01');
    await screen.findByText('Artifact 8');
    expect(
      screen.getByRole('button', { name: 'Remove filter on or after 2026-06-01' }),
    ).toBeInTheDocument();
    expect(lastArtifactsParams().get('at-or-after')).toBe('created_at:2026-06-01');
  });

  it('says so when nothing matches', async () => {
    serveRows([]);
    renderArtifactsPage();
    await expect(screen.findByText('No artifacts match.')).resolves.toBeDefined();
  });

  it('scrolling the page pulls the next window, so every artifact is reachable', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects') && !path.includes('status=archived')) {
        return Promise.resolve({ items: [], total: 0 });
      }
      if (path.startsWith('/api/artifacts?')) {
        const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
        if (params.get('offset') === '100') {
          return Promise.resolve({ items: [summary(101)], total: 101 });
        }
        return Promise.resolve({
          items: Array.from({ length: 100 }, (_, i) => summary(i + 1)),
          total: 101,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    renderArtifactsPage();
    await expect(screen.findByText('Artifact 1')).resolves.toBeDefined();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('limit=100'));
    expect(screen.getByText('101 frozen')).toBeInTheDocument();
    expect(screen.queryByText('Artifact 101')).toBeNull();
    fireEvent.scroll(screen.getByTestId('artifact-scroll'));
    await expect(screen.findByText('Artifact 101')).resolves.toBeDefined();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { ArtifactSummary } from '../api/browse-queries';
import { artifacts } from '../api/fns/browse';
import { routeTree } from '../router';
import { engineArtifact } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveShell } from './shell-fns';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');

const summary = (n: number, over: Partial<ArtifactSummary> = {}): ArtifactSummary =>
  engineArtifact({
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    id: `MMR-a${String(n)}`,
    title: `Artifact ${String(n)}`,
    ...over,
  });

function renderArtifactsPage(url = '/p/MMR/artifacts') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

/** Serve the given artifact rows (total = rows) and one project, MMR. */
function serveRows(items: ArtifactSummary[]) {
  serveShell({ projects: [engineProject({ id: 'MMR' })] });
  serveBrowse({ artifacts: items });
  apiGet.mockImplementation((path: string) => Promise.reject(new Error(`unexpected ${path}`)));
}

/** The last artifact-list read, as the `artifacts` input it sent. */
function lastArtifactsInput() {
  return vi.mocked(artifacts).mock.calls.at(-1)?.[0].data;
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
        summary(3, { createdAt: new Date(2026, 9, 9, 9) }),
        summary(2, { createdAt: new Date(2026, 9, 8, 9) }),
        summary(1, { createdAt: new Date(2025, 9, 6, 9) }),
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
      expect(lastArtifactsInput()?.tag).toBe('kind:spec');
    });
  });

  it('scopes the read to the project in the path and offers no project chip', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage();
    await screen.findByText('Artifact 8');
    expect(lastArtifactsInput()?.project).toBe('MMR');
    expect(screen.queryByRole('button', { name: /All projects/ })).toBeNull();
  });

  it('a ?a= param opens no reader and reaches no query', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?a=MMR-a8');
    await screen.findByText('Artifact 8');
    expect(screen.queryByTestId('artifact-reader')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Provenance' })).toBeNull();
    expect(lastArtifactsInput()).not.toHaveProperty('a');
  });

  it('a numeric q in the URL is the text it was typed as', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?q=2026');
    await screen.findByText('Artifact 8');
    expect(lastArtifactsInput()?.q).toBe('2026');
  });

  it('date filters in the URL render as removable chips and reach the query', async () => {
    serveRows([summary(8)]);
    renderArtifactsPage('/p/MMR/artifacts?atOrAfter=2026-06-01');
    await screen.findByText('Artifact 8');
    expect(
      screen.getByRole('button', { name: 'Remove filter on or after 2026-06-01' }),
    ).toBeInTheDocument();
    expect(lastArtifactsInput()?.dates).toStrictEqual([
      { field: 'created_at', op: 'at-or-after', value: '2026-06-01' },
    ]);
  });

  it('says so when nothing matches', async () => {
    serveRows([]);
    renderArtifactsPage();
    await expect(screen.findByText('No artifacts match.')).resolves.toBeDefined();
  });

  it('scrolling the page pulls the next window, so every artifact is reachable', async () => {
    serveRows(Array.from({ length: 101 }, (_, i) => summary(i + 1)));
    renderArtifactsPage();
    await expect(screen.findByText('Artifact 1')).resolves.toBeDefined();
    expect(artifacts).toHaveBeenCalledWith({ data: { limit: 100, project: 'MMR' } });
    expect(screen.getByText('101 frozen')).toBeInTheDocument();
    expect(screen.queryByText('Artifact 101')).toBeNull();
    fireEvent.scroll(screen.getByTestId('artifact-scroll'));
    await expect(screen.findByText('Artifact 101')).resolves.toBeDefined();
    expect(artifacts).toHaveBeenLastCalledWith({
      data: { limit: 100, offset: 100, project: 'MMR' },
    });
  });
});

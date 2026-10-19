import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { doctor } from '../api/fns/browse';
import type { RecordHealth } from '../api/fns/browse';
import { routeTree } from '../router';
import { recordHealth } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { emptyRead, workReport } from './fixtures';
import { serveShell } from './shell-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');

/** A facet with `n` findings on project MMR — surfacing only needs the count. */
function facet(n: number): RecordHealth {
  return recordHealth({
    finding_total: n,
    groups: n === 0 ? [] : [{ finding_count: n, project: 'MMR', records: [] }],
  });
}

function renderAt(path: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('record-health surfacing (MMR-185, mock 15b)', () => {
  it('puts an amber findings chip in the project header, linking to the panel', async () => {
    serveShell({
      projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
      trees: {
        MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }),
      },
    });
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects/MMR') {
        return Promise.resolve({
          distribution: {},
          id: 'MMR',
          status: 'in_progress',
          title: 'Mimir',
        });
      }
      if (path.startsWith('/api/projects/MMR/work?')) {
        return Promise.resolve(workReport());
      }
      return Promise.resolve(emptyRead(path));
    });
    serveBrowse({ health: facet(2) });
    renderAt('/p/MMR');

    const chip = await screen.findByRole('link', { name: /2 findings/ });
    expect(chip.getAttribute('href')).toContain('/doctor');
    expect(chip.getAttribute('href')).toContain('project=MMR');
    expect(doctor).toHaveBeenCalledWith({ data: { project: 'MMR' } });
  });
});

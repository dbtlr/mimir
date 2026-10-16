import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { WireDoctorFacet } from '../api/types';
import { routeTree } from '../router';
import { emptyRead, workReport } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/** A facet with `n` findings on project MMR — surfacing only needs the count. */
function facet(n: number): WireDoctorFacet {
  return {
    finding_total: n,
    groups: n === 0 ? [] : [{ finding_count: n, project: 'MMR', records: [] }],
    scanned_at: new Date().toISOString(),
    scope: null,
  };
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
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects/MMR') {
        return Promise.resolve({
          distribution: {},
          id: 'MMR',
          status: 'in_progress',
          title: 'Mimir',
        });
      }
      if (path === '/api/projects/MMR/tree') {
        return Promise.resolve({
          children: [],
          distribution: {},
          id: 'MMR',
          status: 'in_progress',
          title: 'Mimir',
          type: 'project',
        });
      }
      if (path === '/api/doctor?project=MMR') {
        return Promise.resolve(facet(2));
      }
      if (path.startsWith('/api/projects/MMR/work?')) {
        return Promise.resolve(workReport());
      }
      return Promise.resolve(emptyRead(path));
    });
    renderAt('/p/MMR');

    const chip = await screen.findByRole('link', { name: /2 findings/ });
    expect(chip.getAttribute('href')).toContain('/doctor');
    expect(chip.getAttribute('href')).toContain('project=MMR');
  });
});

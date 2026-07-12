import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { WireDoctorFacet } from '../api/types';
import { router } from '../router';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/** A facet with `n` drops on project MMR — surfacing only needs the count. */
function facet(n: number): WireDoctorFacet {
  return {
    dropped_total: n,
    groups: n === 0 ? [] : [{ dropped: n, path: 'MMR', project: 'MMR', readable: 40, records: [] }],
    scanned_at: new Date().toISOString(),
  };
}

function renderAt(path: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('record-health surfacing (MMR-185, mock 15b)', () => {
  it('shows an amber dropped vital on the Overview card', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [{ distribution: {}, id: 'MMR', status: 'in_progress', title: 'Mimir' }],
          total: 1,
        });
      }
      if (path === '/api/doctor') {
        return Promise.resolve(facet(2));
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderAt('/');

    await expect(screen.findByText('2 dropped')).resolves.toBeDefined();
  });

  it('shows an amber attention pill + damage line when nothing else needs the operator', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [{ distribution: {}, id: 'MMR', status: 'in_progress', title: 'Mimir' }],
          total: 1,
        });
      }
      if (path === '/api/doctor') {
        return Promise.resolve(facet(2));
      }
      return Promise.resolve({ items: [], total: 0 }); // no under_review / blocked / stale
    });
    renderAt('/');

    // The pill is reachable even with zero needs-you: it reads the dropped count.
    // Exact name disambiguates it from the Overview card button (whose name also
    // contains "2 dropped").
    const pill = await screen.findByRole('button', { name: '2 dropped' });
    await userEvent.click(pill);
    // The damage line sits in the menu, deep-linking to the health panel.
    await expect(screen.findByText(/Record damage in/)).resolves.toBeDefined();
    expect(screen.getByText('health →')).toBeDefined();
  });

  it('shows no pill and no vital at zero findings', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [{ distribution: {}, id: 'MMR', status: 'in_progress', title: 'Mimir' }],
          total: 1,
        });
      }
      return Promise.resolve(path === '/api/doctor' ? facet(0) : { items: [], total: 0 });
    });
    renderAt('/');

    await expect(screen.findByText('Mimir')).resolves.toBeDefined();
    expect(screen.queryByText(/dropped/)).toBeNull();
  });

  it('puts an amber dropped chip in the project header, linking to the panel', async () => {
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
      return Promise.resolve({ items: [], total: 0 });
    });
    renderAt('/p/MMR');

    const chip = await screen.findByRole('link', { name: /2 dropped/ });
    expect(chip.getAttribute('href')).toContain('/doctor');
    expect(chip.getAttribute('href')).toContain('project=MMR');
  });
});

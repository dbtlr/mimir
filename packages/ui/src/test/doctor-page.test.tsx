import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { WireDoctorFacet } from '../api/types';
import { router } from '../router';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/** A facet with one dropped record (an illegal status word) fully enriched. */
function damagedFacet(): WireDoctorFacet {
  return {
    dropped_total: 1,
    groups: [
      {
        dropped: 1,
        path: 'MMR',
        project: 'MMR',
        readable: 84,
        records: [
          {
            cause: 'illegal status word',
            field: 'lifecycle',
            id: 'MMR-97',
            location: { byte: 18240, line: 412 },
            note: 'Not a status word.',
            path: 'MMR/MMR-97.md',
            severity: 'error',
            snippet: {
              lines: [
                { n: 410, text: 'priority: p2' },
                { n: 411, text: 'size: s' },
                { n: 412, offending: { length: 6, start: 11 }, text: 'lifecycle: praked' },
              ],
            },
            suggestion: 'parked',
            title: 'Board polish: hover states',
            value: 'praked',
          },
        ],
      },
    ],
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

describe('doctorPage record-health panel (MMR-185)', () => {
  it('renders the dropped record with cause, source snippet, and nearest-legal hint', async () => {
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await expect(screen.findByText('Record health')).resolves.toBeDefined();
    // Scoped header names the project.
    expect(screen.getByText('MMR · mimir doctor')).toBeDefined();
    // Amber summary banner + cause chip (await the facet-dependent banner first).
    await expect(screen.findByText('1 record dropped from view')).resolves.toBeDefined();
    expect(screen.getByText('illegal status word')).toBeDefined();
    // The offending token rides the source snippet; the nearest-legal word shows.
    expect(screen.getByText('praked')).toBeDefined();
    expect(screen.getByText('parked')).toBeDefined();
    expect(screen.getByText(/line 412 · byte 18 240/)).toBeDefined();
    // Copy location is the ONLY affordance — read-only.
    expect(screen.getByRole('button', { name: 'Copy location' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /fix|repair|edit/i })).toBeNull();
  });

  it('copy location writes path:line to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await userEvent.click(await screen.findByRole('button', { name: 'Copy location' }));
    expect(writeText).toHaveBeenCalledWith('MMR/MMR-97.md:412');
  });

  it('shows the zero state when nothing is dropped', async () => {
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/doctor')
          ? { dropped_total: 0, groups: [], scanned_at: new Date().toISOString() }
          : { items: [], total: 0 },
      ),
    );
    renderAt('/doctor');

    await expect(screen.findByText('No dropped records')).resolves.toBeDefined();
    expect(screen.queryByText(/dropped from view/)).toBeNull();
  });
});

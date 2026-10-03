import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireDoctorFacet } from '../api/types';
import { router } from '../router';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
// The shell renders sonner's Toaster; the panel fires toast.success/error — stub
// both so the copy-outcome assertions read the mock, not the DOM.
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

afterEach(() => {
  vi.clearAllMocks();
});

/** A facet with one finding: a node whose parent names no row. */
function damagedFacet(): WireDoctorFacet {
  return {
    finding_total: 1,
    groups: [
      {
        finding_count: 1,
        project: 'MMR',
        records: [
          {
            cause: 'dangling parent',
            evidence: { parent_id: 'MMR-404', value: 'MMR-404' },
            field: 'parent_id',
            id: 'MMR-97',
            locator: 'node/MMR-97',
            note: 'MMR-97 names parent MMR-404, which no node row holds',
            severity: 'error',
            value: 'MMR-404',
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
  it('renders a finding with its cause, row locator, and evidence', async () => {
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await expect(screen.findByText('Record health')).resolves.toBeDefined();
    // Scoped header names the project.
    expect(screen.getByText('MMR · mimir doctor')).toBeDefined();
    // Amber summary banner + cause chip (await the facet-dependent banner first).
    await expect(screen.findByText('1 finding in the store')).resolves.toBeDefined();
    expect(screen.getByText('dangling parent')).toBeDefined();
    // The row's table and key, and the finding's evidence, are what reach it.
    expect(screen.getByText('node/MMR-97')).toBeDefined();
    expect(screen.getByText('MMR-97 names parent MMR-404, which no node row holds')).toBeDefined();
    const evidence = screen.getByLabelText('Evidence');
    expect(within(evidence).getByText('parent_id')).toBeDefined();
    expect(within(evidence).getAllByText('MMR-404')).toHaveLength(2);
    // No file, line, or snippet survives on a SQL store.
    expect(screen.queryByText(/line \d+ · byte/)).toBeNull();
    expect(screen.queryByText(/in the file/)).toBeNull();
    // Copy location is the ONLY affordance — read-only.
    expect(screen.getByRole('button', { name: 'Copy location' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /fix|repair|edit/i })).toBeNull();
  });

  it('copy location writes the row locator and toasts success only after the write resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await userEvent.click(await screen.findByRole('button', { name: 'Copy location' }));
    expect(writeText).toHaveBeenCalledWith('node/MMR-97');
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Copied node/MMR-97');
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('copy location toasts an error (never success) when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await userEvent.click(await screen.findByRole('button', { name: 'Copy location' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('node/MMR-97'));
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('copy location toasts an error when the clipboard API is absent (insecure context)', async () => {
    Object.assign(navigator, { clipboard: undefined });
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? damagedFacet() : { items: [], total: 0 }),
    );
    renderAt('/doctor?project=MMR');

    await userEvent.click(await screen.findByRole('button', { name: 'Copy location' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('node/MMR-97'));
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders two same-cause findings on one node without duplicate keys', async () => {
    // Two dangling dependencies on one node: same id, same cause — the row
    // key must still be unique or React logs a duplicate-key error.
    const record = {
      cause: 'dangling dependency',
      field: 'depends_on_node_id',
      id: 'MMR-7',
      locator: 'dependency/MMR-7',
      note: 'the dependency names a node no row holds',
      severity: 'error' as const,
      value: null,
    };
    const twin: WireDoctorFacet = {
      finding_total: 2,
      groups: [
        {
          finding_count: 2,
          project: 'MMR',
          records: [
            { ...record, evidence: { absent: ['MMR-90'] } },
            { ...record, evidence: { absent: ['MMR-91'] } },
          ],
        },
      ],
      scanned_at: new Date().toISOString(),
    };
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/doctor') ? twin : { items: [], total: 0 }),
    );
    const consoleError = vi.spyOn(console, 'error');
    renderAt('/doctor?project=MMR');

    await expect(screen.findAllByText('dangling dependency')).resolves.toHaveLength(2);
    expect(
      consoleError.mock.calls.filter((args) => String(args[0]).includes('same key')),
    ).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('shows the zero state when the store has no findings', async () => {
    apiGet.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/doctor')
          ? { finding_total: 0, groups: [], scanned_at: new Date().toISOString() }
          : { items: [], total: 0 },
      ),
    );
    renderAt('/doctor');

    await expect(screen.findByText('No findings')).resolves.toBeDefined();
    expect(screen.queryByText(/in the store/)).toBeNull();
  });
});

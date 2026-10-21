import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingPairingsQuery } from '../api/device-queries';
import { pairedDevices, pendingPairings, unpairDevice } from '../api/fns/devices';
import { consoleRoutes } from '../router';
import { failDeviceReads, serveDevices } from './devices-fns';
import { renderRoute } from './router';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

const MINUTE = 60_000;

beforeEach(() => {
  serveViews();
});

afterEach(() => {
  vi.clearAllMocks();
});

function filedAgo(minutes: number) {
  const now = Date.now();
  return {
    created_at: new Date(now - minutes * MINUTE).toISOString(),
    expires_at: new Date(now + (9.5 - minutes) * MINUTE).toISOString(),
  };
}

describe('devices page (MMR-585)', () => {
  it('lists waiting requests and paired devices', async () => {
    serveDevices({
      paired: [
        {
          created_at: '2026-09-30T15:00:00.000Z',
          device: 'valhalla',
          last_used_at: new Date(Date.now() - 2 * MINUTE).toISOString(),
        },
        { created_at: '2026-09-30T15:00:00.000Z', device: 'old-ipad', last_used_at: null },
      ],
      pending: [{ device: 'drews-macbook', ...filedAgo(1) }],
    });
    await renderRoute(consoleRoutes, '/devices');

    await expect(screen.findByText('clients paired with this host')).resolves.toBeDefined();
    const waiting = await screen.findByRole('region', { name: 'Waiting' });
    expect(within(waiting).getByText('drews-macbook')).toBeDefined();
    expect(within(waiting).getByText('filed 1m ago')).toBeDefined();
    expect(within(waiting).getByText('expires in 8m')).toBeDefined();
    const paired = screen.getByRole('region', { name: 'Paired' });
    expect(within(paired).getByText('valhalla')).toBeDefined();
    expect(within(paired).getByText(/used 2m ago/)).toBeDefined();
    expect(within(paired).getByText('old-ipad')).toBeDefined();
    expect(within(paired).getByText(/never used/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Enter a code' })).toHaveAttribute('href', '/pair');
  });

  it('says so when nothing waits and nothing is paired', async () => {
    serveDevices();
    await renderRoute(consoleRoutes, '/devices');

    await expect(screen.findByText('No devices are waiting.')).resolves.toBeDefined();
    expect(screen.getByText('No devices are paired.')).toBeDefined();
  });

  it('asks to confirm before unpairing, and cancels without calling', async () => {
    serveDevices({
      paired: [{ created_at: '2026-09-30T15:00:00.000Z', device: 'valhalla', last_used_at: null }],
    });
    await renderRoute(consoleRoutes, '/devices');

    const row = (await screen.findByText('valhalla')).closest('li');
    expect(row).not.toBeNull();
    const inRow = within(row as HTMLElement);
    await userEvent.click(inRow.getByRole('button', { name: 'Unpair' }));
    expect(inRow.getByText('Its token stops working now.')).toBeDefined();
    expect(unpairDevice).not.toHaveBeenCalled();

    await userEvent.click(inRow.getByRole('button', { name: 'Cancel' }));
    expect(inRow.getByRole('button', { name: 'Unpair' })).toBeDefined();
    expect(unpairDevice).not.toHaveBeenCalled();
  });

  it('unpairs the device once confirmed, and the list refreshes', async () => {
    const world = serveDevices({
      paired: [{ created_at: '2026-09-30T15:00:00.000Z', device: 'valhalla', last_used_at: null }],
    });
    vi.mocked(unpairDevice).mockImplementation(async () => {
      world.paired = [];
    });
    await renderRoute(consoleRoutes, '/devices');

    await userEvent.click(await screen.findByRole('button', { name: 'Unpair' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unpair valhalla' }));

    expect(unpairDevice).toHaveBeenCalledWith({ data: { device: 'valhalla' } });
    await expect(screen.findByText('No devices are paired.')).resolves.toBeDefined();
  });

  it('toasts a refused unpair and keeps the device listed', async () => {
    serveDevices({
      paired: [{ created_at: '2026-09-30T15:00:00.000Z', device: 'valhalla', last_used_at: null }],
    });
    vi.mocked(unpairDevice).mockRejectedValueOnce(new Error('the request did not complete'));
    await renderRoute(consoleRoutes, '/devices');

    await userEvent.click(await screen.findByRole('button', { name: 'Unpair' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unpair valhalla' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('the request did not complete');
    });
    expect(screen.getByText('valhalla')).toBeDefined();
  });

  it('polls the waiting list every two seconds', () => {
    expect(pendingPairingsQuery.refetchInterval).toBe(2000);
    expect(pendingPairingsQuery.queryKey).toEqual(['devices', 'pending']);
  });

  it('shows the offline banner when the host cannot be reached', async () => {
    serveDevices();
    failDeviceReads();
    await renderRoute(
      consoleRoutes,
      '/devices',
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );

    await expect(screen.findByText(/Offline — last synced/)).resolves.toBeDefined();
    expect(pendingPairings).toHaveBeenCalled();
    expect(pairedDevices).toHaveBeenCalled();
  });
});

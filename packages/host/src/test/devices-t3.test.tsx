import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectT3, t3Status } from '../api/fns/t3';
import type { T3Status } from '../api/fns/t3';
import { leaveFor } from '../lib/leave-for';
import { consoleRoutes } from '../router';
import { serveDevices } from './devices-fns';
import { renderRoute } from './router';
import { serveT3, T3_AUTHORIZE_URL } from './t3-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
vi.mock('../api/fns/t3');
vi.mock('../lib/leave-for');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

const DAY = 24 * 60 * 60 * 1000;
const HINT =
  "On T3's screen, pick full access if launched threads should run without approval prompts.";

beforeEach(() => {
  serveViews();
  serveDevices();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function card() {
  return screen.findByRole('region', { name: 'T3 Code' });
}

describe('the T3 Code card (ADR 0040)', () => {
  it('is absent while T3 is unconfigured', async () => {
    serveT3({ state: 'unconfigured' });
    const { router } = await renderRoute(consoleRoutes, '/devices?t3=connected');
    await screen.findByRole('region', { name: 'Paired' });
    await waitFor(() => {
      expect(t3Status).toHaveBeenCalled();
    });
    expect(screen.queryByRole('region', { name: 'T3 Code' })).toBeNull();
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
  });

  it.each<[string, T3Status, string, string | undefined]>([
    [
      'connected',
      {
        expiresAt: new Date(Date.now() + 29 * DAY + 60_000).toISOString(),
        label: 'Valhalla',
        state: 'connected',
      },
      'Connected to Valhalla. Expires in 4w.',
      'Reconnect T3',
    ],
    ['never connected', { reason: 'none', state: 'disconnected' }, 'Not connected.', 'Connect T3'],
    [
      'expired',
      { reason: 'expired', state: 'disconnected' },
      'The connection expired.',
      'Reconnect T3',
    ],
    [
      'misconfigured',
      { problem: 'unset', setting: 'MIMIR_HOSTS', state: 'misconfigured' },
      'T3 is not set up: MIMIR_HOSTS is unset.',
      undefined,
    ],
  ])('words the %s state', async (_name, status, text, button) => {
    serveT3(status);
    await renderRoute(consoleRoutes, '/devices');
    const region = await card();
    expect(within(region).getByText(text)).toBeInTheDocument();
    const buttons = within(region)
      .queryAllByRole('button')
      .map((element) => element.textContent);
    expect(buttons).toEqual(button === undefined ? [] : [button]);
    expect(within(region).queryAllByText(HINT)).toHaveLength(button === undefined ? 0 : 1);
  });

  it('sends the browser to the authorization URL Connect answers', async () => {
    serveT3({ reason: 'none', state: 'disconnected' });
    await renderRoute(consoleRoutes, '/devices');
    await userEvent.click(within(await card()).getByRole('button', { name: 'Connect T3' }));
    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(T3_AUTHORIZE_URL);
    });
    expect(connectT3).toHaveBeenCalledOnce();
  });

  it('shows a refused Connect in the card and stays on the page', async () => {
    serveT3({ reason: 'expired', state: 'disconnected' }, { state: 'unreachable' });
    await renderRoute(consoleRoutes, '/devices');
    const region = await card();
    await userEvent.click(within(region).getByRole('button', { name: 'Reconnect T3' }));
    await expect(within(region).findByRole('alert')).resolves.toHaveTextContent(
      'T3 did not answer.',
    );
    expect(leaveFor).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(t3Status).toHaveBeenCalledTimes(2);
    });
  });

  // T3_OUTCOME_TEXT words every outcome; one outcome proves the card shows it once.
  it('shows the connected outcome once, then drops it from the URL', async () => {
    serveT3({ reason: 'none', state: 'disconnected' });
    const { router } = await renderRoute(consoleRoutes, '/devices?t3=connected');
    const region = await card();
    expect(within(region).getByRole('status')).toHaveTextContent('Connected.');
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(router.history).toHaveLength(1);
    expect(within(region).getByRole('status')).toHaveTextContent('Connected.');
  });

  it('ignores an unknown outcome', async () => {
    serveT3({ reason: 'none', state: 'disconnected' });
    await renderRoute(consoleRoutes, '/devices?t3=<script>');
    const region = await card();
    expect(within(region).queryByRole('status')).toBeNull();
    expect(within(region).queryByText('<script>')).toBeNull();
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approvePairing, denyPairing, lookupPairing } from '../api/fns/devices';
import { consoleRoutes } from '../router';
import { serveDevices } from './devices-fns';
import { renderRoute } from './router';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ Toaster: () => null, toast }));

const CODE = 'K7QM-2XRD';
const MINUTE = 60_000;

beforeEach(() => {
  serveViews();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A waiting request filed a minute ago with nine and a half minutes left. */
function waiting(device: string, rotates = false) {
  const now = Date.now();
  return {
    created_at: new Date(now - MINUTE).toISOString(),
    device,
    expires_at: new Date(now + 9.5 * MINUTE).toISOString(),
    rotates,
  };
}

describe('pair page (MMR-585)', () => {
  it('asks for a code, and looks nothing up, when none is given', async () => {
    serveDevices();
    await renderRoute(consoleRoutes, '/pair');

    await expect(screen.findByText('Pair a device')).resolves.toBeDefined();
    expect(screen.getByText('mimir pair <this host>')).toBeDefined();
    expect(screen.getByText(/on the device to get a code\./)).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toHaveValue('');
    expect(lookupPairing).not.toHaveBeenCalled();
  });

  it('shows the confirm card for a prefilled code', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await expect(screen.findByText('Approve drews-macbook?')).resolves.toBeDefined();
    expect(lookupPairing).toHaveBeenCalledWith({ data: { code: CODE } });
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toHaveValue(CODE);
    expect(
      screen.getByText("Check that this code matches the one shown in the device's terminal."),
    ).toBeDefined();
    expect(screen.getByText('1m ago')).toBeDefined();
    expect(screen.getByText('in 9m')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Manage devices/ })).toHaveAttribute(
      'href',
      '/devices',
    );
    expect(screen.queryByText(/already paired/)).toBeNull();
  });

  it('warns that approving replaces the token of an already paired device', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook', true) } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await expect(
      screen.findByText('drews-macbook is already paired. Approving replaces its token.'),
    ).resolves.toBeDefined();
  });

  it('says one thing for a code nothing waits on', async () => {
    serveDevices();
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await expect(screen.findByText('No waiting request has this code.')).resolves.toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('looks up a code as it is completed, and writes it to the URL', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    const { router } = await renderRoute(consoleRoutes, '/pair');

    await userEvent.type(await screen.findByRole('textbox', { name: 'Pairing code' }), 'k7qm2xrd');

    await expect(screen.findByText('Approve drews-macbook?')).resolves.toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toHaveValue(CODE);
    expect(router.state.location.search).toEqual({ code: CODE });
    expect(lookupPairing).toHaveBeenCalledTimes(1);
  });

  it('approves the code, and the outcome outlives the lookup that no longer finds it', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    const approved = await screen.findByText(
      'Approved drews-macbook. It finishes pairing on its next poll, so check the terminal.',
    );
    expect(approvePairing).toHaveBeenCalledWith({ data: { code: CODE } });
    // The approval consumed the code, so the invalidated lookup now answers null.
    await waitFor(() => {
      expect(lookupPairing).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/^Approved drews-macbook/)).toBe(approved);
    expect(screen.queryByText('No waiting request has this code.')).toBeNull();
    expect(screen.getByRole('link', { name: /devices/i })).toHaveAttribute('href', '/devices');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('denies the code', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await expect(screen.findByText('Denied drews-macbook.')).resolves.toBeDefined();
    expect(denyPairing).toHaveBeenCalledWith({ data: { code: CODE } });
    expect(approvePairing).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(lookupPairing).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('Denied drews-macbook.')).toBeDefined();
  });

  it('toasts an approval refused because the code was spent, and says no request waits', async () => {
    const world = serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    // Another surface decided the request after the card loaded.
    delete world.codes[CODE];

    await userEvent.click(approve);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('No waiting request has this code.');
    });
    await expect(screen.findByText('No waiting request has this code.')).resolves.toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('announces the result area politely, and moves focus to the outcome', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    const outcome = await screen.findByText(/^Approved drews-macbook/);
    expect(live).toContainElement(outcome);
    expect(outcome).toHaveFocus();
  });

  it('moves focus to a denial too', async () => {
    serveDevices({ codes: { [CODE]: waiting('drews-macbook') } });
    await renderRoute(consoleRoutes, `/pair?code=${CODE}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await expect(screen.findByText('Denied drews-macbook.')).resolves.toHaveFocus();
  });
});

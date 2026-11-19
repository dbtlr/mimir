import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t3Status } from '../api/fns/t3';
import type { T3Status } from '../api/fns/t3';
import { fetchHealth } from '../api/health';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { BUILD_VERSION } from '../lib/build-version';
import { versionLabel } from '../lib/settings';
import { consoleRoutes } from '../router';
import { serveDevices } from './devices-fns';
import { renderRoute } from './router';
import { serveT3 } from './t3-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../api/fns/devices');
vi.mock('../api/fns/t3');
vi.mock('../api/health');

/*
 * The Settings area (ADR 0013, MMR-733): the index's row values, the old
 * /devices path, Appearance, and About. The Devices and Connections pages keep
 * their own files; the sidebar and the "…" menu are proved with the shell in
 * project-sidebar.test.tsx.
 */

const pairing = (device: string) => ({
  created_at: '2026-09-30T15:00:00.000Z',
  device,
  expires_at: '2099-01-01T00:00:00.000Z',
});
const paired = (device: string) => ({
  created_at: '2026-09-30T15:00:00.000Z',
  device,
  last_used_at: null,
});

beforeEach(() => {
  localStorage.clear();
  serveViews();
  serveDevices();
  serveT3();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** The index row linking to `href`, once its value has loaded. */
async function row(href: string) {
  const links = await screen.findAllByRole('link');
  const link = links.find((candidate) => candidate.getAttribute('href') === href);
  expect(link).toBeDefined();
  return link as HTMLElement;
}

describe('the Settings index', () => {
  it('groups the pages and links each row to its page', async () => {
    await renderRoute(consoleRoutes, '/settings');
    await expect(
      screen.findByRole('heading', { level: 1, name: 'Settings' }),
    ).resolves.toBeInTheDocument();
    const device = screen.getByRole('region', { name: 'This device' });
    expect(
      within(device)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toStrictEqual(['/settings/appearance']);
    const host = screen.getByRole('region', { name: 'Host' });
    expect(
      within(host)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toStrictEqual(['/settings/devices', '/settings/connections', '/settings/about']);
    expect(screen.queryByRole('link', { name: '← Settings' })).toBeNull();
  });

  it('shows waiting pairing requests in the attention color, ahead of the paired count', async () => {
    serveDevices({ paired: [paired('a'), paired('b')], pending: [pairing('build-box')] });
    await renderRoute(consoleRoutes, '/settings');
    await waitFor(async () => {
      await expect(row('/settings/devices')).resolves.toHaveTextContent('Devices1 waiting');
    });
    expect(within(await row('/settings/devices')).getByText('1 waiting')).toHaveClass(
      'text-attention-foreground',
    );
  });

  it('shows the paired count when nothing waits', async () => {
    serveDevices({ paired: [paired('a'), paired('b')] });
    await renderRoute(consoleRoutes, '/settings');
    await waitFor(async () => {
      await expect(row('/settings/devices')).resolves.toHaveTextContent('Devices2 paired');
    });
    expect(within(await row('/settings/devices')).getByText('2 paired')).not.toHaveClass(
      'text-attention-foreground',
    );
  });

  it.each<[string, T3Status, string]>([
    ['unconfigured', { state: 'unconfigured' }, 'Not set up'],
    ['never connected', { reason: 'none', state: 'disconnected' }, 'Not connected'],
    [
      'connected',
      { expiresAt: '2099-01-01T00:00:00.000Z', label: 'Valhalla', state: 'connected' },
      'Connected',
    ],
  ])('words the Connections row for a %s T3', async (_name, status, word) => {
    serveT3(status);
    await renderRoute(consoleRoutes, '/settings');
    await waitFor(async () => {
      await expect(row('/settings/connections')).resolves.toHaveTextContent(`Connections${word}`);
    });
  });

  it("shows the console's own version on About, not the host's", async () => {
    vi.mocked(fetchHealth).mockResolvedValue({
      minClient: '0.0.0',
      schema: 1,
      status: 'ok',
      version: '9.9.9',
    });
    await renderRoute(consoleRoutes, '/settings');
    const about = await row('/settings/about');
    // Let any host read settle: the row must not switch to the host's version.
    await act(async () => {
      await Promise.resolve();
    });
    expect(about).toHaveTextContent(`About${versionLabel(BUILD_VERSION)}`);
    expect(about).not.toHaveTextContent('9.9.9');
  });

  it('shows the stored theme choice, not the resolved theme', async () => {
    await renderRoute(consoleRoutes, '/settings');
    await waitFor(async () => {
      await expect(row('/settings/appearance')).resolves.toHaveTextContent(
        'AppearanceMatch system',
      );
    });
  });

  it.each([
    ['light', 'Light'],
    ['dark', 'Dark'],
  ])('shows a stored %s pick as %s', async (stored, label) => {
    localStorage.setItem('mimir-theme', stored);
    await renderRoute(consoleRoutes, '/settings');
    await expect(row('/settings/appearance')).resolves.toHaveTextContent(`Appearance${label}`);
  });
});

describe('/devices (MMR-733)', () => {
  it('redirects to /settings/devices, keeping its query', async () => {
    const { router } = await renderRoute(consoleRoutes, '/devices?from=bookmark');
    await screen.findByRole('heading', { level: 1, name: 'Devices' });
    expect(router.state.location.pathname).toBe('/settings/devices');
    expect(router.state.location.search).toEqual({ from: 'bookmark' });
  });

  it('sends an old link carrying a T3 outcome to Connections, where it is shown', async () => {
    serveT3({ reason: 'none', state: 'disconnected' });
    await renderRoute(consoleRoutes, '/devices?t3=denied');
    await expect(screen.findByRole('status')).resolves.toHaveTextContent('You declined on T3.');
  });

  it('puts a back link to Settings above the title of a sub-page', async () => {
    await renderRoute(consoleRoutes, '/settings/devices');
    await expect(screen.findByRole('link', { name: '← Settings' })).resolves.toHaveAttribute(
      'href',
      '/settings',
    );
  });
});

function mockOS(prefersLight: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: vi.fn(),
    matches: query.includes('light') ? prefersLight : !prefersLight,
    media: query,
    removeEventListener: vi.fn(),
  }));
}

describe('Appearance', () => {
  it('offers Light, Dark, and Match system, with the stored choice selected', async () => {
    localStorage.setItem('mimir-theme', 'dark');
    mockOS(true);
    await renderRoute(consoleRoutes, '/settings/appearance');
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toStrictEqual(['Light', 'Dark', 'Match system']);
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('pins a pick, then Match system clears it and follows the OS again', async () => {
    mockOS(true);
    await renderRoute(consoleRoutes, '/settings/appearance');
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getByRole('radio', { name: 'Match system' })).toBeChecked();

    await userEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(localStorage.getItem('mimir-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await userEvent.click(within(group).getByRole('radio', { name: 'Match system' }));
    expect(localStorage.getItem('mimir-theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(within(group).getByRole('radio', { name: 'Match system' })).toBeChecked();
  });
});

const standalone = (on: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: vi.fn(),
    matches: on && query === '(display-mode: standalone)',
    media: query,
    removeEventListener: vi.fn(),
  }));
};

const renderAbout = async () =>
  renderRoute(consoleRoutes, '/settings/about', new QueryClient(), PwaUpdateProvider);

describe('About', () => {
  it('offers the update check when the console runs installed', async () => {
    standalone(true);
    await renderAbout();
    await expect(screen.findByRole('button', { name: 'Refresh console' })).resolves.toBeEnabled();
  });

  it('shows both versions and a link to Record health, and no update check outside the installed console', async () => {
    standalone(false);
    await renderAbout();
    await expect(
      screen.findByRole('heading', { level: 1, name: 'About' }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Console')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Record health/ })).toHaveAttribute('href', '/doctor');
    expect(screen.queryByRole('button')).toBeNull();
    expect(t3Status).not.toHaveBeenCalled();
  });
});

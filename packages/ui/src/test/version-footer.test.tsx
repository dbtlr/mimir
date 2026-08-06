import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { VersionFooter } from '../components/version-footer';
import { createPwaUpdateController } from '../lib/pwa-update';
import type { PwaUpdateEffects } from '../lib/pwa-update';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));
vi.mock('../lib/build-version', () => ({ BUILD_VERSION: '0.13.0-next.68' }));

afterEach(() => {
  vi.clearAllMocks();
});

function updateFixture() {
  const effects: PwaUpdateEffects = {
    activateWaiting: vi.fn().mockResolvedValue(undefined),
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    clearInterval: vi.fn(),
    isVisible: () => true,
    listenControllerChange: () => () => {},
    listenFocus: () => () => {},
    listenOnline: () => () => {},
    listenVisibilityChange: () => () => {},
    now: () => Date.now(),
    reload: vi.fn(),
    setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
  };
  return { controller: createPwaUpdateController(effects), effects };
}

function renderFooter(controller = updateFixture().controller) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PwaUpdateProvider controller={controller}>
        <VersionFooter />
      </PwaUpdateProvider>
    </QueryClientProvider>,
  );
}

describe('versionFooter (MMR-260)', () => {
  it('renders the daemon-reported version once /api/health answers', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.13.0-next.68' });
    renderFooter();
    await expect(screen.findByText('0.13.0-next.68')).resolves.toBeDefined();
    expect(screen.queryByText(/update available/)).toBeNull();
  });

  it('renders the bundle version before the daemon answers', () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    renderFooter();
    // synchronous assertion: the query is still pending, so the fallback
    // (the bundle's own version) is on screen, not the not-yet-fetched daemon's.
    expect(screen.getByText('0.13.0-next.68')).toBeDefined();
  });

  it('offers the shared refresh action when the daemon reports a different version', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    const { controller, effects } = updateFixture();
    renderFooter(controller);
    await expect(screen.findByText('0.14.0-next.3')).resolves.toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: /refresh console/ }));
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('activates a waiting worker through the same footer action', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    const { controller, effects } = updateFixture();
    controller.workerWaiting();
    renderFooter(controller);
    await userEvent.click(await screen.findByRole('button', { name: /refresh console/ }));
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
    expect(effects.reload).not.toHaveBeenCalled();
  });

  it('reloads directly after another tab has activated the update', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    const { controller, effects } = updateFixture();
    controller.controllerChanged();
    renderFooter(controller);
    await userEvent.click(await screen.findByRole('button', { name: /refresh console/ }));
    expect(effects.activateWaiting).not.toHaveBeenCalled();
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('disables the mismatch action while an update is applying', async () => {
    apiGet.mockResolvedValue({ schema: 4, status: 'ok', version: '0.14.0-next.3' });
    const { controller } = updateFixture();
    controller.workerWaiting();
    await controller.refreshNow();
    renderFooter(controller);
    await expect(screen.findByRole('button', { name: /refreshing/ })).resolves.toBeDisabled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PwaRefreshAction } from '../components/pwa-refresh-action';
import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { createPwaUpdateController } from '../lib/pwa-update';
import type { PwaUpdateEffects } from '../lib/pwa-update';

function fixture() {
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

function renderUpdate(
  controller: ReturnType<typeof createPwaUpdateController>,
  child = <PwaUpdateBanner />,
) {
  render(<PwaUpdateProvider controller={controller}>{child}</PwaUpdateProvider>);
}

describe('PWA update surfaces (MMR-369)', () => {
  it('keeps the banner absent while idle', () => {
    const { controller } = fixture();
    renderUpdate(controller);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a persistent waiting action and applies explicitly', async () => {
    const { controller, effects } = fixture();
    controller.workerWaiting();
    renderUpdate(controller);
    expect(screen.getByRole('status')).toHaveTextContent("refresh when you're done");
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  });

  it('offers a direct per-tab refresh after activation elsewhere', async () => {
    const { controller, effects } = fixture();
    controller.controllerChanged();
    renderUpdate(controller);
    expect(screen.getByRole('status')).toHaveTextContent('Update installed');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('keeps activation failures visible and retryable', async () => {
    const { controller, effects } = fixture();
    vi.mocked(effects.activateWaiting).mockRejectedValueOnce(new Error('activation refused'));
    controller.workerWaiting();
    renderUpdate(controller);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await expect(screen.findByText('activation refused')).resolves.toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled();
  });

  it('shows the compact action only in standalone mode and checks while idle', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(display-mode: standalone)',
      media: query,
      removeEventListener: vi.fn(),
    }));
    const { controller, effects } = fixture();
    renderUpdate(controller, <PwaRefreshAction />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh console' }));
    expect(effects.checkForUpdate).toHaveBeenCalledOnce();
  });

  it('marks the standalone action when an update is ready', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(display-mode: standalone)',
      media: query,
      removeEventListener: vi.fn(),
    }));
    const { controller, effects } = fixture();
    controller.workerWaiting();
    renderUpdate(controller, <PwaRefreshAction />);
    await userEvent.click(screen.getByRole('button', { name: 'Update ready — refresh console' }));
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
  });

  it('names the standalone retry when an update check fails', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(display-mode: standalone)',
      media: query,
      removeEventListener: vi.fn(),
    }));
    const { controller, effects } = fixture();
    vi.mocked(effects.checkForUpdate).mockRejectedValueOnce(new Error('network down'));
    renderUpdate(controller, <PwaRefreshAction />);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh console' }));

    await expect(
      screen.findByRole('button', { name: 'Update failed — retry' }),
    ).resolves.toBeEnabled();
  });
});

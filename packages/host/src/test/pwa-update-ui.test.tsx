import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { TopBarMore } from '../components/top-bar-more';
import { createPwaUpdateController } from '../lib/pwa-update';
import type { PwaUpdateEffects } from '../lib/pwa-update';
import { renderInRouter } from './router';

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

/** The installed console: the update check is offered. */
function standalone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: vi.fn(),
    matches: query === '(display-mode: standalone)',
    media: query,
    removeEventListener: vi.fn(),
  }));
}

async function renderUpdate(
  controller: ReturnType<typeof createPwaUpdateController>,
  child = <PwaUpdateBanner />,
) {
  await renderInRouter(<PwaUpdateProvider controller={controller}>{child}</PwaUpdateProvider>);
}

describe('PWA update surfaces (MMR-369)', () => {
  it('keeps the banner absent while idle', async () => {
    const { controller } = fixture();
    await renderUpdate(controller);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a persistent waiting action and applies explicitly', async () => {
    const { controller, effects } = fixture();
    controller.workerWaiting();
    await renderUpdate(controller);
    expect(screen.getByRole('status')).toHaveTextContent("refresh when you're done");
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  });

  it('offers a direct per-tab refresh after activation elsewhere', async () => {
    const { controller, effects } = fixture();
    controller.controllerChanged();
    await renderUpdate(controller);
    expect(screen.getByRole('status')).toHaveTextContent('Update installed');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('keeps activation failures visible and retryable', async () => {
    const { controller, effects } = fixture();
    vi.mocked(effects.activateWaiting).mockRejectedValueOnce(new Error('activation refused'));
    controller.workerWaiting();
    await renderUpdate(controller);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await expect(screen.findByText('activation refused')).resolves.toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled();
  });

  it('offers the check in More only in standalone mode and checks while idle', async () => {
    standalone();
    const { controller, effects } = fixture();
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Refresh console' }));
    expect(effects.checkForUpdate).toHaveBeenCalledOnce();
  });

  it('marks More when an update is ready', async () => {
    standalone();
    const { controller, effects } = fixture();
    controller.workerWaiting();
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'More, update ready' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Update ready — refresh console' }),
    );
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
  });

  it('names the retry when an update check fails', async () => {
    standalone();
    const { controller, effects } = fixture();
    vi.mocked(effects.checkForUpdate).mockRejectedValueOnce(new Error('network down'));
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Refresh console' }));

    await expect(
      screen.findByRole('menuitem', { name: 'Update failed — retry' }),
    ).resolves.toBeVisible();
  });

  it('names a ready update in More and applies it from there (MMR-715)', async () => {
    standalone();
    const { controller, effects } = fixture();
    controller.workerWaiting();
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'More, update ready' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Update ready — refresh console' }),
    );

    expect(effects.activateWaiting).toHaveBeenCalledOnce();
  });

  it('leaves the update item out of More outside the installed console', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: vi.fn(),
      matches: false,
      media: query,
      removeEventListener: vi.fn(),
    }));
    const { controller } = fixture();
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'More' }));

    await expect(
      screen.findByRole('menuitem', { name: 'Switch to light theme' }),
    ).resolves.toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /refresh|update/i })).toBeNull();
  });

  it('keeps More open while a check runs, so its progress shows (MMR-715)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(display-mode: standalone)',
      media: query,
      removeEventListener: vi.fn(),
    }));
    const { controller, effects } = fixture();
    const check = Promise.withResolvers<void>();
    vi.mocked(effects.checkForUpdate).mockReturnValueOnce(check.promise);
    await renderUpdate(controller, <TopBarMore theme="dark" onToggleTheme={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Refresh console' }));

    expect(effects.checkForUpdate).toHaveBeenCalledOnce();
    expect(screen.getByRole('menu')).toBeVisible();
    await expect(
      screen.findByRole('menuitem', { name: 'Checking for updates' }),
    ).resolves.toBeVisible();

    await act(async () => {
      check.resolve();
    });

    await expect(screen.findByRole('menuitem', { name: 'Refresh console' })).resolves.toBeVisible();
  });
});

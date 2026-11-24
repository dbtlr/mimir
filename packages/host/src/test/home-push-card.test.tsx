import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushDevices, pushStatus, subscribePush } from '../api/fns/push';
import type { PushStatus } from '../api/fns/push';
import type { PushBrowser } from '../lib/push-browser';
import { PushBrowserContext } from '../lib/use-push-browser';
import { consoleRoutes } from '../router';
import { CONSOLE_ORIGIN, fakeBrowser, IPHONE, servePush } from './push-fns';
import type { FakeBrowser } from './push-fns';
import { renderRoute } from './router';
import { failShellReads, serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/push');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

/*
 * Home's one-time card suggesting notifications (ADR 0045, MMR-734): when it
 * shows, what each answer does, and that it never shows again in this browser.
 * The rule itself (`suggestsTurningOn`) is proved in push-state.test.ts; here
 * each case proves its wiring on the page.
 */

const CARD = 'Get notified when something needs you';
const PROJECTS = [stripRow({ key: 'MMR', name: 'Mimir' })];

beforeEach(() => {
  serveViews({ review: engineReview({ projects: PROJECTS }) });
  serveShell();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provide(browser: PushBrowser) {
  return function Provide({ children }: { children: ReactNode }) {
    return <PushBrowserContext.Provider value={browser}>{children}</PushBrowserContext.Provider>;
  };
}

/** Let pending promises and the query client's batched notifications run, a few task turns deep. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      // oxlint-disable-next-line no-await-in-loop -- each turn waits for the one before it
      await promise;
    }
  });
}

/** Open Home on `browser`, with the host's push channel answering `status`. */
async function openHome(
  browser: FakeBrowser,
  options: { status?: PushStatus; viewport?: Viewport; client?: QueryClient } = {},
) {
  stubViewport(options.viewport ?? 'desktop');
  const world = servePush(options.status === undefined ? {} : { status: options.status });
  const view = await renderRoute(
    consoleRoutes,
    '/',
    options.client ?? new QueryClient(),
    provide(browser),
  );
  await screen.findByRole('heading', { level: 1 });
  await settle();
  return { view, world };
}

const card = () => screen.queryByRole('region', { name: CARD });

describe('the notifications card on Home (MMR-734)', () => {
  it.each<Viewport>(['desktop', 'phone'])(
    'suggests turning on a browser that has never asked, above Needs you (%s)',
    async (viewport) => {
      await openHome(fakeBrowser(), { viewport });

      const shown = await screen.findByRole('region', { name: CARD });
      expect(within(shown).getByRole('button', { name: 'Turn on' })).toBeEnabled();
      expect(within(shown).getByRole('button', { name: 'Not now' })).toBeEnabled();
      // Nothing needs this page's operator, so Needs you is its quiet line.
      const needs = screen.getByText('Nothing needs you.');
      expect(shown.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  it('stays away when the host has no push channel', async () => {
    await openHome(fakeBrowser(), { status: { state: 'unconfigured' } });
    expect(pushStatus).toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it.each<[string, () => FakeBrowser]>([
    [
      'an iPhone is outside the Home Screen app',
      () =>
        fakeBrowser({
          snapshot: {
            identity: { ...IPHONE, browser: 'Safari', installed: false },
            pushSupported: false,
          },
        }),
    ],
    ['permission was asked before', () => fakeBrowser({ permission: 'granted' })],
  ])('stays away, and asks the host nothing, when %s', async (_name, make) => {
    await openHome(make());
    expect(card()).toBeNull();
    expect(pushStatus).not.toHaveBeenCalled();
    expect(pushDevices).not.toHaveBeenCalled();
  });

  it('stays away once this browser answered it, asking the host nothing', async () => {
    const browser = fakeBrowser();
    browser.answerSuggestion();
    await openHome(browser);
    expect(card()).toBeNull();
    expect(pushStatus).not.toHaveBeenCalled();
  });

  it('stays away when another tab answers it before the host replies', async () => {
    const browser = fakeBrowser();
    stubViewport('desktop');
    servePush();
    const reply = Promise.withResolvers<PushStatus>();
    vi.mocked(pushStatus).mockReturnValue(reply.promise);
    await renderRoute(consoleRoutes, '/', new QueryClient(), provide(browser));
    await screen.findByRole('heading', { level: 1 });

    browser.answerSuggestion();
    reply.resolve({ consoleOrigin: CONSOLE_ORIGIN, publicKey: 'BKey', state: 'ready' });
    await settle();
    expect(card()).toBeNull();
  });

  it('hides when another tab answers it, handing focus to the page', async () => {
    const browser = fakeBrowser();
    await openHome(browser);
    const turnOn = await screen.findByRole('button', { name: 'Turn on' });
    turnOn.focus();

    act(() => {
      browser.answerInAnotherTab();
    });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('moves no focus when another tab answers it and focus was never in it', async () => {
    const browser = fakeBrowser();
    await openHome(browser);
    await screen.findByRole('region', { name: CARD });
    expect(document.activeElement).toBe(document.body);

    act(() => {
      browser.answerInAnotherTab();
    });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('moves no focus when the card never showed', async () => {
    // The card waits on the host's status, which offers no push channel, so it never shows.
    await openHome(fakeBrowser(), { status: { state: 'unconfigured' } });
    expect(pushStatus).toHaveBeenCalled();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('Not now retires the card in this browser', async () => {
    const browser = fakeBrowser();
    const { view } = await openHome(browser);

    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(card()).toBeNull();
    expect(subscribePush).not.toHaveBeenCalled();
    expect(browser.permission).toBe('default');

    view.unmount();
    await openHome(browser);
    expect(card()).toBeNull();
  });

  it('Turn on asks, subscribes this browser, and leaves', async () => {
    const browser = fakeBrowser();
    await openHome(browser);

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(card()).toBeNull();
    });
    expect(browser.permission).toBe('granted');
    expect(subscribePush).toHaveBeenCalledOnce();
  });

  it('Turn on retires the card even when the prompt is dismissed, and says where to try again', async () => {
    const browser = fakeBrowser();
    browser.promptAnswer = 'default';
    const { view } = await openHome(browser);

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByRole('region', { name: CARD });
    await within(shown).findByText(/Notifications were not turned on/);
    expect(
      within(shown).getByRole('link', { name: 'Turn on in Settings › Notifications' }),
    ).toHaveAttribute('href', '/settings/notifications');
    expect(within(shown).queryByRole('button', { name: 'Turn on' })).toBeNull();

    await userEvent.click(within(shown).getByRole('button', { name: 'Close' }));
    expect(card()).toBeNull();

    view.unmount();
    await openHome(browser);
    expect(browser.permission).toBe('default');
    expect(card()).toBeNull();
  });

  it('a Turn on from Settings › Notifications retires it too', async () => {
    const browser = fakeBrowser();
    browser.promptAnswer = 'default';
    stubViewport('desktop');
    servePush();
    const settings = await renderRoute(
      consoleRoutes,
      '/settings/notifications',
      new QueryClient(),
      provide(browser),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await screen.findByText(/Notifications were not turned on/);
    settings.unmount();

    await openHome(browser);
    expect(browser.permission).toBe('default');
    expect(card()).toBeNull();
  });

  it('hands focus to the page when its answer removes it', async () => {
    await openHome(fakeBrowser());
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('stays up with no way out while Turn on runs, keeping focus in the card', async () => {
    const browser = fakeBrowser();
    await openHome(browser);
    const pending = Promise.withResolvers<{ state: 'subscribed' }>();
    vi.mocked(subscribePush).mockReturnValue(pending.promise);

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByRole('region', { name: CARD });
    await within(shown).findByText('Turning notifications on…');
    expect(within(shown).queryByRole('button')).toBeNull();
    expect(shown.contains(document.activeElement)).toBe(true);

    vi.mocked(subscribePush).mockRejectedValue(new Error('unreachable'));
    pending.reject(new Error('unreachable'));
    const close = await within(shown).findByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
  });

  it('shows the address a wrong-origin refusal names', async () => {
    const browser = fakeBrowser();
    const { world } = await openHome(browser);
    world.subscribe = { state: 'wrong_origin' };

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByRole('region', { name: CARD });
    await expect(
      within(shown).findByRole('link', { name: CONSOLE_ORIGIN }),
    ).resolves.toHaveAttribute('href', CONSOLE_ORIGIN);
  });

  it('shows why Turn on failed', async () => {
    const browser = fakeBrowser();
    await openHome(browser);
    vi.mocked(subscribePush).mockRejectedValue(new Error('unreachable'));

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByRole('region', { name: CARD });
    await within(shown).findByText("This browser couldn't turn notifications on. Try again.");
    expect(
      within(shown).getByRole('link', { name: 'Turn on in Settings › Notifications' }),
    ).toBeDefined();
  });

  it('cannot be answered while the host is unreachable', async () => {
    failShellReads();
    await openHome(fakeBrowser(), {
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    await screen.findByText(/Offline/);

    const shown = await screen.findByRole('region', { name: CARD });
    expect(within(shown).getByRole('button', { name: 'Turn on' })).toBeDisabled();
    expect(within(shown).getByRole('button', { name: 'Not now' })).toBeDisabled();
  });
});

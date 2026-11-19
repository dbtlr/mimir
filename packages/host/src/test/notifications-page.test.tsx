import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pushDevices,
  resetPushKey,
  sendTestPush,
  subscribePush,
  unsubscribePush,
} from '../api/fns/push';
import { PushHealer } from '../components/push-healer';
import { PushBrowserContext } from '../lib/use-push-browser';
import { consoleRoutes } from '../router';
import {
  CONSOLE_ORIGIN,
  device,
  fakeBrowser,
  servePush,
  SERVED_KEY,
  SUBSCRIPTION,
} from './push-fns';
import type { FakeBrowser, PushWorld } from './push-fns';
import { renderRoute } from './router';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';

vi.mock('../api/fns/push');

/*
 * The Settings › Notifications page and the healer (ADR 0045, MMR-711): this
 * browser's control in each state at both layouts, the actions, and the
 * subscribed browsers' rows. The pure rules (states, wording, healing
 * decisions) are proved in push-state.test.ts; here each case proves the
 * wiring of one of them.
 */

const PHONE = { browser: 'Safari', installed: true, platform: 'iPhone' } as const;
const MAC = { browser: 'Chrome', installed: false, platform: 'Mac' } as const;

const other = device({
  endpoint: 'https://push.example/other',
  label: 'Android · Chrome',
  lastSuccessAt: '2026-11-19T09:00:00.000Z',
});
const oldKey = device({
  currentKey: false,
  endpoint: 'https://push.example/old',
  label: 'Windows · Edge',
});
const mine = device({ endpoint: SUBSCRIPTION.endpoint, label: 'Mac · Chrome' });

function withBrowser(browser: FakeBrowser) {
  return function Provide({ children }: { children: ReactNode }) {
    return <PushBrowserContext.Provider value={browser}>{children}</PushBrowserContext.Provider>;
  };
}

async function open(
  viewport: Viewport,
  options: { browser?: FakeBrowser; world?: Partial<PushWorld>; path?: string } = {},
) {
  stubViewport(viewport);
  const world = servePush(options.world);
  const browser = options.browser ?? fakeBrowser();
  await renderRoute(
    consoleRoutes,
    '/settings/notifications',
    new QueryClient(),
    withBrowser(browser),
  );
  await screen.findByRole('heading', { level: 1, name: 'Notifications' });
  // Let the browser's own answer land, so no update arrives outside a test's act.
  await act(async () => {
    await Promise.resolve();
  });
  return { browser, world };
}

const group = (name: string) => screen.getByRole('region', { name });
const thisDevice = () => group('This device');

/** The page's actions for a browser that has turned notifications on. */
const onBrowser = () =>
  fakeBrowser({
    held: SUBSCRIPTION,
    permission: 'granted',
    record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
  });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type StateCase = {
  name: string;
  world?: Partial<PushWorld>;
  browser: () => FakeBrowser;
  caption: string;
  buttons: string[];
};

const cases: StateCase[] = [
  {
    browser: () => fakeBrowser(),
    buttons: [],
    caption: "Notifications aren't set up on this host. Set MIMIR_PUSH_CONTACT",
    name: 'unconfigured',
    world: { status: { state: 'unconfigured' } },
  },
  {
    browser: () => fakeBrowser(),
    buttons: [],
    caption: "Notifications can't start: MIMIR_URL is unset.",
    name: 'misconfigured',
    world: { status: { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' } },
  },
  {
    browser: () => fakeBrowser(),
    buttons: ['Reset push key…'],
    caption: "This host can't open its push key, usually because MIMIR_SECRET_KEY changed.",
    name: 'key unusable',
    world: { status: { state: 'key_unusable' } },
  },
  {
    browser: () =>
      fakeBrowser({
        snapshot: {
          identity: { browser: 'Safari', installed: false, platform: 'iPhone' },
          pushSupported: false,
        },
      }),
    buttons: ['Reset push key…'],
    caption:
      'On iPhone, notifications only reach the console when it is opened from the Home Screen.',
    name: 'iOS outside the Home Screen',
  },
  {
    browser: () => fakeBrowser({ snapshot: { pushSupported: false } }),
    buttons: ['Reset push key…'],
    caption: "This browser can't receive push notifications.",
    name: 'unsupported',
  },
  {
    browser: () => fakeBrowser({ permission: 'denied' }),
    buttons: ['Reset push key…'],
    caption: 'You declined notifications here.',
    name: 'denied',
  },
  {
    browser: () => fakeBrowser({ record: { state: 'removed' } }),
    buttons: ['Turn on', 'Reset push key…'],
    caption: 'This browser was removed from the list, or its push service stopped accepting',
    name: 'removed',
  },
  {
    browser: () => fakeBrowser(),
    buttons: ['Turn on', 'Reset push key…'],
    caption: 'Turn on to get a notification on this device when something needs you.',
    name: 'off',
  },
  {
    browser: onBrowser,
    buttons: ['Turn off', 'Send test notification', 'Reset push key…'],
    caption: 'No notification yet.',
    name: 'on',
    world: { devices: [mine] },
  },
];

describe('this browser in each state', () => {
  it.each(cases.flatMap((c) => (['phone', 'desktop'] as const).map((v) => [v, c] as const)))(
    'on a %s: %s',
    async (viewport, c) => {
      await open(viewport, { browser: c.browser(), world: c.world });
      await waitFor(() => {
        expect(thisDevice()).toHaveTextContent(c.caption);
      });
      const names = new Set(['Turn on', 'Turn off', 'Send test notification', 'Reset push key…']);
      const shown = screen
        .queryAllByRole('button')
        .map((b) => b.textContent ?? '')
        .filter((text) => names.has(text));
      expect(shown.toSorted()).toStrictEqual(c.buttons.toSorted());
    },
  );

  it('walks the Home Screen steps on an iPhone', async () => {
    await open('phone', {
      browser: fakeBrowser({
        snapshot: {
          identity: { browser: 'Safari', installed: false, platform: 'iPhone' },
          pushSupported: false,
        },
      }),
    });
    await expect(within(thisDevice()).findAllByRole('listitem')).resolves.toHaveLength(4);
  });

  it('adds the desktop hint and the macOS path on Chrome for Mac', async () => {
    await open('desktop', { browser: onBrowser(), world: { devices: [mine] } });
    await expect(
      within(thisDevice()).findByText(/System Settings › Notifications › Google Chrome/),
    ).resolves.toBeInTheDocument();
  });

  it('shows the generated label under the control', async () => {
    await open('phone', { browser: fakeBrowser({ snapshot: { identity: PHONE } }) });
    await expect(
      within(thisDevice()).findByText('iPhone · Home Screen app'),
    ).resolves.toBeInTheDocument();
  });
});

describe('Turn on', () => {
  it('subscribes with the served key and the generated label, writes the record, and shows On', async () => {
    const { browser } = await open('phone', {
      browser: fakeBrowser({ snapshot: { identity: MAC } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    expect(subscribePush).toHaveBeenCalledWith({
      data: {
        auth: SUBSCRIPTION.auth,
        endpoint: SUBSCRIPTION.endpoint,
        label: 'Mac · Chrome',
        p256dh: SUBSCRIPTION.p256dh,
        serverKey: SERVED_KEY,
      },
    });
    expect(browser.record).toStrictEqual({ endpoint: SUBSCRIPTION.endpoint, state: 'on' });
  });

  it('shows a link to the console address on a wrong origin, and leaves the browser unsubscribed', async () => {
    const { browser } = await open('phone', { world: { subscribe: { state: 'wrong_origin' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const link = await screen.findByRole('link', { name: CONSOLE_ORIGIN });
    expect(link).toHaveAttribute('href', CONSOLE_ORIGIN);
    expect(thisDevice()).toHaveTextContent(`Open the console at ${CONSOLE_ORIGIN} to turn on`);
    expect(browser.held).toBeNull();
    expect(browser.record).toBeNull();
  });

  it('says why when the host keeps no more browsers', async () => {
    await open('phone', { world: { subscribe: { state: 'too_many_devices' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent('20 browsers are subscribed, the most a host keeps.');
    });
  });

  it('shows the blocked state when the prompt is declined', async () => {
    const browser = fakeBrowser();
    browser.promptAnswer = 'denied';
    await open('phone', { browser });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent('You declined notifications here.');
    });
    expect(subscribePush).not.toHaveBeenCalled();
  });
});

describe('on this device', () => {
  it('Turn off drops the subscription here and on the host, and clears the record', async () => {
    const browser = onBrowser();
    await open('phone', { browser, world: { devices: [mine] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await expect(screen.findByRole('button', { name: 'Turn on' })).resolves.toBeInTheDocument();
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
    expect(browser.held).toBeNull();
    expect(browser.record).toBeNull();
  });

  it('Turn off forgets the record even when the host call fails, so the healer cannot turn it back on', async () => {
    const browser = onBrowser();
    vi.mocked(unsubscribePush).mockRejectedValueOnce(new Error('host down'));
    await open('phone', { browser, world: { devices: [mine] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(unsubscribePush).toHaveBeenCalled();
    });
    expect(browser.record).toBeNull();
  });

  it('Send test notification shows the answer under the group', async () => {
    await open('phone', { browser: onBrowser(), world: { devices: [mine] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Send test notification' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent('Test sent. It should appear in a few seconds.');
    });
    expect(sendTestPush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
  });
});

describe('subscribed browsers', () => {
  const world = { devices: [mine, other, oldKey] };

  it('lists every browser with its meta, and marks this one without actions', async () => {
    await open('phone', { browser: onBrowser(), world });
    const list = await screen.findByRole('region', { name: 'Subscribed browsers · 3' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toStrictEqual([
      expect.stringContaining('Mac · ChromeThis device'),
      expect.stringContaining('Android · Chromedelivered'),
      expect.stringContaining('Windows · EdgeOld key'),
    ]);
    // This browser's row is not a button; the other two are.
    expect(within(list).getAllByRole('button')).toHaveLength(2);
  });

  it('on a phone, a row opens a sheet whose Send test shows its answer in the row', async () => {
    await open('phone', {
      browser: onBrowser(),
      world: { ...world, sendTest: { failure: 'HTTP 503', state: 'failed' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Android · Chrome/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Send test notification' }));
    expect(sendTestPush).toHaveBeenCalledWith({ data: { endpoint: other.endpoint } });
    await waitFor(() => {
      expect(group('Subscribed browsers · 3')).toHaveTextContent('Test failed: HTTP 503.');
    });
  });

  it('on a phone, Remove this browser removes the row', async () => {
    await open('phone', { browser: onBrowser(), world });
    await userEvent.click(await screen.findByRole('button', { name: /^Android · Chrome/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Remove this browser' }));
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: other.endpoint } });
    await expect(
      screen.findByRole('region', { name: 'Subscribed browsers · 2' }),
    ).resolves.toBeInTheDocument();
  });

  it('on a phone, an old-key row offers only Remove', async () => {
    await open('phone', { browser: onBrowser(), world });
    await userEvent.click(await screen.findByRole('button', { name: /^Windows · Edge/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Windows · Edge' });
    expect(
      within(sheet)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['Remove this browser', 'Cancel']);
  });

  it('on a desktop, a row has a menu with Send test and Remove', async () => {
    await open('desktop', { browser: onBrowser(), world });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for Android · Chrome' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Send test notification' }));
    expect(sendTestPush).toHaveBeenCalledWith({ data: { endpoint: other.endpoint } });
    await waitFor(() => {
      expect(group('Subscribed browsers · 3')).toHaveTextContent('Test sent.');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Android · Chrome' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove this browser' }));
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: other.endpoint } });
  });
});

describe('Reset push key', () => {
  it('asks first, and does nothing on Cancel', async () => {
    await open('phone', { world: { devices: [other] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Reset push key…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Reset the push key?' });
    expect(sheet).toHaveTextContent('Every device stops receiving notifications');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(resetPushKey).not.toHaveBeenCalled();
  });

  it('resets once confirmed', async () => {
    await open('phone', { world: { devices: [other] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Reset push key…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Reset the push key?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Reset' }));
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
  });

  it('is offered with the full message when the host cannot open its key', async () => {
    await open('desktop', { world: { status: { state: 'key_unusable' } } });
    await expect(
      within(thisDevice()).findByText(/Notifications are paused on every device\./),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reset push key…' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reset push key…' }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Reset the push key?' })).getByRole(
        'button',
        {
          name: 'Reset',
        },
      ),
    );
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
  });
});

async function mountHealer(browser: FakeBrowser, world: Partial<PushWorld>) {
  servePush(world);
  const Provide = withBrowser(browser);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Provide>
        <PushHealer />
      </Provide>
    </QueryClientProvider>,
  );
}

describe('healing when the console opens', () => {
  it('asks the host nothing for a browser that never turned notifications on', async () => {
    await mountHealer(fakeBrowser({ permission: 'granted' }), { devices: [] });
    await Promise.resolve();
    expect(pushDevices).not.toHaveBeenCalled();
  });

  it('subscribes again with the served key after a key reset, and drops the old endpoint', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
      permission: 'granted',
      record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
    });
    await mountHealer(browser, { devices: [{ ...mine, currentKey: false }] });
    await waitFor(() => {
      expect(subscribePush).toHaveBeenCalledOnce();
    });
    expect(browser.held?.applicationServerKey).toBe(SERVED_KEY);
    expect(subscribePush).toHaveBeenCalledWith({
      data: expect.objectContaining({ label: 'Mac · Chrome', serverKey: SERVED_KEY }),
    });
  });

  it('stays off when the host no longer lists it', async () => {
    const browser = onBrowser();
    await mountHealer(browser, { devices: [] });
    await waitFor(() => {
      expect(browser.record).toStrictEqual({ state: 'removed' });
    });
    expect(browser.held).toBeNull();
    expect(subscribePush).not.toHaveBeenCalled();
  });
});

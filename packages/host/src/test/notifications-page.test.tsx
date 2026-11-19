import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pushDevices,
  pushStatus,
  resetPushKey,
  sendTestPush,
  subscribePush,
  unsubscribePush,
} from '../api/fns/push';
import { pushDevicesQuery } from '../api/push-queries';
import { PushHealer } from '../components/push-healer';
import { healThisBrowser } from '../lib/push-actions';
import { createPushBrowser } from '../lib/push-browser';
import type { PushBrowser } from '../lib/push-browser';
import { PushBrowserContext } from '../lib/use-push-browser';
import { consoleRoutes } from '../router';
import {
  CONSOLE_ORIGIN,
  device,
  fakeBrowser,
  READY,
  readyWith,
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
 * browser's control in each state, the actions, the subscribed browsers' rows
 * at both layouts, and healing. The pure rules (states, wording, healing
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

/** Re-renders the provider, as a navigation re-renders the shell; set by each render. */
let rerenderShell: () => void = () => {};

/** The browser in context, with the shell's healer beside the page, as the console mounts them. */
function withBrowser(browser: PushBrowser) {
  return function Provide({ children }: { children: ReactNode }) {
    const [renders, setRenders] = useState(0);
    rerenderShell = () => {
      setRenders((count) => count + 1);
    };
    return (
      <PushBrowserContext.Provider value={browser}>
        <PushHealer />
        <div data-renders={renders}>{children}</div>
      </PushBrowserContext.Provider>
    );
  };
}

/** Open the page on a fake browser, with the host answering from `world`. */
async function open(
  viewport: Viewport,
  options: { browser?: FakeBrowser; world?: Partial<PushWorld> } = {},
) {
  stubViewport(viewport);
  const world = servePush(options.world);
  const browser = options.browser ?? fakeBrowser();
  await mount(browser);
  return { browser, world };
}

/** Render the page and the shell's healer on `browser`. */
async function mount(browser: PushBrowser) {
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

const group = (name: string) => screen.getByRole('region', { name });
const thisDevice = () => group('This device');

/** The control's buttons by name, wherever the page places them. */
const CONTROL = new Set(['Turn on', 'Turn off', 'Send test notification', 'Reset push key…']);
const controlButtons = () =>
  screen
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((text) => CONTROL.has(text))
    .toSorted();

/** A browser that has turned notifications on. */
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
  buttons: string[];
};

const cases: StateCase[] = [
  {
    browser: () => fakeBrowser(),
    buttons: [],
    name: 'unconfigured',
    world: { status: { state: 'unconfigured' } },
  },
  {
    browser: () => fakeBrowser(),
    buttons: [],
    name: 'misconfigured',
    world: { status: { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' } },
  },
  {
    browser: () => fakeBrowser(),
    buttons: ['Reset push key…'],
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
    name: 'iOS outside the Home Screen',
  },
  {
    browser: () => fakeBrowser({ snapshot: { pushSupported: false } }),
    buttons: ['Reset push key…'],
    name: 'unsupported',
  },
  {
    browser: () => fakeBrowser({ permission: 'denied' }),
    buttons: ['Reset push key…'],
    name: 'denied',
  },
  {
    browser: () => fakeBrowser({ record: { state: 'removed' } }),
    buttons: ['Reset push key…', 'Turn on'],
    name: 'removed',
  },
  {
    browser: () => fakeBrowser(),
    buttons: ['Reset push key…', 'Turn on'],
    name: 'off',
  },
  {
    browser: onBrowser,
    buttons: ['Reset push key…', 'Send test notification', 'Turn off'],
    name: 'on',
    world: { devices: [mine] },
  },
];

describe('this browser in each state', () => {
  it.each(cases)('$name', async (c) => {
    await open('phone', { browser: c.browser(), world: c.world });
    // Every state past loading has a sentence under the group.
    await waitFor(() => {
      expect(thisDevice().querySelector('[aria-live] > p')).not.toBeNull();
    });
    expect(controlButtons()).toStrictEqual(c.buttons);
  });

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
    await open('phone', { browser: onBrowser(), world: { devices: [mine] } });
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

  it('offers Turn on when the service worker never starts', async () => {
    const store = new Map<string, string>();
    const browser = createPushBrowser({
      after: async () => {},
      maxTouchPoints: 0,
      permission: () => 'default',
      pushSupported: () => true,
      ready: async () => Promise.withResolvers<never>().promise,
      requestPermission: async () => 'granted',
      standalone: () => false,
      storage: () => ({
        getItem: (key) => store.get(key) ?? null,
        removeItem: (key) => void store.delete(key),
        setItem: (key, value) => void store.set(key, value),
      }),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36',
    });
    servePush();
    stubViewport('phone');
    await mount(browser);
    await expect(screen.findByRole('button', { name: 'Turn on' })).resolves.toBeEnabled();
  });
});

describe('Turn on', () => {
  it('subscribes with the served key and the generated label, writes the record, and shows On', async () => {
    const { browser } = await open('phone', {
      browser: fakeBrowser({ snapshot: { identity: MAC } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    const endpoint = browser.held?.endpoint;
    expect(subscribePush).toHaveBeenCalledWith({
      data: {
        auth: SUBSCRIPTION.auth,
        endpoint,
        label: 'Mac · Chrome',
        p256dh: SUBSCRIPTION.p256dh,
        serverKey: SERVED_KEY,
      },
    });
    expect(browser.record).toStrictEqual({ endpoint, state: 'on' });
  });

  it('on a stale key, rereads the status and subscribes again with the new key', async () => {
    const { browser, world } = await open('phone');
    vi.mocked(subscribePush).mockImplementationOnce(async () => {
      world.status = readyWith('BFreshKey');
      return { state: 'stale_key' };
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    expect(subscribePush).toHaveBeenCalledTimes(2);
    expect(subscribePush).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ serverKey: 'BFreshKey' }),
    });
    expect(browser.held?.applicationServerKey).toBe('BFreshKey');
    expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
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

  it('on a refusal, says why and forgets an earlier turn on whose row is gone', async () => {
    const { browser } = await open('phone', {
      browser: fakeBrowser({
        permission: 'granted',
        record: { endpoint: 'https://push.example/gone', state: 'on' },
      }),
      world: { subscribe: { state: 'too_many_devices' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent('20 browsers are subscribed, the most a host keeps.');
    });
    expect(browser.held).toBeNull();
    expect(browser.record).toBeNull();
  });

  it('on a failure, forgets an earlier removal and offers Turn on again', async () => {
    const browser = fakeBrowser({ record: { state: 'removed' } });
    browser.subscribe = async () => {
      throw new Error('push service down');
    };
    await open('phone', { browser });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent("This browser couldn't turn notifications on.");
    });
    expect(browser.record).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
  });

  it('when the permission prompt itself fails, says so and offers Turn on again', async () => {
    const browser = fakeBrowser();
    browser.requestPermission = async () => {
      throw new Error('permission API failed');
    };
    await open('phone', { browser });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent("This browser couldn't turn notifications on.");
    });
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
    expect(subscribePush).not.toHaveBeenCalled();
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

  it('is never undone by the load’s healer, even when the list then fails to reload', async () => {
    const { browser, world } = await open('phone');
    vi.mocked(subscribePush).mockImplementationOnce(async ({ data }) => {
      world.devices = [device({ endpoint: data.endpoint })];
      vi.mocked(pushDevices).mockRejectedValue(new Error('offline'));
      return { state: 'subscribed' };
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(browser.record?.state).toBe('on');
    });
    await settle();
    act(() => {
      rerenderShell();
    });
    await settle();
    expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
    expect(unsubscribePush).not.toHaveBeenCalled();
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
      expect(thisDevice()).toHaveTextContent("This browser couldn't be turned off.");
    });
    expect(browser.record).toBeNull();
  });

  it('Turn off still removes the host row when the browser cannot unsubscribe', async () => {
    const browser = onBrowser();
    browser.unsubscribe = async () => {
      throw new Error('push manager failed');
    };
    const { world } = await open('phone', { browser, world: { devices: [mine] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent("This browser couldn't be turned off.");
    });
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
    expect(world.devices).toStrictEqual([]);
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

  it('knows this browser’s row when the browser spells its endpoint differently', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, endpoint: 'https://PUSH.example/this' },
      permission: 'granted',
      record: { endpoint: 'https://PUSH.example/this', state: 'on' },
    });
    await open('phone', { browser, world: { devices: [mine] } });
    const list = await screen.findByRole('region', { name: 'Subscribed browsers · 1' });
    await waitFor(() => {
      expect(list).toHaveTextContent('This device');
    });
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
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

/** Open the reset confirmation and confirm it. */
async function confirmReset() {
  await userEvent.click(await screen.findByRole('button', { name: 'Reset push key…' }));
  const sheet = await screen.findByRole('dialog', { name: 'Reset the push key?' });
  await userEvent.click(within(sheet).getByRole('button', { name: 'Reset' }));
}

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
    await confirmReset();
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
  });

  it('from an unusable key, resets and subscribes this browser once with the new key', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: 'BLostKey' },
      permission: 'granted',
      record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
    });
    await open('phone', {
      browser,
      world: { devices: [mine], status: { state: 'key_unusable' } },
    });
    await expect(
      within(thisDevice()).findByText(/Notifications are paused on every device\./),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reset push key…' })).toHaveLength(1);
    await confirmReset();
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    await settle();
    expect(subscribePush).toHaveBeenCalledOnce();
    expect(browser.held?.applicationServerKey).toBe('BNewKey');
    expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
  });

  it('says the key was reset when only the reread after it fails', async () => {
    const { world } = await open('phone', { world: { devices: [other] } });
    vi.mocked(resetPushKey).mockImplementationOnce(async () => {
      vi.mocked(pushStatus).mockRejectedValue(new Error('offline'));
      return world.reset;
    });
    await confirmReset();
    await waitFor(() => {
      expect(thisDevice()).toHaveTextContent('The push key was reset');
    });
    expect(document.body).not.toHaveTextContent("couldn't be reset");
  });
});

async function mountHealer(
  browser: FakeBrowser,
  world: Partial<PushWorld>,
  client = new QueryClient(),
) {
  const served = servePush(world);
  const Provide = withBrowser(browser);
  render(
    <QueryClientProvider client={client}>
      <Provide>{null}</Provide>
    </QueryClientProvider>,
  );
  return served;
}

describe('healing when the console opens', () => {
  it('asks the host nothing for a browser that never turned notifications on', async () => {
    await mountHealer(fakeBrowser({ permission: 'granted' }), { devices: [] });
    await settle();
    expect(pushDevices).not.toHaveBeenCalled();
  });

  it('subscribes again with the served key after a key reset, once, and drops the old endpoint', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
      permission: 'granted',
      record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
    });
    await mountHealer(browser, { devices: [{ ...mine, currentKey: false }] });
    await waitFor(() => {
      expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
    });
    expect(browser.held?.applicationServerKey).toBe(SERVED_KEY);
    expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
    expect(subscribePush).toHaveBeenCalledWith({
      data: expect.objectContaining({ label: 'Mac · Chrome', serverKey: SERVED_KEY }),
    });
    act(() => {
      rerenderShell();
    });
    await settle();
    expect(subscribePush).toHaveBeenCalledOnce();
  });

  it('acts once per load, so a list read before its heal that lands after it changes nothing', async () => {
    const client = new QueryClient();
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
      permission: 'granted',
      record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
    });
    const before = [{ ...mine, currentKey: false }];
    await mountHealer(browser, { devices: before }, client);
    await waitFor(() => {
      expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
    });
    await settle();
    // A list read that started before the heal answers with the list from before it.
    vi.mocked(pushDevices).mockResolvedValueOnce({ devices: before, state: 'listed' });
    await act(async () => {
      await client.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
    });
    await settle();
    expect(browser.record).toStrictEqual({ endpoint: browser.held?.endpoint, state: 'on' });
    expect(subscribePush).toHaveBeenCalledOnce();
  });

  it('sends a subscription the browser replaced, and drops the old endpoint', async () => {
    const stale = 'https://push.example/replaced';
    const browser = fakeBrowser({
      held: SUBSCRIPTION,
      permission: 'granted',
      record: { endpoint: stale, state: 'on' },
    });
    await mountHealer(browser, { devices: [device({ endpoint: stale })] });
    await waitFor(() => {
      expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: stale } });
    });
    expect(subscribePush).toHaveBeenCalledWith({
      data: expect.objectContaining({ endpoint: SUBSCRIPTION.endpoint }),
    });
    expect(browser.record).toStrictEqual({ endpoint: SUBSCRIPTION.endpoint, state: 'on' });
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

  it.each(['wrong_origin', 'too_many_devices'] as const)(
    'turns this browser off when the host refuses its new subscription (%s)',
    async (refusal) => {
      const world = servePush({ devices: [], subscribe: { state: refusal } });
      const browser = fakeBrowser({
        held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
        permission: 'granted',
        record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
      });
      await healThisBrowser(browser, READY, { devices: world.devices, state: 'listed' });
      expect(subscribePush).toHaveBeenCalledOnce();
      expect(browser.held).toBeNull();
      expect(browser.record).toBeNull();
    },
  );
});

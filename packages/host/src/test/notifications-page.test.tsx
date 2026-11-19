import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { PushStatus } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { PushHealer } from '../components/push-healer';
import { HEAL_WAIT_MS, healThisBrowser } from '../lib/push-actions';
import { createPushBrowser } from '../lib/push-browser';
import type { BrowserSubscription, PushBrowser } from '../lib/push-browser';
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

/** The host's status, reread as the healer and Turn on reread it. */
const readStatus = async () => pushStatus();

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

/** A browser that turned notifications on and has since dropped its subscription. */
const dropped = () =>
  fakeBrowser({
    permission: 'granted',
    record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
  });

/** A browser that has turned notifications on. */
const onBrowser = () =>
  fakeBrowser({
    held: SUBSCRIPTION,
    permission: 'granted',
    record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
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
    expect(browser.record).toStrictEqual({ endpoint, serverKey: SERVED_KEY, state: 'on' });
  });

  it('keeps the key it subscribed with when the browser does not say it', async () => {
    const browser = fakeBrowser();
    const subscribe = browser.subscribe;
    browser.subscribe = async (publicKey) => {
      browser.held = { ...(await subscribe(publicKey)), applicationServerKey: null };
      return browser.held;
    };
    await open('phone', { browser });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
    });
  });

  it('waits for the load’s heal, so the two never subscribe at once', async () => {
    const browser = dropped();
    stubViewport('phone');
    servePush({ devices: [mine] });
    const serve = vi.mocked(subscribePush).getMockImplementation();
    const sending = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    // The host takes the load's subscription; its answer is held until Turn on is clicked.
    vi.mocked(subscribePush).mockImplementationOnce(async (call) => {
      const answer = await serve?.(call);
      sending.resolve();
      await answered.promise;
      return answer ?? { state: 'subscribed' };
    });
    await mount(browser);
    await act(async () => {
      await sending.promise;
    });
    const subscribe = vi.spyOn(browser, 'subscribe');
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
      await settle();
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      answered.resolve();
    }
    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledOnce();
    });
    await settle();
    expect(subscribePush).toHaveBeenCalledTimes(2);
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
    });
  });

  it('asks for permission before it waits for the load’s heal, so the click keeps its user activation', async () => {
    const browser = dropped();
    stubViewport('phone');
    servePush({ devices: [mine] });
    const serve = vi.mocked(subscribePush).getMockImplementation();
    const sending = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    vi.mocked(subscribePush).mockImplementationOnce(async (call) => {
      const answer = await serve?.(call);
      sending.resolve();
      await answered.promise;
      return answer ?? { state: 'subscribed' };
    });
    await mount(browser);
    await act(async () => {
      await sending.promise;
    });
    const prompt = vi.spyOn(browser, 'requestPermission');
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
      await settle();
      // The heal is still held, and the prompt has already been asked.
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      answered.resolve();
      await settle();
    }
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
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: 'BFreshKey',
      state: 'on',
    });
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
        record: { endpoint: 'https://push.example/gone', serverKey: SERVED_KEY, state: 'on' },
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
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
    });
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

  it('Turn off waits for the load’s heal, so a heal that read the record first cannot turn it back on', async () => {
    const browser = onBrowser();
    const held: ((subscription: BrowserSubscription | null) => void)[] = [];
    // The page's first read answers; each later one, the heal's among them, waits for the test.
    vi.spyOn(browser, 'subscription')
      .mockResolvedValueOnce(SUBSCRIPTION)
      .mockImplementation(async () => {
        const { promise, resolve } = Promise.withResolvers<BrowserSubscription | null>();
        held.push(resolve);
        return promise;
      });
    const { world } = await open('phone', { browser, world: { devices: [mine] } });
    /** The push service dropped the subscription meanwhile, so the heal subscribes again. */
    const release = async () =>
      act(async () => {
        for (const resolve of held) {
          resolve(null);
        }
      });
    try {
      await waitFor(() => {
        expect(held.length).toBeGreaterThanOrEqual(2);
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    } finally {
      await release();
    }
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
    });
    await settle();
    expect(browser.record).toBeNull();
    expect(browser.held).toBeNull();
    expect(world.devices).toStrictEqual([]);
  });

  it('Turn off gives up on a running heal at HEAL_WAIT_MS, not before', async () => {
    const browser = onBrowser();
    const held: ((subscription: BrowserSubscription | null) => void)[] = [];
    vi.spyOn(browser, 'subscription')
      .mockResolvedValueOnce(SUBSCRIPTION)
      .mockImplementation(async () => {
        const { promise, resolve } = Promise.withResolvers<BrowserSubscription | null>();
        held.push(resolve);
        return promise;
      });
    await open('phone', { browser, world: { devices: [mine] } });
    await waitFor(() => {
      expect(held.length).toBeGreaterThanOrEqual(2);
    });
    const turnOff = await screen.findByRole('button', { name: 'Turn off' });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(turnOff);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEAL_WAIT_MS - 1);
      });
      expect(unsubscribePush).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(unsubscribePush).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await act(async () => {
        for (const resolve of held) {
          resolve(null);
        }
      });
      await settle();
    }
  });

  it('Turn off compares the record’s endpoint with the clicked one as the host stores them', async () => {
    const browser = onBrowser();
    // The same endpoint, spelled with its default port.
    browser.record = {
      endpoint: 'https://push.example:443/this',
      serverKey: SERVED_KEY,
      state: 'on',
    };
    await open('phone', { browser, world: { devices: [mine] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await expect(screen.findByRole('button', { name: 'Turn on' })).resolves.toBeInTheDocument();
    expect(unsubscribePush).toHaveBeenCalledOnce();
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
      record: { endpoint: 'https://PUSH.example/this', serverKey: SERVED_KEY, state: 'on' },
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
      record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
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
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: 'BNewKey',
      state: 'on',
    });
    expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
  });

  it('heals with the reset’s key when a status read that started before it answers the old key', async () => {
    const client = new QueryClient();
    const browser = onBrowser();
    stubViewport('phone');
    const world = servePush({ devices: [mine] });
    await renderRoute(consoleRoutes, '/settings/notifications', client, withBrowser(browser));
    await screen.findByRole('button', { name: 'Turn off' });
    await settle();
    const earlier = Promise.withResolvers<PushStatus>();
    vi.mocked(pushStatus).mockImplementationOnce(async () => earlier.promise);
    act(() => {
      void client.refetchQueries({ queryKey: pushStatusQuery.queryKey });
    });
    await confirmReset();
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
    await act(async () => {
      earlier.resolve(READY);
    });
    await waitFor(() => {
      expect(browser.held?.applicationServerKey).toBe('BNewKey');
    });
    await settle();
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: 'BNewKey',
      state: 'on',
    });
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([browser.held?.endpoint]);
  });

  it('leaves this browser to the next load when the status after the reset is not ready', async () => {
    const browser = onBrowser();
    const { world } = await open('phone', { browser, world: { devices: [mine] } });
    await screen.findByRole('button', { name: 'Turn off' });
    await settle();
    const record = browser.record;
    vi.mocked(resetPushKey).mockImplementationOnce(async () => {
      world.devices = [];
      world.status = { state: 'key_unusable' };
      return { publicKey: 'BNewKey', state: 'reset' };
    });
    await confirmReset();
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
    await settle();
    expect(subscribePush).not.toHaveBeenCalled();
    expect(browser.record).toStrictEqual(record);
    expect(browser.held).toStrictEqual(SUBSCRIPTION);
  });

  it('finishes when an earlier heal never settles, after waiting for it a bounded time', async () => {
    const browser = dropped();
    stubViewport('phone');
    servePush({ devices: [mine] });
    const sending = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ state: 'unconfigured' }>();
    // The load's heal sends, and the host does not answer within the test.
    vi.mocked(subscribePush).mockImplementationOnce(async () => {
      sending.resolve();
      return answer.promise;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount(browser);
      await act(async () => {
        await sending.promise;
      });
      await confirmReset();
      await waitFor(() => {
        expect(resetPushKey).toHaveBeenCalledOnce();
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Reset push key…' }));
      const sheet = await screen.findByRole('dialog', { name: 'Reset the push key?' });
      expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEAL_WAIT_MS);
      });
      await waitFor(() => {
        expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeEnabled();
      });
    } finally {
      vi.useRealTimers();
      answer.resolve({ state: 'unconfigured' });
      await settle();
    }
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

/** The host's list in `world`, as the healer reads it. */
const listed = (world: PushWorld) => ({ devices: world.devices, state: 'listed' }) as const;

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
      record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
    });
    await mountHealer(browser, { devices: [{ ...mine, currentKey: false }] });
    await waitFor(() => {
      expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: SUBSCRIPTION.endpoint } });
    });
    expect(browser.held?.applicationServerKey).toBe(SERVED_KEY);
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
    });
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
      record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
    });
    const before = [{ ...mine, currentKey: false }];
    await mountHealer(browser, { devices: before }, client);
    await waitFor(() => {
      expect(browser.record).toStrictEqual({
        endpoint: browser.held?.endpoint,
        serverKey: SERVED_KEY,
        state: 'on',
      });
    });
    await settle();
    // A list read that started before the heal answers with the list from before it.
    vi.mocked(pushDevices).mockResolvedValueOnce({ devices: before, state: 'listed' });
    await act(async () => {
      await client.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
    });
    await settle();
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
    });
    expect(subscribePush).toHaveBeenCalledOnce();
  });

  it('sends a subscription the browser replaced, and drops the old endpoint', async () => {
    const stale = 'https://push.example/replaced';
    const browser = fakeBrowser({
      held: SUBSCRIPTION,
      permission: 'granted',
      record: { endpoint: stale, serverKey: SERVED_KEY, state: 'on' },
    });
    await mountHealer(browser, { devices: [device({ endpoint: stale })] });
    await waitFor(() => {
      expect(unsubscribePush).toHaveBeenCalledWith({ data: { endpoint: stale } });
    });
    expect(subscribePush).toHaveBeenCalledWith({
      data: expect.objectContaining({ endpoint: SUBSCRIPTION.endpoint }),
    });
    expect(browser.record).toStrictEqual({
      endpoint: SUBSCRIPTION.endpoint,
      serverKey: SERVED_KEY,
      state: 'on',
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

  it('subscribes again with the new key when a reset elsewhere deleted its row between the status and list reads', async () => {
    const browser = onBrowser();
    // The heal read the old key, then a list from after another device's reset.
    const world = servePush({ devices: [], status: readyWith('BNewKey') });
    await healThisBrowser(browser, READY, listed(world), readStatus);
    expect(browser.held?.applicationServerKey).toBe('BNewKey');
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: 'BNewKey',
      state: 'on',
    });
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([browser.held?.endpoint]);
  });

  it.each([
    [
      'fails',
      () => {
        vi.mocked(pushStatus).mockRejectedValue(new Error('offline'));
      },
    ],
    [
      'is not ready',
      (world: PushWorld) => {
        world.status = { state: 'key_unusable' };
      },
    ],
  ])(
    'leaves a browser whose row is gone as it was when the status reread %s',
    async (_name, reread) => {
      const browser = onBrowser();
      const record = browser.record;
      const world = servePush({ devices: [] });
      reread(world);
      await healThisBrowser(browser, READY, listed(world), readStatus);
      expect(browser.record).toStrictEqual(record);
      expect(browser.held).toStrictEqual(SUBSCRIPTION);
      expect(subscribePush).not.toHaveBeenCalled();
    },
  );

  /** A browser whose heal subscribes again (its key changed) or adopts the subscription it replaced. */
  const healing = {
    adopt: () =>
      fakeBrowser({
        held: SUBSCRIPTION,
        permission: 'granted',
        record: { endpoint: 'https://push.example/replaced', serverKey: SERVED_KEY, state: 'on' },
      }),
    resubscribe: () =>
      fakeBrowser({
        held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
        permission: 'granted',
        record: { endpoint: SUBSCRIPTION.endpoint, serverKey: 'BOldKey', state: 'on' },
      }),
  };

  it.each(
    (['wrong_origin', 'endpoint_not_allowed', 'invalid_keys'] as const).flatMap(
      (refusal) => (['resubscribe', 'adopt'] as const).map((kind) => [refusal, kind] as const),
    ),
  )('turns this browser off when the host refuses it (%s, %s)', async (refusal, kind) => {
    const world = servePush({ devices: [], subscribe: { state: refusal } });
    const browser = healing[kind]();
    await healThisBrowser(browser, READY, listed(world), readStatus);
    expect(subscribePush).toHaveBeenCalledOnce();
    expect(browser.held).toBeNull();
    expect(browser.record).toBeNull();
  });

  it.each([
    ['unconfigured', { state: 'unconfigured' }],
    ['misconfigured', { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' }],
    ['key_unusable', { state: 'key_unusable' }],
    // A full host is not this browser's doing; the next load tries again.
    ['too_many_devices', { state: 'too_many_devices' }],
  ] as const)(
    'leaves the opt-in and the subscription when the host answers %s',
    async (_name, answer) => {
      const world = servePush({ devices: [], subscribe: answer });
      const browser = healing.resubscribe();
      const record = browser.record;
      await healThisBrowser(browser, READY, listed(world), readStatus);
      expect(subscribePush).toHaveBeenCalledOnce();
      expect(browser.record).toStrictEqual(record);
      expect(browser.held?.applicationServerKey).toBe(SERVED_KEY);
    },
  );

  it('leaves the opt-in and the subscription when the send throws', async () => {
    const world = servePush({ devices: [] });
    vi.mocked(subscribePush).mockRejectedValueOnce(new Error('offline'));
    const browser = healing.resubscribe();
    const record = browser.record;
    await healThisBrowser(browser, READY, listed(world), readStatus);
    expect(browser.record).toStrictEqual(record);
    expect(browser.held).not.toBeNull();
  });

  it('on a stale key mid-heal, rereads the status and ends on the fresh key', async () => {
    const browser = dropped();
    const world = await mountHealer(browser, { devices: [mine] });
    // Another device resets the key while this heal sends; the reset deletes the old rows.
    vi.mocked(subscribePush).mockImplementationOnce(async () => {
      world.status = readyWith('BNewKey');
      world.devices = [];
      return { state: 'stale_key' };
    });
    await waitFor(() => {
      expect(browser.record).toStrictEqual({
        endpoint: browser.held?.endpoint,
        serverKey: 'BNewKey',
        state: 'on',
      });
    });
    expect(browser.held?.applicationServerKey).toBe('BNewKey');
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([browser.held?.endpoint]);
  });

  it('leaves the opt-in when the stale key persists after the reread', async () => {
    const world = servePush({ devices: [], subscribe: { state: 'stale_key' } });
    const browser = healing.resubscribe();
    const record = browser.record;
    await healThisBrowser(browser, READY, listed(world), readStatus);
    expect(subscribePush).toHaveBeenCalledTimes(2);
    expect(browser.record).toStrictEqual(record);
  });

  it('subscribes again a browser that does not say its key, when Reset deleted its row', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: null },
      permission: 'granted',
      record: { endpoint: SUBSCRIPTION.endpoint, serverKey: SERVED_KEY, state: 'on' },
    });
    const world = await mountHealer(browser, { devices: [], status: readyWith('BNewKey') });
    await waitFor(() => {
      expect(browser.record).toStrictEqual({
        endpoint: browser.held?.endpoint,
        serverKey: 'BNewKey',
        state: 'on',
      });
    });
    expect(subscribePush).toHaveBeenCalledWith({
      data: expect.objectContaining({ serverKey: 'BNewKey' }),
    });
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([browser.held?.endpoint]);
  });

  it('does nothing when the subscription read times out, even if the worker starts later', async () => {
    const started = Promise.withResolvers<void>();
    const subscribe = vi.fn();
    const held = {
      endpoint: SUBSCRIPTION.endpoint,
      getKey: () => new Uint8Array([1, 2, 3]).buffer,
      options: { applicationServerKey: new Uint8Array([10, 11, 12]).buffer },
      unsubscribe: async () => true,
    };
    const browser = createPushBrowser({
      // Reads give up at once; a subscribe waits for the worker.
      after: async (ms) => {
        if (ms > 5000) {
          await Promise.withResolvers<void>().promise;
        }
      },
      maxTouchPoints: 0,
      permission: () => 'granted',
      pushSupported: () => true,
      ready: async () => {
        await started.promise;
        return { pushManager: { getSubscription: async () => held, subscribe } };
      },
      requestPermission: async () => 'granted',
      standalone: () => false,
      storage: () => localStorage,
      userAgent: '',
    });
    const record = { endpoint: SUBSCRIPTION.endpoint, serverKey: 'CgsM', state: 'on' } as const;
    browser.writeRecord(record);
    // Another device removed this browser: the host lists no row for it.
    const world = servePush({ devices: [], status: readyWith('CgsM') });
    const heal = healThisBrowser(browser, world.status, listed(world), readStatus);
    await settle();
    started.resolve();
    await heal;
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).not.toHaveBeenCalled();
    expect(browser.readRecord()).toStrictEqual(record);
  });

  it('joins a heal already running, so the browser subscribes once', async () => {
    const browser = dropped();
    const subscribe = vi.spyOn(browser, 'subscribe');
    const world = servePush({ devices: [mine] });
    await Promise.all([
      healThisBrowser(browser, READY, listed(world), readStatus),
      healThisBrowser(browser, READY, listed(world), readStatus),
    ]);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribePush).toHaveBeenCalledOnce();
  });

  it('keeps the new row when the record spells the old endpoint differently', async () => {
    const browser = fakeBrowser({
      permission: 'granted',
      record: { endpoint: 'https://PUSH.example:443/this', serverKey: SERVED_KEY, state: 'on' },
    });
    browser.subscribe = async () => SUBSCRIPTION;
    const world = servePush({ devices: [mine] });
    await healThisBrowser(browser, READY, listed(world), readStatus);
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([mine.endpoint]);
    expect(unsubscribePush).not.toHaveBeenCalled();
  });

  it('ends on the new key when Reset lands while the load’s heal is sending', async () => {
    const browser = dropped();
    stubViewport('phone');
    const world = servePush({ devices: [mine] });
    const serve = vi.mocked(subscribePush).getMockImplementation();
    const sending = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    // The host takes the load's subscription, then its answer is held until after the reset.
    vi.mocked(subscribePush).mockImplementationOnce(async (call) => {
      const answer = await serve?.(call);
      sending.resolve();
      await answered.promise;
      return answer ?? { state: 'subscribed' };
    });
    // The reset deletes every row made for the old key.
    vi.mocked(resetPushKey).mockImplementationOnce(async () => {
      world.status = readyWith('BNewKey');
      world.devices = [];
      return { publicKey: 'BNewKey', state: 'reset' };
    });
    await mount(browser);
    await act(async () => {
      await sending.promise;
    });
    await confirmReset();
    await waitFor(() => {
      expect(resetPushKey).toHaveBeenCalledOnce();
    });
    answered.resolve();
    await waitFor(() => {
      expect(browser.held?.applicationServerKey).toBe('BNewKey');
    });
    await settle();
    expect(browser.record).toStrictEqual({
      endpoint: browser.held?.endpoint,
      serverKey: 'BNewKey',
      state: 'on',
    });
    expect(world.devices.map(({ endpoint }) => endpoint)).toStrictEqual([browser.held?.endpoint]);
  });
});

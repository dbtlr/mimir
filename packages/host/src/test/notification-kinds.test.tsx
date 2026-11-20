import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushDevices, pushStatus, setPushKind, subscribePush } from '../api/fns/push';
import type { PushDevice, PushEventKind, PushSetKindResult } from '../api/fns/push';
import { pushDevicesQuery } from '../api/push-queries';
import { PushHealer } from '../components/push-healer';
import { HEAL_WAIT_MS, healThisBrowser, saveKind, turnOn } from '../lib/push-actions';
import type { PushBrowser, ThisDeviceRecord } from '../lib/push-browser';
import { HEAL_RUNNING_TEXT } from '../lib/push-text';
import { PushBrowserContext } from '../lib/use-push-browser';
import { consoleRoutes } from '../router';
import {
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
 * Choosing the kinds that notify each browser (ADR 0045, MMR-712): this
 * browser's switches, another row's switches in a sheet or a dialog, the row's
 * meta line, and how the local record keeps this browser's kinds through a
 * heal and a Turn on.
 */

const KINDS = [
  'Stopped deliveries',
  'Decisions to confirm',
  'Tasks blocked on you',
  'Tasks that need answers',
];

const mine = device({ endpoint: SUBSCRIPTION.endpoint, label: 'Mac · Chrome' });
const other = device({ endpoint: 'https://push.example/other', label: 'Android · Chrome' });
const oldKey = device({
  currentKey: false,
  endpoint: 'https://push.example/old',
  label: 'Windows · Edge',
});

const onRecord = (muted?: PushEventKind[]) =>
  ({
    endpoint: SUBSCRIPTION.endpoint,
    serverKey: SERVED_KEY,
    state: 'on',
    ...(muted === undefined ? {} : { muted }),
  }) as const;

/** A browser that has turned notifications on. */
const onBrowser = (record: ThisDeviceRecord = onRecord([])) =>
  fakeBrowser({ held: SUBSCRIPTION, permission: 'granted', record });

function withBrowser(browser: PushBrowser) {
  return function Provide({ children }: { children: ReactNode }) {
    return (
      <PushBrowserContext.Provider value={browser}>
        <PushHealer />
        {children}
      </PushBrowserContext.Provider>
    );
  };
}

async function open(
  viewport: Viewport,
  options: { browser?: FakeBrowser; client?: QueryClient; world?: Partial<PushWorld> } = {},
) {
  stubViewport(viewport);
  const world = servePush(options.world);
  const browser = options.browser ?? onBrowser();
  const client = options.client ?? new QueryClient();
  await renderRoute(consoleRoutes, '/settings/notifications', client, withBrowser(browser));
  await screen.findByRole('heading', { level: 1, name: 'Notifications' });
  await settle();
  return { browser, client, world };
}

/** A client that polls as the console's does, on a short interval so a test sees several polls. */
const pollingClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: 20 } } });

/** Wait until the device list has been read `times` more times. */
async function polled(times = 3) {
  const start = vi.mocked(pushDevices).mock.calls.length;
  await waitFor(() => {
    expect(vi.mocked(pushDevices).mock.calls.length).toBeGreaterThanOrEqual(start + times);
  });
  await settle();
}

/** Reread the device list now, as a poll does. */
async function reread(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: pushDevicesQuery.queryKey });
  });
  await settle();
}

/** Hold Set kind's next call: the host neither writes nor answers until `release`. */
function holdSetKind() {
  const serve = vi.mocked(setPushKind).getMockImplementation();
  const gate = Promise.withResolvers<void>();
  vi.mocked(setPushKind).mockImplementationOnce(async (call) => {
    await gate.promise;
    return (await serve?.(call)) ?? { state: 'saved' };
  });
  return async () => {
    await act(async () => {
      gate.resolve();
    });
    await settle();
  };
}

/** Open another row's switches: through its sheet on a phone, its menu on a desktop. */
async function openKinds(viewport: Viewport, label: string) {
  if (viewport === 'desktop') {
    await userEvent.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Choose what notifies…' }));
  } else {
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
    const rowSheet = await screen.findByRole('dialog', { name: label });
    await userEvent.click(within(rowSheet).getByRole('button', { name: 'Choose what notifies…' }));
  }
  return screen.findByRole('dialog', { name: label });
}

async function mountHealer(browser: FakeBrowser, world: Partial<PushWorld>) {
  const served = servePush(world);
  const Provide = withBrowser(browser);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Provide>{null}</Provide>
    </QueryClientProvider>,
  );
  await settle();
  return served;
}

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

/**
 * Start a heal of `browser` that holds at its subscription read until the
 * returned `release`, so a caller that waits for a running heal waits.
 */
function holdHeal(browser: FakeBrowser, world: PushWorld) {
  const held = Promise.withResolvers<void>();
  vi.spyOn(browser, 'subscription').mockImplementationOnce(async () => {
    await held.promise;
    return browser.held;
  });
  const heal = healThisBrowser(
    browser,
    READY,
    { devices: world.devices, state: 'listed' },
    async () => pushStatus(),
  );
  return async () => {
    held.resolve();
    await heal;
    await settle();
  };
}

/** The listed row whose label is `label`. */
const metaOf = (label: string) =>
  within(screen.getByRole('region', { name: /^Subscribed browsers/ }))
    .getByText(label)
    .closest('li');

/** Change one row of the host's list, as a write from another device does; the row becomes a new object. */
function changeRow(world: PushWorld, endpoint: string, change: Partial<PushDevice>) {
  const row = world.devices.find((candidate) => candidate.endpoint === endpoint);
  if (row === undefined) {
    throw new Error(`no row for ${endpoint}`);
  }
  const changed = { ...row, ...change };
  world.devices = world.devices.map((candidate) => (candidate === row ? changed : candidate));
}

const kindsGroup = () => screen.findByRole('region', { name: 'Notify this device about' });
const isOn = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('this browser’s kinds', () => {
  it('shows a switch for each kind in the event order, on unless the row mutes it', async () => {
    await open('phone', { world: { devices: [{ ...mine, muted: ['task_blocked'] }] } });
    const group = await kindsGroup();
    const switches = within(group).getAllByRole('switch');
    expect(
      KINDS.map((name) => switches.indexOf(within(group).getByRole('switch', { name }))),
    ).toStrictEqual([0, 1, 2, 3]);
    expect(switches.map(isOn)).toStrictEqual([true, true, false, true]);
    expect(group).toHaveTextContent('The badge still counts everything that needs you.');
  });

  it('a flip saves that one kind for this browser, keeps the record, and shows in the row', async () => {
    const { browser } = await open('phone', { world: { devices: [mine, other] } });
    const group = await kindsGroup();
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    expect(setPushKind).toHaveBeenCalledWith({
      data: { endpoint: SUBSCRIPTION.endpoint, kind: 'decisions', muted: true },
    });
    await waitFor(() => {
      expect(browser.record).toStrictEqual(onRecord(['decisions']));
    });
    expect(within(group).getByRole('switch', { name: 'Decisions to confirm' })).not.toBeChecked();
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Subscribed browsers · 2' })).toHaveTextContent(
        'Decisions off',
      );
    });
  });

  it('allows every kind off, and says the browser still takes a test', async () => {
    await open('phone', {
      world: { devices: [{ ...mine, muted: ['delivery_stopped', 'decisions', 'task_blocked'] }] },
    });
    const group = await kindsGroup();
    await userEvent.click(within(group).getByRole('switch', { name: 'Tasks that need answers' }));
    await waitFor(() => {
      expect(group).toHaveTextContent(
        'Every kind is off. This browser stays subscribed and still takes a test notification.',
      );
    });
    expect(screen.getByRole('region', { name: 'Subscribed browsers · 1' })).toHaveTextContent(
      'Every kind off',
    );
  });

  it('a tap on a kind’s text flips its switch', async () => {
    await open('phone', { world: { devices: [mine] } });
    const group = await kindsGroup();
    await userEvent.click(within(group).getByText('Tasks that need answers'));
    expect(setPushKind).toHaveBeenCalledOnce();
    expect(setPushKind).toHaveBeenCalledWith({
      data: { endpoint: SUBSCRIPTION.endpoint, kind: 'task_needs_answers', muted: true },
    });
    await waitFor(() => {
      expect(
        within(group).getByRole('switch', { name: 'Tasks that need answers' }),
      ).not.toBeChecked();
    });
  });

  it('returns a switch and says why when the save fails', async () => {
    await open('phone', { world: { devices: [mine] } });
    vi.mocked(setPushKind).mockRejectedValueOnce(new Error('offline'));
    const group = await kindsGroup();
    const decisions = within(group).getByRole('switch', { name: 'Decisions to confirm' });
    await userEvent.click(decisions);
    await waitFor(() => {
      expect(group).toHaveTextContent("The choice couldn't be saved.");
    });
    expect(decisions).toBeChecked();
  });

  it('says under This device that the browser is gone on not_found, and reloads the list', async () => {
    const { world } = await open('phone', { world: { devices: [mine] } });
    const group = await kindsGroup();
    world.devices = [];
    world.setKind = { state: 'not_found' };
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'This device' })).toHaveTextContent(
        'This browser is no longer subscribed.',
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Notify this device about' })).toBeNull();
    });
  });

  it('holds Turn off and Reset push key while a save on this browser runs', async () => {
    await open('phone', { world: { devices: [mine] } });
    const answer = Promise.withResolvers<PushSetKindResult>();
    vi.mocked(setPushKind).mockImplementationOnce(async () => answer.promise);
    const group = await kindsGroup();
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Turn off' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Reset push key…' })).toBeDisabled();
    // Base UI's switch is a span: disabled is aria-disabled.
    expect(within(group).getByRole('switch', { name: 'Decisions to confirm' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(group).getByRole('switch', { name: 'Stopped deliveries' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await act(async () => {
      answer.resolve({ state: 'saved' });
      await answer.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled();
    });
  });

  it('a save on this browser waits for a running heal, and returns with the heal’s sentence when it outlasts the wait', async () => {
    const { browser, world } = await open('phone', { world: { devices: [mine] } });
    const group = await kindsGroup();
    const release = holdHeal(browser, world);
    try {
      const decisions = within(group).getByRole('switch', { name: 'Decisions to confirm' });
      vi.useFakeTimers();
      try {
        await act(async () => {
          fireEvent.click(decisions);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HEAL_WAIT_MS - 1);
        });
        expect(setPushKind).not.toHaveBeenCalled();
        expect(decisions).not.toBeChecked();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(group).toHaveTextContent(HEAL_RUNNING_TEXT);
        expect(group).not.toHaveTextContent("The choice couldn't be saved.");
      } finally {
        vi.useRealTimers();
      }
      expect(decisions).toBeChecked();
      expect(setPushKind).not.toHaveBeenCalled();
      expect(browser.record).toStrictEqual(onRecord([]));
    } finally {
      await release();
    }
  });

  it('disables this browser’s switches while Turn off runs', async () => {
    const { browser, world } = await open('phone', { world: { devices: [mine] } });
    const group = await kindsGroup();
    // Turn off waits for the held heal, so it is still running when the switches are read.
    const release = holdHeal(browser, world);
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
      await waitFor(() => {
        expect(
          within(group)
            .getAllByRole('switch')
            .map((element) => element.getAttribute('aria-disabled')),
        ).toStrictEqual(['true', 'true', 'true', 'true']);
      });
    } finally {
      await release();
    }
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Notify this device about' })).toBeNull();
    });
  });

  it('is absent when this browser is off', async () => {
    await open('phone', { browser: fakeBrowser(), world: { devices: [] } });
    expect(screen.queryByRole('region', { name: 'Notify this device about' })).toBeNull();
  });

  it('is absent while this browser’s row is on an old key', async () => {
    // No record, so the load's heal leaves the old-key row as it is.
    await open('phone', {
      browser: fakeBrowser({ held: SUBSCRIPTION, permission: 'granted' }),
      world: { devices: [{ ...mine, currentKey: false }] },
    });
    await expect(screen.findByRole('button', { name: 'Turn off' })).resolves.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Notify this device about' })).toBeNull();
  });
});

describe('another browser’s kinds', () => {
  it('on a phone, Choose what notifies… closes the row sheet and opens its switches', async () => {
    const { browser } = await open('phone', {
      world: { devices: [mine, { ...other, muted: ['decisions', 'task_blocked'] }, oldKey] },
    });
    expect(screen.getByRole('button', { name: /^Android · Chrome/ })).toHaveTextContent(
      '2 kinds off',
    );
    await userEvent.click(screen.getByRole('button', { name: /^Android · Chrome/ }));
    const rowSheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(rowSheet).getByRole('button', { name: 'Choose what notifies…' }));
    await waitFor(() => {
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });
    const kinds = screen.getByRole('dialog', { name: 'Android · Chrome' });
    expect(within(kinds).getAllByRole('switch').map(isOn)).toStrictEqual([
      true,
      false,
      false,
      true,
    ]);
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Stopped deliveries' }));
    expect(setPushKind).toHaveBeenCalledWith({
      data: { endpoint: other.endpoint, kind: 'delivery_stopped', muted: true },
    });
    await waitFor(() => {
      expect(within(kinds).getByRole('switch', { name: 'Stopped deliveries' })).not.toBeChecked();
    });
    expect(browser.record).toStrictEqual(onRecord([]));
    await userEvent.click(within(kinds).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('on a phone, Done returns focus to the row', async () => {
    await open('phone', { world: { devices: [mine, other] } });
    const row = screen.getByRole('button', { name: /^Android · Chrome/ });
    await userEvent.click(row);
    const rowSheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(rowSheet).getByRole('button', { name: 'Choose what notifies…' }));
    const kinds = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(kinds).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('when that browser is gone, closes its switches and says so on the page', async () => {
    const { world } = await open('phone', { world: { devices: [mine, other] } });
    await userEvent.click(screen.getByRole('button', { name: /^Android · Chrome/ }));
    const rowSheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(rowSheet).getByRole('button', { name: 'Choose what notifies…' }));
    const kinds = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    world.devices = [mine];
    world.setKind = { state: 'not_found' };
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Decisions to confirm' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByText('That browser is no longer subscribed.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Subscribed browsers · 1' })).toBeInTheDocument();
    });
    await settle();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('when that browser is gone, leaves focus on the page’s main even while the list still names it', async () => {
    const { world } = await open('phone', { world: { devices: [mine, other] } });
    const kinds = await openKinds('phone', 'Android · Chrome');
    world.setKind = { state: 'not_found' };
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Decisions to confirm' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await settle();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('on a desktop, the row menu opens the switches in a dialog', async () => {
    await open('desktop', { world: { devices: [mine, other] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for Android · Chrome' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Choose what notifies…' }));
    const kinds = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Tasks that need answers' }));
    expect(setPushKind).toHaveBeenCalledWith({
      data: { endpoint: other.endpoint, kind: 'task_needs_answers', muted: true },
    });
  });

  it('on a desktop, Done returns focus to the row’s menu', async () => {
    await open('desktop', { world: { devices: [mine, other] } });
    const kinds = await openKinds('desktop', 'Android · Chrome');
    await userEvent.click(within(kinds).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions for Android · Chrome' })).toHaveFocus();
    });
  });

  it('says every kind is off for that browser, naming it rather than this one', async () => {
    await open('desktop', {
      world: {
        devices: [mine, { ...other, muted: ['delivery_stopped', 'decisions', 'task_blocked'] }],
      },
    });
    const kinds = await openKinds('desktop', 'Android · Chrome');
    expect(kinds).not.toHaveTextContent('Every kind is off.');
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Tasks that need answers' }));
    await waitFor(() => {
      expect(kinds).toHaveTextContent(
        'Every kind is off. That browser stays subscribed and still takes a test notification.',
      );
    });
    expect(kinds).not.toHaveTextContent('This browser');
  });

  it('an old-key row does not offer it', async () => {
    await open('desktop', { world: { devices: [mine, oldKey] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for Windows · Edge' }),
    );
    expect(screen.queryByRole('menuitem', { name: 'Choose what notifies…' })).toBeNull();
  });
});

describe('the record keeps this browser’s kinds', () => {
  it('the heal learns this browser’s kinds from its row, without subscribing', async () => {
    const browser = onBrowser(onRecord());
    await mountHealer(browser, { devices: [{ ...mine, muted: ['task_blocked'] }] });
    await waitFor(() => {
      expect(browser.record).toStrictEqual(onRecord(['task_blocked']));
    });
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it('after a key reset deleted its row, the heal subscribes again with the kinds the record kept', async () => {
    const browser = fakeBrowser({
      held: { ...SUBSCRIPTION, applicationServerKey: 'BOldKey' },
      permission: 'granted',
      record: onRecord(['decisions']),
    });
    const world = await mountHealer(browser, { devices: [] });
    await waitFor(() => {
      expect(subscribePush).toHaveBeenCalledWith({
        data: expect.objectContaining({ muted: ['decisions'] }),
      });
    });
    await waitFor(() => {
      expect(browser.record).toMatchObject({ muted: ['decisions'], state: 'on' });
    });
    expect(world.devices[0]?.muted).toStrictEqual(['decisions']);
  });

  it('a heal that adopts a new endpoint sends the kinds of the row the browser holds', async () => {
    const stale = 'https://push.example/replaced';
    const browser = fakeBrowser({
      held: SUBSCRIPTION,
      permission: 'granted',
      record: { endpoint: stale, muted: ['decisions'], serverKey: SERVED_KEY, state: 'on' },
    });
    await mountHealer(browser, {
      devices: [device({ endpoint: stale, muted: [] }), { ...mine, muted: ['task_blocked'] }],
    });
    await waitFor(() => {
      expect(subscribePush).toHaveBeenCalledWith({
        data: expect.objectContaining({ endpoint: SUBSCRIPTION.endpoint, muted: ['task_blocked'] }),
      });
    });
    await waitFor(() => {
      expect(browser.record).toStrictEqual(onRecord(['task_blocked']));
    });
  });

  it('the heal learns from the row for the record’s endpoint when the list has none for the held one', async () => {
    const stale = 'https://push.example/replaced';
    const browser = fakeBrowser({
      held: SUBSCRIPTION,
      permission: 'granted',
      record: { endpoint: stale, muted: [], serverKey: SERVED_KEY, state: 'on' },
    });
    await mountHealer(browser, { devices: [device({ endpoint: stale, muted: ['decisions'] })] });
    await waitFor(() => {
      expect(subscribePush).toHaveBeenCalledWith({
        data: expect.objectContaining({ endpoint: SUBSCRIPTION.endpoint, muted: ['decisions'] }),
      });
    });
    await waitFor(() => {
      expect(browser.record).toStrictEqual(onRecord(['decisions']));
    });
  });

  it('Turn on sends the kinds of a record still on, and none otherwise', async () => {
    servePush({ devices: [] });
    const kept = fakeBrowser({ permission: 'granted', record: onRecord(['decisions']) });
    await turnOn(kept, readyWith(SERVED_KEY), async () => pushStatus());
    expect(subscribePush).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ muted: ['decisions'] }),
    });
    expect(kept.record).toMatchObject({ muted: ['decisions'] });
    const fresh = fakeBrowser({ record: { state: 'removed' } });
    await turnOn(fresh, readyWith(SERVED_KEY), async () => pushStatus());
    expect(subscribePush).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ muted: [] }),
    });
    expect(fresh.record).toMatchObject({ muted: [] });
  });

  it('a saved change patches only an on record for that endpoint, starting from the row', async () => {
    servePush({ devices: [{ ...mine, muted: ['task_blocked'] }, other] });
    const none = fakeBrowser();
    await saveKind(none, { endpoint: mine.endpoint, kind: 'decisions', muted: true, rowMuted: [] });
    expect(none.record).toBeNull();
    const removed = fakeBrowser({ record: { state: 'removed' } });
    await saveKind(removed, {
      endpoint: mine.endpoint,
      kind: 'decisions',
      muted: true,
      rowMuted: [],
    });
    expect(removed.record).toStrictEqual({ state: 'removed' });
    const elsewhere = onBrowser(onRecord([]));
    await saveKind(elsewhere, {
      endpoint: other.endpoint,
      kind: 'decisions',
      muted: true,
      rowMuted: [],
    });
    expect(elsewhere.record).toStrictEqual(onRecord([]));
    const unknown = onBrowser(onRecord());
    await saveKind(unknown, {
      endpoint: 'https://PUSH.example/this',
      kind: 'decisions',
      muted: true,
      rowMuted: ['task_blocked'],
    });
    expect(unknown.record).toStrictEqual(onRecord(['decisions', 'task_blocked']));
  });

  const change = { endpoint: mine.endpoint, kind: 'decisions', muted: true, rowMuted: [] } as const;

  it('a save reads the record when the host answers, so one that crosses Turn off or a removal writes nothing', async () => {
    servePush({ devices: [mine] });
    for (const after of [null, { state: 'removed' }] as const) {
      const browser = onBrowser(onRecord([]));
      const answer = Promise.withResolvers<PushSetKindResult>();
      vi.mocked(setPushKind).mockImplementationOnce(async () => answer.promise);
      const saving = saveKind(browser, { ...change, own: true });
      // oxlint-disable-next-line no-await-in-loop -- each case waits for its own call
      await waitFor(() => {
        expect(setPushKind).toHaveBeenCalled();
      });
      browser.record = after;
      answer.resolve({ state: 'saved' });
      // oxlint-disable-next-line no-await-in-loop -- each case waits for its own save
      await saving;
      expect(browser.record).toStrictEqual(after);
      vi.mocked(setPushKind).mockClear();
    }
  });

  it('a save the host does not answer saved, or that throws, leaves the record as it was', async () => {
    const world = servePush({ devices: [mine] });
    for (const answer of [
      { state: 'not_found' },
      { state: 'unconfigured' },
      { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' },
    ] as const) {
      world.setKind = answer;
      const browser = onBrowser(onRecord([]));
      // oxlint-disable-next-line no-await-in-loop -- each case is its own save
      await expect(saveKind(browser, { ...change, own: true })).resolves.toStrictEqual(answer);
      expect(browser.record).toStrictEqual(onRecord([]));
    }
    world.setKind = undefined;
    vi.mocked(setPushKind).mockRejectedValueOnce(new Error('offline'));
    const thrown = onBrowser(onRecord([]));
    await expect(saveKind(thrown, { ...change, own: true })).rejects.toThrow('offline');
    expect(thrown.record).toStrictEqual(onRecord([]));
  });

  it('a save on this browser’s own row patches a record that still names an old endpoint', async () => {
    servePush({ devices: [mine] });
    const old = { ...onRecord([]), endpoint: 'https://push.example/replaced' };
    const own = onBrowser(old);
    await saveKind(own, { ...change, own: true });
    expect(own.record).toStrictEqual({ ...old, muted: ['decisions'] });
    const notOwn = onBrowser(old);
    await saveKind(notOwn, { ...change, own: false });
    expect(notOwn.record).toStrictEqual(old);
  });

  it('a save starts from the record’s own kinds when it has them, not the row’s', async () => {
    servePush({ devices: [mine] });
    const browser = onBrowser(onRecord(['task_blocked']));
    await saveKind(browser, { ...change, own: true, rowMuted: ['task_needs_answers'] });
    expect(browser.record).toStrictEqual(onRecord(['decisions', 'task_blocked']));
  });
});

describe('while the list polls', () => {
  it('on a desktop, another row’s kinds dialog stays open across polls that list the same browsers', async () => {
    await open('desktop', { client: pollingClient(), world: { devices: [mine, other] } });
    const kinds = await openKinds('desktop', 'Android · Chrome');
    await polled();
    expect(kinds).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Android · Chrome' })).toBe(kinds);
  });

  it('on a phone, a row’s sheet stays open across polls that list the same browsers', async () => {
    await open('phone', { client: pollingClient(), world: { devices: [mine, other] } });
    await userEvent.click(screen.getByRole('button', { name: /^Android · Chrome/ }));
    const rowSheet = await screen.findByRole('dialog', { name: 'Android · Chrome' });
    await polled();
    expect(rowSheet).toBeInTheDocument();
  });

  it('on a phone, another row’s kinds sheet stays open across polls while a save runs', async () => {
    await open('phone', { client: pollingClient(), world: { devices: [mine, other] } });
    const kinds = await openKinds('phone', 'Android · Chrome');
    const release = holdSetKind();
    await userEvent.click(within(kinds).getByRole('switch', { name: 'Decisions to confirm' }));
    await polled();
    expect(kinds).toBeInTheDocument();
    expect(within(kinds).getByRole('switch', { name: 'Decisions to confirm' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await release();
    await waitFor(() => {
      expect(within(kinds).getByRole('switch', { name: 'Decisions to confirm' })).not.toBeChecked();
    });
    expect(within(kinds).getByRole('switch', { name: 'Decisions to confirm' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(kinds).toBeInTheDocument();
  });
});

describe('a saved kind changes the listed row', () => {
  it('two switches flipped in quick succession both show, and the row says 2 kinds off', async () => {
    await open('phone', { world: { devices: [mine, other] } });
    const group = await kindsGroup();
    const releaseFirst = holdSetKind();
    const releaseSecond = holdSetKind();
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    await userEvent.click(within(group).getByRole('switch', { name: 'Tasks blocked on you' }));
    await releaseFirst();
    await releaseSecond();
    await waitFor(() => {
      expect(metaOf('Mac · Chrome')).toHaveTextContent('2 kinds off');
    });
    expect(within(group).getByRole('switch', { name: 'Decisions to confirm' })).not.toBeChecked();
    expect(within(group).getByRole('switch', { name: 'Tasks blocked on you' })).not.toBeChecked();
  });

  it('a save that answers after a poll read the list still shows on the row', async () => {
    const { client, world } = await open('phone', { world: { devices: [mine, other] } });
    const group = await kindsGroup();
    const release = holdSetKind();
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    // Another row changed meanwhile, so the poll answers a new list from before the save's write.
    changeRow(world, other.endpoint, { lastSuccessAt: '2026-11-20T09:00:00.000Z' });
    await reread(client);
    await release();
    await waitFor(() => {
      expect(metaOf('Mac · Chrome')).toHaveTextContent('Decisions off');
    });
    expect(within(group).getByRole('switch', { name: 'Decisions to confirm' })).not.toBeChecked();
  });

  it('a later poll shows the host’s kinds when another device changed them back', async () => {
    const { client, world } = await open('phone', { world: { devices: [mine, other] } });
    const group = await kindsGroup();
    await userEvent.click(within(group).getByRole('switch', { name: 'Decisions to confirm' }));
    await waitFor(() => {
      expect(metaOf('Mac · Chrome')).toHaveTextContent('Decisions off');
    });
    changeRow(world, mine.endpoint, { muted: [] });
    await reread(client);
    await waitFor(() => {
      expect(metaOf('Mac · Chrome')).not.toHaveTextContent('Decisions off');
    });
    expect(within(group).getByRole('switch', { name: 'Decisions to confirm' })).toBeChecked();
  });
});

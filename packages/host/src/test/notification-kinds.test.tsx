import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushStatus, setPushKind, subscribePush } from '../api/fns/push';
import type { PushEventKind, PushSetKindResult } from '../api/fns/push';
import { PushHealer } from '../components/push-healer';
import { saveKind, turnOn } from '../lib/push-actions';
import type { PushBrowser, ThisDeviceRecord } from '../lib/push-browser';
import { PushBrowserContext } from '../lib/use-push-browser';
import { consoleRoutes } from '../router';
import { device, fakeBrowser, readyWith, servePush, SERVED_KEY, SUBSCRIPTION } from './push-fns';
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
  options: { browser?: FakeBrowser; world?: Partial<PushWorld> } = {},
) {
  stubViewport(viewport);
  const world = servePush(options.world);
  const browser = options.browser ?? onBrowser();
  await renderRoute(
    consoleRoutes,
    '/settings/notifications',
    new QueryClient(),
    withBrowser(browser),
  );
  await screen.findByRole('heading', { level: 1, name: 'Notifications' });
  await settle();
  return { browser, world };
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
    expect(switches.map((element) => element.getAttribute('aria-label'))).toStrictEqual(KINDS);
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

  it('returns a switch and says why when the save fails', async () => {
    await open('phone', { world: { devices: [mine] } });
    vi.mocked(setPushKind).mockRejectedValueOnce(new Error('offline'));
    const group = await kindsGroup();
    const decisions = within(group).getByRole('switch', { name: 'Decisions to confirm' });
    await userEvent.click(decisions);
    await waitFor(() => {
      expect(group).toHaveTextContent('The choice couldn’t be saved.');
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
});

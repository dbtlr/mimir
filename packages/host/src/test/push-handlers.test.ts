import { describe, expect, it, vi } from 'vitest';

import { registerPushHandlers } from '../sw/push-handlers';
import type { PushScope } from '../sw/push-handlers';

const ORIGIN = 'https://mimir.example.test';

type Handler = (event: never) => void;

type FakeWindow = {
  url: string;
  navigate: () => Promise<{ focus: () => Promise<unknown> } | null>;
  focus: () => Promise<unknown>;
  /** A window the worker does not control, which `matchAll` lists only on request. */
  uncontrolled?: boolean;
};

function scope(windows: FakeWindow[] = []) {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const fake: PushScope = {
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    clients: {
      matchAll: async ({ includeUncontrolled }) =>
        windows.filter((win) => includeUncontrolled || win.uncontrolled !== true),
      openWindow,
    },
    location: { origin: ORIGIN },
    navigator: {},
    registration: { showNotification },
  };
  registerPushHandlers(fake);
  return { fake, handlers, openWindow, showNotification };
}

function pushEvent(data: string | undefined) {
  const waits: Promise<unknown>[] = [];
  return {
    done: () => Promise.all(waits),
    event: {
      data: data === undefined ? null : { text: () => data },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    },
  };
}

describe('push handler', () => {
  it('shows the mapped notification and sets the badge', async () => {
    const { fake, handlers, showNotification } = scope();
    const setAppBadge = vi.fn(async () => {});
    fake.navigator = { setAppBadge };
    const { event, done } = pushEvent(
      JSON.stringify({ app_badge: 2, notification: { tag: 'a:b', title: 'Hi' } }),
    );
    handlers.get('push')?.(event as never);
    await done();
    expect(showNotification).toHaveBeenCalledWith('Hi', expect.objectContaining({ tag: 'a:b' }));
    expect(setAppBadge).toHaveBeenCalledWith(2);
  });

  it('still shows the notification when the badge refuses', async () => {
    const { fake, handlers, showNotification } = scope();
    fake.navigator = { setAppBadge: vi.fn().mockRejectedValue(new Error('no')) };
    const { event, done } = pushEvent(
      JSON.stringify({ app_badge: 2, notification: { tag: 'a:b', title: 'Hi' } }),
    );
    handlers.get('push')?.(event as never);
    await done();
    expect(showNotification).toHaveBeenCalledOnce();
  });

  it('sets the badge only after the notification shows', async () => {
    const order: string[] = [];
    const { fake, handlers, showNotification } = scope();
    // The notification resolves a tick late, so a badge that does not wait for it lands first.
    showNotification.mockImplementation(async () => {
      await Promise.resolve();
      order.push('show');
    });
    fake.navigator = { setAppBadge: async () => void order.push('badge') };
    const { event, done } = pushEvent(
      JSON.stringify({ app_badge: 2, notification: { tag: 'a:b', title: 'Hi' } }),
    );
    handlers.get('push')?.(event as never);
    await done();
    expect(order).toEqual(['show', 'badge']);
  });

  it('shows the generic notification when the push data cannot be read', async () => {
    const { handlers, showNotification } = scope();
    const waits: Promise<unknown>[] = [];
    const event = {
      data: {
        text: () => {
          throw new TypeError('not text');
        },
      },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    };
    handlers.get('push')?.(event as never);
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith(
      'Mimir',
      expect.objectContaining({ body: 'Something needs you.', tag: 'mimir' }),
    );
  });

  it('shows a generic notification for an empty push', async () => {
    const { handlers, showNotification } = scope();
    const { event, done } = pushEvent(undefined);
    handlers.get('push')?.(event as never);
    await done();
    expect(showNotification).toHaveBeenCalledWith('Mimir', expect.anything());
  });
});

function clickEvent(navigate: unknown) {
  const waits: Promise<unknown>[] = [];
  const close = vi.fn();
  return {
    close,
    done: () => Promise.all(waits),
    event: {
      notification: { close, data: { navigate } },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    },
  };
}

describe('notificationclick handler', () => {
  it('navigates an open console window, then focuses the client the navigation resolves to', async () => {
    const order: string[] = [];
    // navigate() resolves to a new client for the navigated document; the old
    // one belongs to the replaced document, so focusing it can reject.
    const navigated = { focus: async () => void order.push('focus'), url: `${ORIGIN}/p/MMR` };
    const win = {
      focus: async () => void order.push('focus the old client'),
      navigate: async () => {
        order.push('navigate');
        return navigated;
      },
      url: `${ORIGIN}/`,
    };
    const navigate = vi.spyOn(win, 'navigate');
    const { handlers, openWindow } = scope([win]);
    const { close, event, done } = clickEvent(`${ORIGIN}/p/MMR`);
    handlers.get('notificationclick')?.(event as never);
    await done();
    expect(close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/p/MMR`);
    expect(order).toEqual(['navigate', 'focus']);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('reuses a console window the worker does not control yet', async () => {
    const navigate = vi.fn(async () => null);
    const { handlers, openWindow } = scope([
      { focus: async () => {}, navigate, uncontrolled: true, url: `${ORIGIN}/` },
    ]);
    const { event, done } = clickEvent(`${ORIGIN}/p/MMR`);
    handlers.get('notificationclick')?.(event as never);
    await done();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/p/MMR`);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('keeps the navigation when focus is refused', async () => {
    const refusingFocus = vi.fn(async () => {
      throw new Error('no gesture');
    });
    const navigate = vi.fn(async () => ({ focus: refusingFocus }));
    const win = { focus: async () => {}, navigate, url: `${ORIGIN}/` };
    const { handlers } = scope([win]);
    const { event, done } = clickEvent(`${ORIGIN}/p/MMR`);
    handlers.get('notificationclick')?.(event as never);
    await expect(done()).resolves.toBeDefined();
    expect(navigate).toHaveBeenCalledOnce();
    expect(refusingFocus).toHaveBeenCalledOnce();
  });

  it('opens a window, and leaves the old one unfocused, when the open one refuses to navigate', async () => {
    const focus = vi.fn(async () => {});
    const win = {
      focus,
      navigate: async () => {
        throw new TypeError('uncontrolled client');
      },
      url: `${ORIGIN}/`,
    };
    const { handlers, openWindow } = scope([win]);
    const { event, done } = clickEvent(`${ORIGIN}/p/MMR`);
    handlers.get('notificationclick')?.(event as never);
    await done();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/p/MMR`);
    expect(focus).not.toHaveBeenCalled();
  });

  it('opens a window when none is open, and never a cross-origin target', async () => {
    const { handlers, openWindow } = scope([
      { focus: async () => {}, navigate: async () => null, url: 'https://other.example/' },
    ]);
    const { event, done } = clickEvent('https://evil.example/');
    handlers.get('notificationclick')?.(event as never);
    await done();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

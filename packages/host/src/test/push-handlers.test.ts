import { describe, expect, it, vi } from 'vitest';

import { registerPushHandlers } from '../sw/push-handlers';
import type { PushScope } from '../sw/push-handlers';

const ORIGIN = 'https://mimir.example.test';

type Handler = (event: never) => void;

function scope(
  windows: { url: string; navigate: () => Promise<unknown>; focus: () => Promise<unknown> }[] = [],
) {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const fake: PushScope = {
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    clients: { matchAll: async () => windows, openWindow },
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
  it('navigates then focuses an open console window', async () => {
    const order: string[] = [];
    const win = {
      focus: async () => void order.push('focus'),
      navigate: async () => void order.push('navigate'),
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

  it('keeps the navigation when focus is refused', async () => {
    const navigate = vi.fn(async () => {});
    const win = {
      focus: async () => {
        throw new Error('no gesture');
      },
      navigate,
      url: `${ORIGIN}/`,
    };
    const { handlers } = scope([win]);
    const { event, done } = clickEvent(`${ORIGIN}/p/MMR`);
    handlers.get('notificationclick')?.(event as never);
    await expect(done()).resolves.toBeDefined();
    expect(navigate).toHaveBeenCalledOnce();
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
      { focus: async () => {}, navigate: async () => {}, url: 'https://other.example/' },
    ]);
    const { event, done } = clickEvent('https://evil.example/');
    handlers.get('notificationclick')?.(event as never);
    await done();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

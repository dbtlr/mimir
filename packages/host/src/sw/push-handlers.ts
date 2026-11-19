import { clickTarget, mapPush } from '../lib/push-notification';
import type { PushNotificationOptions } from '../lib/push-notification';

/*
 * The service worker's push and notificationclick handlers (ADR 0045, MMR-710).
 * The generated Workbox worker imports this file's build (`sw-push.js`), so
 * the precache and update flow stay Workbox's. The scope is a narrow
 * structural type so the handlers run under test without a worker.
 */

type WaitEvent = { waitUntil: (promise: Promise<unknown>) => void };

type WindowClient = {
  url: string;
  navigate: (url: string) => Promise<unknown>;
  focus: () => Promise<unknown>;
};

/** The slice of `ServiceWorkerGlobalScope` the handlers use. */
export type PushScope = {
  addEventListener: (type: string, handler: (event: never) => void) => void;
  clients: {
    matchAll: (options: {
      type: 'window';
      includeUncontrolled: boolean;
    }) => Promise<readonly WindowClient[]>;
    openWindow: (url: string) => Promise<unknown>;
  };
  location: { origin: string };
  navigator: {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  registration: {
    showNotification: (title: string, options: PushNotificationOptions) => Promise<void>;
  };
};

type PushEvent = WaitEvent & { data: { text: () => string } | null };
type ClickEvent = WaitEvent & { notification: { close: () => void; data: unknown } };

/** Set or clear the icon badge; a missing API or a refusal never blocks the notification. */
async function applyBadge(scope: PushScope, count: number): Promise<void> {
  try {
    if (count === 0) {
      await scope.navigator.clearAppBadge?.();
    } else {
      await scope.navigator.setAppBadge?.(count);
    }
  } catch {
    // the badge is a courtesy
  }
}

async function showPush(scope: PushScope, event: PushEvent): Promise<void> {
  let text: string | undefined;
  try {
    text = event.data?.text();
  } catch {
    text = undefined;
  }
  const { appBadge, options, title } = mapPush(text, scope.location.origin);
  await scope.registration.showNotification(title, options);
  if (appBadge !== undefined) {
    await applyBadge(scope, appBadge);
  }
}

/** Bring the tap's target up: reuse a console window when one is open, else open one. */
async function openTarget(scope: PushScope, target: string): Promise<void> {
  const windows = await scope.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  const existing = windows.find((win) => new URL(win.url).origin === scope.location.origin);
  if (existing === undefined) {
    await scope.clients.openWindow(target);
    return;
  }
  // A window the worker does not control refuses `navigate`, so the target
  // opens in a new window instead.
  try {
    await existing.navigate(target);
  } catch {
    await scope.clients.openWindow(target);
    return;
  }
  // Chromium may refuse focus without a gesture; the navigation stands.
  try {
    await existing.focus();
  } catch {
    // refused
  }
}

export function registerPushHandlers(scope: PushScope): void {
  scope.addEventListener('push', (event: PushEvent) => {
    event.waitUntil(showPush(scope, event));
  });
  scope.addEventListener('notificationclick', (event: ClickEvent) => {
    event.notification.close();
    const target = clickTarget(event.notification.data, scope.location.origin);
    event.waitUntil(openTarget(scope, target));
  });
}

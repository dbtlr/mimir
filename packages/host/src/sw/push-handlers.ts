import { applyAppBadge } from '../lib/badge';
import type { BadgeTarget } from '../lib/badge';
import { clickTarget, mapPush } from '../lib/push-notification';
import type { PushNotificationOptions } from '../lib/push-notification';

/*
 * The service worker's push and notificationclick handlers (ADR 0045, MMR-710).
 * The generated Workbox worker imports this file's build (`sw-push-<hash>.js`), so
 * the precache and update flow stay Workbox's. The scope is a narrow
 * structural type so the handlers run under test without a worker.
 */

type WaitEvent = { waitUntil: (promise: Promise<unknown>) => void };

type FocusableClient = { focus: () => Promise<unknown> };

type WindowClient = FocusableClient & {
  url: string;
  /** Resolves to the client for the navigated document, or null when it left the origin. */
  navigate: (url: string) => Promise<FocusableClient | null>;
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
  navigator: BadgeTarget;
  registration: {
    showNotification: (title: string, options: PushNotificationOptions) => Promise<void>;
  };
};

type PushEvent = WaitEvent & { data: { text: () => string } | null };
type ClickEvent = WaitEvent & { notification: { close: () => void; data: unknown } };

async function showPush(scope: PushScope, event: PushEvent): Promise<void> {
  let text: string | undefined;
  try {
    text = event.data?.text();
  } catch {
    text = undefined;
  }
  const { appBadge, options, title } = mapPush(text, scope.location.origin);
  await scope.registration.showNotification(title, options);
  // A missing Badging API or a refusal never blocks the notification.
  if (appBadge !== undefined) {
    await applyAppBadge(scope.navigator, appBadge);
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
  let navigated: FocusableClient | null;
  try {
    navigated = await existing.navigate(target);
  } catch {
    await scope.clients.openWindow(target);
    return;
  }
  // Focus the navigated document's client: the old one belongs to the
  // replaced document. Chromium may refuse focus without a gesture; the
  // navigation stands.
  try {
    await navigated?.focus();
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

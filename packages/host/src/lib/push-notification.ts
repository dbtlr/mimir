/*
 * The service worker's reading of a Web Push (ADR 0045, MMR-709/MMR-710): a
 * pure mapping from the pushed bytes to the notification to show, and the
 * rule for where a tap goes. It reads each payload field by hand and imports
 * nothing from the server, so no server code reaches the worker bundle.
 */

const ICON = '/icons/mimir.svg';
const GENERIC_TAG = 'mimir';

/** The options the worker hands `showNotification`, `renotify` always set. */
export type PushNotificationOptions = {
  badge: string;
  body: string;
  data: { navigate: string };
  dir: 'ltr' | 'rtl';
  icon: string;
  lang: string;
  renotify: true;
  tag: string;
};

export type MappedPush = {
  title: string;
  options: PushNotificationOptions;
  /** The needs-you count for the app icon badge; absent when the push sets none. */
  appBadge: number | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseJson(data: string | undefined): unknown {
  if (data === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** The origin's root, where a tap goes when the push names nothing usable. */
function rootOf(origin: string): string {
  return new URL('/', origin).href;
}

/** A tap's destination: the push's `navigate` when it is on the worker's origin, else the root. */
export function clickTarget(data: unknown, origin: string): string {
  const navigate = isRecord(data) ? text(data.navigate) : undefined;
  if (navigate !== undefined) {
    try {
      const url = new URL(navigate);
      if (url.origin === new URL(origin).origin) {
        return url.href;
      }
    } catch {
      // not an absolute URL: fall through to the root
    }
  }
  return rootOf(origin);
}

/** The badge a push sets: only a non-negative integer at the top level counts. */
function badgeOf(payload: Record<string, unknown> | undefined): number | undefined {
  const value = payload?.app_badge;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function generic(origin: string): MappedPush {
  return {
    appBadge: undefined,
    options: {
      badge: ICON,
      body: 'Something needs you.',
      data: { navigate: rootOf(origin) },
      dir: 'ltr',
      icon: ICON,
      lang: 'en',
      renotify: true,
      tag: GENERIC_TAG,
    },
    title: 'Mimir',
  };
}

/** Map a push's data to the notification to show. Every push shows one, whatever it carries. */
export function mapPush(data: string | undefined, origin: string): MappedPush {
  const parsed = parseJson(data);
  const payload = isRecord(parsed) ? parsed : undefined;
  const notification = isRecord(payload?.notification) ? payload.notification : undefined;
  const title = text(notification?.title);
  if (notification === undefined || title === undefined) {
    return generic(origin);
  }
  return {
    appBadge: badgeOf(payload),
    options: {
      badge: ICON,
      body: text(notification.body) ?? '',
      data: { navigate: clickTarget(notification, origin) },
      dir: notification.dir === 'rtl' ? 'rtl' : 'ltr',
      icon: ICON,
      lang: text(notification.lang) ?? 'en',
      renotify: true,
      tag: text(notification.tag) ?? GENERIC_TAG,
    },
    title,
  };
}

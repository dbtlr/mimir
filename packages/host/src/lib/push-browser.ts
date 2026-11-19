import { decodeBase64Url, encodeBase64Url } from './base64url';
import { identify } from './push-identity';
import type { BrowserIdentity } from './push-identity';

/*
 * The one browser-facing adapter for this browser's Web Push subscription
 * (ADR 0045, MMR-711): the user agent, Notification permission, the push
 * manager, and the small local record of what this browser last did. Every
 * navigator, Notification, PushManager, and localStorage call is here, with
 * the environment injected, so the page and the healer run against a fake.
 */

export type PushPermission = NotificationPermission | 'unsupported';

/** This browser's subscription as the host stores it: the endpoint, its keys, and the key it was made for. */
export type BrowserSubscription = {
  endpoint: string;
  /** The key the browser subscribed with, unpadded base64url; null when it did not say. */
  applicationServerKey: string | null;
  p256dh: string;
  auth: string;
};

/** What this browser last did, kept in its own storage; absent storage is no record. */
export type ThisDeviceRecord = { state: 'on'; endpoint: string } | { state: 'removed' };

/** What the page can read of this browser without asking it anything. */
export type BrowserSnapshot = {
  identity: BrowserIdentity;
  /** Service workers, the push manager, and Notification all exist. */
  pushSupported: boolean;
  permission: PushPermission;
};

export type PushBrowser = {
  snapshot: () => BrowserSnapshot;
  /** Asks for permission; call it first in a click, so the prompt is user-activated. */
  requestPermission: () => Promise<PushPermission>;
  subscription: () => Promise<BrowserSubscription | null>;
  /** Subscribes with the served key, replacing a subscription made for another key. */
  subscribe: (publicKey: string) => Promise<BrowserSubscription>;
  /** Drops this browser's subscription; none is not an error. */
  unsubscribe: () => Promise<void>;
  readRecord: () => ThisDeviceRecord | null;
  /** `null` clears the record. */
  writeRecord: (record: ThisDeviceRecord | null) => void;
};

type SubscriptionLike = Pick<PushSubscription, 'endpoint' | 'getKey' | 'unsubscribe'> & {
  options: { applicationServerKey: ArrayBuffer | null };
};

export type PushBrowserEnvironment = {
  userAgent: string;
  maxTouchPoints: number;
  standalone: () => boolean;
  pushSupported: () => boolean;
  permission: () => PushPermission;
  requestPermission: () => Promise<PushPermission>;
  ready: () => Promise<{
    pushManager: {
      getSubscription: () => Promise<SubscriptionLike | null>;
      subscribe: (options: {
        userVisibleOnly: boolean;
        applicationServerKey: Uint8Array<ArrayBuffer>;
      }) => Promise<SubscriptionLike>;
    };
  }>;
  /** Throws or returns undefined where storage is blocked. */
  storage: () => Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> | undefined;
};

/** Where the record lives in this browser's storage. */
export const RECORD_KEY = 'mimir.push.thisDevice';

function describe(subscription: SubscriptionLike): BrowserSubscription {
  const key = (name: 'auth' | 'p256dh') => {
    const bytes = subscription.getKey(name);
    return bytes === null ? '' : encodeBase64Url(bytes);
  };
  const served = subscription.options.applicationServerKey;
  return {
    applicationServerKey: served === null ? null : encodeBase64Url(served),
    auth: key('auth'),
    endpoint: subscription.endpoint,
    p256dh: key('p256dh'),
  };
}

function parseRecord(text: string | null): ThisDeviceRecord | null {
  if (text === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('state' in value)) {
      return null;
    }
    if (value.state === 'removed') {
      return { state: 'removed' };
    }
    if (value.state === 'on' && 'endpoint' in value && typeof value.endpoint === 'string') {
      return { endpoint: value.endpoint, state: 'on' };
    }
  } catch {
    // A record that does not parse is no record.
  }
  return null;
}

/** The adapter over an injected environment. */
export function createPushBrowser(environment: PushBrowserEnvironment): PushBrowser {
  const store = () => {
    try {
      return environment.storage();
    } catch {
      return undefined;
    }
  };
  const current = async () => {
    const { pushManager } = await environment.ready();
    return { pushManager, subscription: await pushManager.getSubscription() };
  };
  return {
    readRecord() {
      try {
        return parseRecord(store()?.getItem(RECORD_KEY) ?? null);
      } catch {
        return null;
      }
    },
    async requestPermission() {
      return environment.requestPermission();
    },
    snapshot() {
      return {
        identity: identify({
          maxTouchPoints: environment.maxTouchPoints,
          standalone: environment.standalone(),
          userAgent: environment.userAgent,
        }),
        permission: environment.permission(),
        pushSupported: environment.pushSupported(),
      };
    },
    async subscribe(publicKey) {
      const { pushManager, subscription: existing } = await current();
      if (existing !== null && describe(existing).applicationServerKey !== publicKey) {
        // A browser refuses to subscribe with a new key while one is held.
        await existing.unsubscribe();
      }
      const made = await pushManager.subscribe({
        applicationServerKey: decodeBase64Url(publicKey),
        userVisibleOnly: true,
      });
      return describe(made);
    },
    async subscription() {
      if (!environment.pushSupported()) {
        return null;
      }
      const { subscription } = await current();
      return subscription === null ? null : describe(subscription);
    },
    async unsubscribe() {
      if (!environment.pushSupported()) {
        return;
      }
      const { subscription } = await current();
      await subscription?.unsubscribe();
    },
    writeRecord(record) {
      try {
        if (record === null) {
          store()?.removeItem(RECORD_KEY);
        } else {
          store()?.setItem(RECORD_KEY, JSON.stringify(record));
        }
      } catch {
        // Blocked storage keeps no record; the page still works from the browser and the host.
      }
    },
  };
}

/** The adapter over this browser's own globals. */
const browserSupportsPush = () =>
  'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;

export function createBrowserPushBrowser(): PushBrowser {
  const supported = browserSupportsPush;
  return createPushBrowser({
    maxTouchPoints: navigator.maxTouchPoints,
    permission: () => (supported() ? Notification.permission : 'unsupported'),
    pushSupported: supported,
    ready: async () => navigator.serviceWorker.ready,
    requestPermission: async () => Notification.requestPermission(),
    standalone: () =>
      globalThis.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && navigator.standalone === true),
    storage: () => globalThis.localStorage,
    userAgent: navigator.userAgent,
  });
}

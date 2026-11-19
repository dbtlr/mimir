import { describe, expect, it, vi } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from '../lib/base64url';
import { createPushBrowser, PushReadTimeoutError, RECORD_KEY } from '../lib/push-browser';
import type { PushBrowserEnvironment } from '../lib/push-browser';

/** A push manager holding at most one subscription, made for the key it was given. */
function world(held: { endpoint: string; key: string } | null) {
  let current = held;
  const unsubscribe = vi.fn(async () => {
    current = null;
    return true;
  });
  const make = (endpoint: string, key: string) => ({
    endpoint,
    getKey: (name: string) => new Uint8Array(name === 'auth' ? [1, 2] : [3, 4]).buffer,
    options: { applicationServerKey: decodeBase64Url(key).buffer },
    unsubscribe,
  });
  const subscribe = vi.fn(
    async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      if (current !== null) {
        throw new Error('InvalidStateError');
      }
      current = {
        endpoint: 'https://push.example/new',
        key: encodeBase64Url(applicationServerKey),
      };
      return make(current.endpoint, current.key);
    },
  );
  const store = new Map<string, string>();
  const environment: PushBrowserEnvironment = {
    after: async () => Promise.withResolvers<void>().promise,
    maxTouchPoints: 0,
    permission: () => 'granted',
    pushSupported: () => true,
    ready: async () => ({
      pushManager: {
        getSubscription: async () =>
          current === null ? null : make(current.endpoint, current.key),
        subscribe,
      },
    }),
    requestPermission: async () => 'granted',
    standalone: () => false,
    storage: () => ({
      getItem: (key) => store.get(key) ?? null,
      removeItem: (key) => void store.delete(key),
      setItem: (key, value) => void store.set(key, value),
    }),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36',
  };
  return { environment, store, subscribe, unsubscribe };
}

/** An adapter whose service worker never starts, and whose waits end at once. */
function stuck() {
  const { environment } = world({ endpoint: 'https://push.example/old', key: KEY_A });
  const after = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const browser = createPushBrowser({
    ...environment,
    after,
    ready: async () => Promise.withResolvers<never>().promise,
  });
  return { after, browser };
}

const KEY_A = encodeBase64Url(new Uint8Array([10, 11, 12]));
const KEY_B = encodeBase64Url(new Uint8Array([20, 21, 22]));

describe('createPushBrowser', () => {
  it('replaces a subscription made for another key, and returns unpadded keys', async () => {
    const { environment, unsubscribe } = world({
      endpoint: 'https://push.example/old',
      key: KEY_A,
    });
    const made = await createPushBrowser(environment).subscribe(KEY_B);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(made).toStrictEqual({
      applicationServerKey: KEY_B,
      auth: 'AQI',
      endpoint: 'https://push.example/new',
      p256dh: 'AwQ',
    });
  });

  it('reads the held subscription with the key it was made for', async () => {
    const { environment } = world({ endpoint: 'https://push.example/old', key: KEY_A });
    await expect(createPushBrowser(environment).subscription()).resolves.toMatchObject({
      applicationServerKey: KEY_A,
      endpoint: 'https://push.example/old',
    });
  });

  it('keeps the record in storage and treats a bad or blocked store as no record', () => {
    const { environment, store } = world(null);
    const browser = createPushBrowser(environment);
    browser.writeRecord({ endpoint: 'e', serverKey: 'k', state: 'on' });
    expect(browser.readRecord()).toStrictEqual({ endpoint: 'e', serverKey: 'k', state: 'on' });
    browser.writeRecord(null);
    expect(store.has(RECORD_KEY)).toBe(false);
    // A record from before the key was kept still reads, with no key.
    store.set(RECORD_KEY, JSON.stringify({ endpoint: 'e', state: 'on' }));
    expect(browser.readRecord()).toStrictEqual({ endpoint: 'e', serverKey: null, state: 'on' });
    store.set(RECORD_KEY, '{nope');
    expect(browser.readRecord()).toBeNull();
    const blocked = createPushBrowser({
      ...environment,
      storage: () => {
        throw new Error('blocked');
      },
    });
    expect(blocked.readRecord()).toBeNull();
    expect(() => {
      blocked.writeRecord({ state: 'removed' });
    }).not.toThrow();
  });

  describe('when the service worker never starts', () => {
    it('answers a read after 5 s with a timeout, not with no subscription', async () => {
      const { after, browser } = stuck();
      await expect(browser.subscription()).rejects.toBeInstanceOf(PushReadTimeoutError);
      expect(after.mock.calls).toStrictEqual([[5000]]);
    });

    it('does nothing on unsubscribe after 5 s', async () => {
      const { after, browser } = stuck();
      await expect(browser.unsubscribe()).resolves.toBeUndefined();
      expect(after.mock.calls).toStrictEqual([[5000]]);
    });

    it('fails a subscribe after 10 s', async () => {
      const { after, browser } = stuck();
      await expect(browser.subscribe(KEY_B)).rejects.toThrow('service worker');
      expect(after.mock.calls).toStrictEqual([[10_000]]);
    });
  });
});

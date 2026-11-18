import type { HostSecretStore, PushSubscriptionRecord, PushSubscriptionStore } from '@mimir/core';

import type { NotificationEvent } from './notification-events';
import type { NotificationChannel } from './notifier';
import { normalizePushEndpoint, serializePushEndpoint } from './push-endpoint';
import type { PushSubscribeInput } from './push-input';
import { createVapidKeyring } from './push-key';
import type { VapidKeyring } from './push-key';
import { eventPayload, testPayload } from './push-payload';
import { isUsableSubscriptionKeys } from './push-protocol';
import type { VapidKeys } from './push-protocol';
import { recordOutcome, sendPush } from './push-send';
import type { PushFetch, PushSender, PushTarget } from './push-send';
import type { PushSettings } from './push-settings';
import type {
  PushDevice,
  PushDeviceList,
  PushFailure,
  PushResetResult,
  PushSendTestResult,
  PushStatus,
  PushSubscribeResult,
  PushUnavailable,
  PushUnsubscribeResult,
} from './push-states';

export { PUSH_SECRET_NAME } from './push-key';

/*
 * The Web Push channel (ADR 0045, the MMR-709 refinement): the notifier's
 * channel and the operations behind the console's six server functions. Each
 * operation answers `unconfigured` or `misconfigured` before it touches a
 * table when the channel is not ready. A store error rejects (a host fault);
 * a push service's failure is an answer.
 */

/** The most subscriptions the table holds. */
export const PUSH_DEVICE_LIMIT = 20;

/** A send with no answer in this long is a `timeout`. */
export const PUSH_TIMEOUT_MS = 10_000;

/** The longest label, in characters. */
const LABEL_LIMIT = 60;
const LABEL_PREFIX = new RegExp(`^.{0,${String(LABEL_LIMIT)}}`, 'su');

export type PushChannelOptions = {
  settings: PushSettings;
  secrets: HostSecretStore;
  subscriptions: PushSubscriptionStore;
  fetch?: PushFetch;
  log?: (line: string) => void;
  clock?: () => number;
  /** A send's time limit; {@link PUSH_TIMEOUT_MS} unless set. */
  timeoutMs?: number;
};

/** The label as plain text: whitespace runs collapsed, cut to 60 characters, `Device` when empty. */
export function plainLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim();
  // `u` counts code points, so a cut never splits a surrogate pair.
  const cut = (LABEL_PREFIX.exec(flat)?.[0] ?? '').trimEnd();
  return cut === '' ? 'Device' : cut;
}

/** Whether a request's `Origin` header names the console's scheme, host, and port. */
function isConsoleOrigin(origin: string | null, consoleUrl: string): boolean {
  return origin !== null && URL.parse(origin)?.origin === new URL(consoleUrl).origin;
}

/** Whether a stored failure is one the channel writes. */
function isPushFailure(text: string): text is PushFailure {
  return text === 'timeout' || text === 'unreachable' || /^HTTP \d+$/.test(text);
}

/** A row as the device list shows it: no keys. */
function deviceOf(row: PushSubscriptionRecord, currentKey: string | undefined): PushDevice {
  const { createdAt, endpoint, label, lastFailure, lastFailureAt, lastSuccessAt } = row;
  return {
    createdAt,
    currentKey: row.serverKey === currentKey,
    endpoint,
    label,
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
    ...(lastFailure !== undefined && isPushFailure(lastFailure) ? { lastFailure } : {}),
  };
}

const targetOf = ({ auth, endpoint, p256dh }: PushSubscriptionRecord): PushTarget => ({
  auth,
  endpoint,
  p256dh,
});

export function createPushChannel(options: PushChannelOptions) {
  const { secrets, settings, subscriptions } = options;
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const fetch: PushFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;

  type Ready = { consoleUrl: string; keyring: VapidKeyring; sender: PushSender };

  /** The ready channel's parts, or the state that says why it is not ready. */
  const setup = ((): Ready | PushUnavailable => {
    if (!settings.enabled) {
      return { state: 'unconfigured' };
    }
    const { consoleUrl, contact, key, problems } = settings;
    const [problem] = problems;
    if (
      problem !== undefined ||
      contact === undefined ||
      consoleUrl === undefined ||
      key === undefined
    ) {
      return {
        state: 'misconfigured',
        ...(problem ?? { problem: 'malformed', setting: 'MIMIR_PUSH_CONTACT' }),
      };
    }
    return {
      consoleUrl,
      keyring: createVapidKeyring({ clock, key, log, secrets }),
      sender: { clock, contact, fetch, timeoutMs },
    };
  })();

  const recorder = { clock, log, subscriptions };

  /** Send one push to a row and record its outcome; this never rejects. */
  const pushTo = async (
    sender: PushSender,
    row: PushSubscriptionRecord,
    vapid: VapidKeys,
    payload: unknown,
  ) => {
    const target = targetOf(row);
    const outcome = await sendPush(sender, target, vapid, payload);
    const write = await recordOutcome(recorder, target, outcome);
    return { outcome, write };
  };

  return {
    /** The notifier's channel: every row made for the current key, all at once. */
    deliver: async (event: NotificationEvent): Promise<void> => {
      if ('state' in setup) {
        return;
      }
      const key = await setup.keyring.current();
      if (key.state !== 'ready') {
        return;
      }
      const rows = await subscriptions.list();
      const payload = eventPayload(event, setup.consoleUrl);
      await Promise.all(
        rows
          .filter((row) => row.serverKey === key.keys.publicKey)
          .map((row) => pushTo(setup.sender, row, key.keys, payload)),
      );
    },

    /** The device list, newest first; in the key unusable state no row is made for the current key. */
    list: async (): Promise<PushDeviceList> => {
      if ('state' in setup) {
        return setup;
      }
      const key = await setup.keyring.current();
      const current = key.state === 'ready' ? key.keys.publicKey : undefined;
      const rows = await subscriptions.list();
      return { devices: rows.map((row) => deviceOf(row, current)), state: 'listed' };
    },

    /**
     * Replace the pair, delete every row made for another key, and answer the
     * new key, all in one turn of the keyring.
     */
    resetKey: async (): Promise<PushResetResult> => {
      if ('state' in setup) {
        return setup;
      }
      const keys = await setup.keyring.reset((stored) =>
        subscriptions.removeOtherKeys(stored.publicKey),
      );
      return { publicKey: keys.publicKey, state: 'reset' };
    },

    /** Send one test push to one endpoint; a local or store fault rejects. */
    sendTest: async (endpoint: string): Promise<PushSendTestResult> => {
      if ('state' in setup) {
        return setup;
      }
      const key = await setup.keyring.current();
      if (key.state !== 'ready') {
        return key;
      }
      const serialized = serializePushEndpoint(endpoint);
      const row = serialized === undefined ? undefined : await subscriptions.get(serialized);
      if (row === undefined) {
        return { state: 'not_found' };
      }
      if (row.serverKey !== key.keys.publicKey) {
        return { state: 'stale_key' };
      }
      const { outcome, write } = await pushTo(
        setup.sender,
        row,
        key.keys,
        testPayload(setup.consoleUrl),
      );
      // A local fault is a host fault: the answer would say nothing true about the device.
      if (outcome.kind === 'unbuilt') {
        throw new Error('the test push could not be encrypted or signed for its row');
      }
      if (!write.landed) {
        throw write.error;
      }
      if (outcome.kind === 'failed') {
        return { failure: outcome.failure, state: 'failed' };
      }
      return { state: outcome.kind };
    },

    /** The key a browser subscribes with and the origin a push opens. */
    status: async (): Promise<PushStatus> => {
      if ('state' in setup) {
        return setup;
      }
      const key = await setup.keyring.current();
      return key.state === 'ready'
        ? { consoleOrigin: setup.consoleUrl, publicKey: key.keys.publicKey, state: 'ready' }
        : key;
    },

    /**
     * Subscribe a browser, from the request's `Origin` header. A refusal
     * writes nothing; the count and the write are one transaction. The key's
     * read, its check, and the write take one turn of the keyring, so a reset
     * in this process runs wholly before or after them.
     */
    subscribe: async (
      input: PushSubscribeInput,
      origin: string | null,
    ): Promise<PushSubscribeResult> => {
      if ('state' in setup) {
        return setup;
      }
      if (!isConsoleOrigin(origin, setup.consoleUrl)) {
        return { state: 'wrong_origin' };
      }
      return setup.keyring.withCurrent(async (key): Promise<PushSubscribeResult> => {
        if (key.state !== 'ready') {
          return key;
        }
        if (input.serverKey !== key.keys.publicKey) {
          return { state: 'stale_key' };
        }
        const endpoint = normalizePushEndpoint(input.endpoint);
        if (endpoint === undefined) {
          return { state: 'endpoint_not_allowed' };
        }
        if (!(await isUsableSubscriptionKeys(input))) {
          return { state: 'invalid_keys' };
        }
        const written = await subscriptions.subscribe(
          {
            auth: input.auth,
            endpoint,
            label: plainLabel(input.label),
            p256dh: input.p256dh,
            serverKey: key.keys.publicKey,
          },
          PUSH_DEVICE_LIMIT,
        );
        return { state: written };
      });
    },

    /** Delete an endpoint's row; an endpoint with no row is not an error. */
    unsubscribe: async (endpoint: string): Promise<PushUnsubscribeResult> => {
      if ('state' in setup) {
        return setup;
      }
      const serialized = serializePushEndpoint(endpoint);
      if (serialized !== undefined) {
        await subscriptions.remove(serialized);
      }
      return { state: 'unsubscribed' };
    },
  } satisfies NotificationChannel & Record<string, unknown>;
}

export type PushChannel = ReturnType<typeof createPushChannel>;

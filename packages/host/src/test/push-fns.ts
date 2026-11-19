// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import {
  pushDevices,
  pushStatus,
  resetPushKey,
  sendTestPush,
  subscribePush,
  unsubscribePush,
} from '../api/fns/push';
import type {
  PushDevice,
  PushResetResult,
  PushSendTestResult,
  PushStatus,
  PushSubscribeResult,
} from '../api/fns/push';
import type {
  BrowserSnapshot,
  BrowserSubscription,
  PushBrowser,
  ThisDeviceRecord,
} from '../lib/push-browser';

/*
 * The Web Push server functions served from one world, and a fake browser
 * adapter (MMR-711). A test file mocks the module first —
 * `vi.mock('../api/fns/push')` — then calls `servePush`.
 */

export const SERVED_KEY = 'BServedKeyAAAA';
export const CONSOLE_ORIGIN = 'https://mimir.example';

/** The host's status when it serves `publicKey`. */
export const readyWith = (publicKey: string): Extract<PushStatus, { state: 'ready' }> => ({
  consoleOrigin: CONSOLE_ORIGIN,
  publicKey,
  state: 'ready',
});

export const READY: PushStatus = readyWith(SERVED_KEY);

export type PushWorld = {
  status: PushStatus;
  devices: PushDevice[];
  subscribe: PushSubscribeResult;
  sendTest: PushSendTestResult;
  reset: PushResetResult;
};

export const device = (overrides: Partial<PushDevice> & { endpoint: string }): PushDevice => ({
  createdAt: '2026-11-18T10:00:00.000Z',
  currentKey: true,
  label: 'Mac · Chrome',
  ...overrides,
});

/** Answer the push server functions from `world`; the returned state is live. */
export function servePush(world: Partial<PushWorld> = {}): PushWorld {
  const state: PushWorld = {
    devices: [],
    reset: { publicKey: 'BNewKey', state: 'reset' },
    sendTest: { state: 'delivered' },
    status: READY,
    subscribe: { state: 'subscribed' },
    ...world,
  };
  vi.mocked(pushStatus).mockImplementation(async () => state.status);
  vi.mocked(pushDevices).mockImplementation(async () => ({
    devices: state.devices,
    state: 'listed',
  }));
  // A subscribe the host accepts adds the device under its normalized endpoint, as in production.
  vi.mocked(subscribePush).mockImplementation(async ({ data }) => {
    if (state.subscribe.state === 'subscribed') {
      const endpoint = new URL(data.endpoint).href;
      state.devices = [
        device({ endpoint, label: data.label }),
        ...state.devices.filter((candidate) => candidate.endpoint !== endpoint),
      ];
    }
    return state.subscribe;
  });
  vi.mocked(unsubscribePush).mockImplementation(async ({ data }) => {
    const endpoint = new URL(data.endpoint).href;
    state.devices = state.devices.filter((candidate) => candidate.endpoint !== endpoint);
    return { state: 'unsubscribed' };
  });
  vi.mocked(sendTestPush).mockImplementation(async () => state.sendTest);
  // A reset serves the new key and deletes every row made for another key, as in
  // production; the new key is fresh, so that is every row.
  vi.mocked(resetPushKey).mockImplementation(async () => {
    if (state.reset.state === 'reset') {
      state.status = readyWith(state.reset.publicKey);
      state.devices = [];
    }
    return state.reset;
  });
  return state;
}

export const IPHONE = {
  installed: true,
  platform: 'iPhone',
} as const;

export type FakeBrowser = PushBrowser & {
  held: BrowserSubscription | null;
  record: ThisDeviceRecord | null;
  permission: BrowserSnapshot['permission'];
  /** What the next permission prompt answers. */
  promptAnswer: BrowserSnapshot['permission'];
  /** Whether the notifications suggestion was answered. */
  answered: boolean;
};

export const SUBSCRIPTION: BrowserSubscription = {
  applicationServerKey: SERVED_KEY,
  auth: 'auth-1',
  endpoint: 'https://push.example/this',
  p256dh: 'p256-1',
};

/** A browser adapter whose state a test sets and reads directly. Each subscribe gets a new endpoint, as a push service gives. */
export function fakeBrowser(
  start: Partial<Pick<FakeBrowser, 'held' | 'permission' | 'record'>> & {
    snapshot?: Partial<BrowserSnapshot>;
  } = {},
): FakeBrowser {
  let made = 0;
  const fake: FakeBrowser = {
    answerSuggestion() {
      fake.answered = true;
    },
    answered: false,
    held: start.held ?? null,
    permission: start.permission ?? 'default',
    promptAnswer: 'granted',
    readRecord: () => fake.record,
    record: start.record ?? null,
    async requestPermission() {
      fake.permission = fake.promptAnswer;
      return fake.permission;
    },
    snapshot: () => ({
      identity: { browser: 'Chrome', installed: false, platform: 'Mac' },
      permission: fake.permission,
      pushSupported: true,
      ...start.snapshot,
    }),
    async subscribe(publicKey) {
      made += 1;
      fake.held = {
        ...SUBSCRIPTION,
        applicationServerKey: publicKey,
        endpoint: `https://push.example/made-${String(made)}`,
      };
      return fake.held;
    },
    async subscription() {
      return fake.held;
    },
    suggestionAnswered: () => fake.answered,
    async unsubscribe() {
      fake.held = null;
    },
    writeRecord(record) {
      fake.record = record;
    },
  };
  return fake;
}

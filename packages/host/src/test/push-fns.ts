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

export const READY: PushStatus = {
  consoleOrigin: CONSOLE_ORIGIN,
  publicKey: SERVED_KEY,
  state: 'ready',
};

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
  // A subscribe the host accepts adds the device, as in production.
  vi.mocked(subscribePush).mockImplementation(async ({ data }) => {
    if (state.subscribe.state === 'subscribed') {
      state.devices = [
        device({ endpoint: data.endpoint, label: data.label }),
        ...state.devices.filter((candidate) => candidate.endpoint !== data.endpoint),
      ];
    }
    return state.subscribe;
  });
  vi.mocked(unsubscribePush).mockImplementation(async ({ data }) => {
    state.devices = state.devices.filter((candidate) => candidate.endpoint !== data.endpoint);
    return { state: 'unsubscribed' };
  });
  vi.mocked(sendTestPush).mockImplementation(async () => state.sendTest);
  vi.mocked(resetPushKey).mockImplementation(async () => state.reset);
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
};

export const SUBSCRIPTION: BrowserSubscription = {
  applicationServerKey: SERVED_KEY,
  auth: 'auth-1',
  endpoint: 'https://push.example/this',
  p256dh: 'p256-1',
};

/** A browser adapter whose state a test sets and reads directly. */
export function fakeBrowser(
  start: Partial<Pick<FakeBrowser, 'held' | 'permission' | 'record'>> & {
    snapshot?: Partial<BrowserSnapshot>;
  } = {},
): FakeBrowser {
  const fake: FakeBrowser = {
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
      fake.held = { ...SUBSCRIPTION, applicationServerKey: publicKey };
      return fake.held;
    },
    async subscription() {
      return fake.held;
    },
    async unsubscribe() {
      fake.held = null;
    },
    writeRecord(record) {
      fake.record = record;
    },
  };
  return fake;
}

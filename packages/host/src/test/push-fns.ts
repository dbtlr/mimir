// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import {
  pushDevices,
  pushStatus,
  resetPushKey,
  sendTestPush,
  setPushKind,
  subscribePush,
  unsubscribePush,
} from '../api/fns/push';
import type {
  PushDevice,
  PushResetResult,
  PushSendTestResult,
  PushSetKindResult,
  PushStatus,
  PushSubscribeResult,
} from '../api/fns/push';
import type {
  BrowserSnapshot,
  BrowserSubscription,
  PushBrowser,
  ThisDeviceRecord,
} from '../lib/push-browser';
import { orderedKinds, withKind } from '../server/push-states';

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
  /** What Set kind answers when it does not save; unset, it saves like the host. */
  setKind?: PushSetKindResult;
};

export const device = (overrides: Partial<PushDevice> & { endpoint: string }): PushDevice => ({
  createdAt: '2026-11-18T10:00:00.000Z',
  currentKey: true,
  label: 'Mac · Chrome',
  muted: [],
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
  // A subscribe the host accepts adds the device under its normalized endpoint, as in
  // production: a known row keeps its muted kinds unless the subscribe names some.
  vi.mocked(subscribePush).mockImplementation(async ({ data }) => {
    if (state.subscribe.state === 'subscribed') {
      const endpoint = new URL(data.endpoint).href;
      const known = state.devices.find((candidate) => candidate.endpoint === endpoint);
      const muted = data.muted === undefined ? (known?.muted ?? []) : orderedKinds(data.muted);
      state.devices = [
        device({ endpoint, label: data.label, muted }),
        ...state.devices.filter((candidate) => candidate.endpoint !== endpoint),
      ];
    }
    return state.subscribe;
  });
  // Set kind changes one kind on the row, as in production, unless the world answers otherwise.
  vi.mocked(setPushKind).mockImplementation(async ({ data }) => {
    if (state.setKind !== undefined) {
      return state.setKind;
    }
    const endpoint = new URL(data.endpoint).href;
    const row = state.devices.find((candidate) => candidate.endpoint === endpoint);
    if (row === undefined) {
      return { state: 'not_found' };
    }
    const muted = withKind(row.muted, data.kind, data.muted);
    // A new row, so a shared fixture is never changed between tests.
    state.devices = state.devices.map((candidate) =>
      candidate === row ? { ...row, muted } : candidate,
    );
    return { state: 'saved' };
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
  /** Another tab answers the suggestion: the answer is stored and the listeners hear it. */
  answerInAnotherTab: () => void;
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
  const listeners = new Set<() => void>();
  const fake: FakeBrowser = {
    answerInAnotherTab() {
      fake.answered = true;
      for (const listener of listeners) {
        listener();
      }
    },
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
    watchSuggestion(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    writeRecord(record) {
      fake.record = record;
    },
  };
  return fake;
}

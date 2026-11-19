import type { PushDevice, PushDeviceList, PushStatus } from '../api/fns/push';
import type { BrowserSnapshot, BrowserSubscription, ThisDeviceRecord } from './push-browser';
import { sameEndpoint } from './push-endpoint';
import { isIos } from './push-identity';

/*
 * The states of this browser's notification control (ADR 0045, MMR-711),
 * derived from what the host says, what the browser can do, and what this
 * browser last did. Pure, so each state is proved once here.
 */

export type ThisDeviceState =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'misconfigured'; setting: string; problem: string }
  | { kind: 'key_unusable' }
  | { kind: 'ios_needs_home_screen'; platform: 'iPhone' | 'iPad' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'removed' }
  | { kind: 'off' }
  | { kind: 'on'; device: PushDevice };

export type DeriveInput = {
  /** `undefined` while the status is loading. */
  status: PushStatus | undefined;
  /** `undefined` while the device list is loading. */
  devices: PushDeviceList | undefined;
  browser: BrowserSnapshot;
  /** `undefined` while the browser is being asked; `null` for none. */
  subscription: BrowserSubscription | null | undefined;
  record: ThisDeviceRecord | null;
};

function hostState(status: PushStatus): ThisDeviceState | undefined {
  switch (status.state) {
    case 'unconfigured':
    case 'key_unusable': {
      return { kind: status.state };
    }
    case 'misconfigured': {
      return { kind: 'misconfigured', problem: status.problem, setting: status.setting };
    }
    default: {
      return undefined;
    }
  }
}

function browserState(browser: BrowserSnapshot): ThisDeviceState | undefined {
  const { identity, permission, pushSupported } = browser;
  if (!pushSupported) {
    return isIos(identity.platform) && !identity.installed
      ? { kind: 'ios_needs_home_screen', platform: identity.platform }
      : { kind: 'unsupported' };
  }
  return permission === 'denied' ? { kind: 'denied' } : undefined;
}

/** Where this browser stands: the host's states first, then the browser's, then its own record. */
export function deriveThisDevice(input: DeriveInput): ThisDeviceState {
  const { status, devices, browser, subscription, record } = input;
  if (status === undefined) {
    return { kind: 'loading' };
  }
  const fromHost = hostState(status);
  if (fromHost !== undefined) {
    return fromHost;
  }
  const fromBrowser = browserState(browser);
  if (fromBrowser !== undefined) {
    return fromBrowser;
  }
  if (devices?.state !== 'listed' || subscription === undefined) {
    return { kind: 'loading' };
  }
  if (record?.state === 'removed') {
    return { kind: 'removed' };
  }
  const device =
    subscription === null
      ? undefined
      : devices.devices.find((candidate) =>
          sameEndpoint(candidate.endpoint, subscription.endpoint),
        );
  return device === undefined ? { kind: 'off' } : { device, kind: 'on' };
}

/** The Settings index's value for this page. */
export function notificationsValue(state: ThisDeviceState): string {
  switch (state.kind) {
    case 'loading': {
      return '';
    }
    case 'unconfigured':
    case 'misconfigured':
    case 'key_unusable':
    case 'unsupported': {
      return 'Unavailable';
    }
    case 'ios_needs_home_screen': {
      return 'Add to Home Screen';
    }
    case 'denied': {
      return 'Blocked';
    }
    case 'removed':
    case 'off': {
      return 'Off';
    }
    case 'on': {
      return 'On';
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** Whether the state offers this browser a Turn on button. */
export const canTurnOn = (state: ThisDeviceState): boolean =>
  state.kind === 'off' || state.kind === 'removed';

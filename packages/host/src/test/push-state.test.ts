import { describe, expect, it } from 'vitest';

import { decideHeal } from '../lib/push-heal';
import type { HealInput } from '../lib/push-heal';
import { deviceMeta, stateCaption } from '../lib/push-text';
import { deriveThisDevice, notificationsValue } from '../lib/push-this-device';
import type { DeriveInput, ThisDeviceState } from '../lib/push-this-device';
import { device, READY, SUBSCRIPTION } from './push-fns';

const chrome = { browser: 'Chrome', installed: false, platform: 'Mac' } as const;
const iphone = { browser: 'Safari', installed: false, platform: 'iPhone' } as const;
const mine = device({ endpoint: SUBSCRIPTION.endpoint, lastSuccessAt: '2026-11-19T09:00:00.000Z' });

const derive = (overrides: Partial<DeriveInput> = {}): ThisDeviceState =>
  deriveThisDevice({
    browser: { identity: chrome, permission: 'default', pushSupported: true },
    devices: { devices: [], state: 'listed' },
    record: null,
    status: READY,
    subscription: null,
    ...overrides,
  });

describe('deriveThisDevice', () => {
  it.each<[string, Partial<DeriveInput>, ThisDeviceState['kind'], string]>([
    ['status still loading', { status: undefined }, 'loading', ''],
    ['host not set up', { status: { state: 'unconfigured' } }, 'unconfigured', 'Unavailable'],
    [
      'host set up wrong',
      { status: { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' } },
      'misconfigured',
      'Unavailable',
    ],
    ['key unusable', { status: { state: 'key_unusable' } }, 'key_unusable', 'Unavailable'],
    [
      'iPhone outside the Home Screen',
      { browser: { identity: iphone, permission: 'default', pushSupported: false } },
      'ios_needs_home_screen',
      'Add to Home Screen',
    ],
    [
      'a browser without push',
      { browser: { identity: chrome, permission: 'unsupported', pushSupported: false } },
      'unsupported',
      'Unavailable',
    ],
    [
      'permission denied',
      { browser: { identity: chrome, permission: 'denied', pushSupported: true } },
      'denied',
      'Blocked',
    ],
    ['a removed record', { record: { state: 'removed' } }, 'removed', 'Off'],
    ['permission not asked', {}, 'off', 'Off'],
    [
      'granted but unknown to the host',
      {
        browser: { identity: chrome, permission: 'granted', pushSupported: true },
        subscription: SUBSCRIPTION,
      },
      'off',
      'Off',
    ],
    [
      'subscribed and listed',
      {
        browser: { identity: chrome, permission: 'granted', pushSupported: true },
        devices: { devices: [mine], state: 'listed' },
        subscription: SUBSCRIPTION,
      },
      'on',
      'On',
    ],
  ])('%s', (_name, overrides, kind, value) => {
    const state = derive(overrides);
    expect(state.kind).toBe(kind);
    expect(notificationsValue(state)).toBe(value);
  });

  it('matches this browser to its row by the endpoint the host stores', () => {
    const raw = { ...SUBSCRIPTION, endpoint: 'https://PUSH.example/this' };
    expect(
      derive({
        browser: { identity: chrome, permission: 'granted', pushSupported: true },
        devices: { devices: [mine], state: 'listed' },
        subscription: raw,
      }).kind,
    ).toBe('on');
  });

  it('puts the host before the browser, and the browser before the record', () => {
    const blocked = { identity: iphone, permission: 'denied', pushSupported: false } as const;
    expect(
      derive({ browser: blocked, record: { state: 'removed' }, status: { state: 'key_unusable' } })
        .kind,
    ).toBe('key_unusable');
    expect(derive({ browser: blocked, record: { state: 'removed' } }).kind).toBe(
      'ios_needs_home_screen',
    );
    expect(
      derive({
        browser: { identity: chrome, permission: 'denied', pushSupported: true },
        record: { state: 'removed' },
      }).kind,
    ).toBe('denied');
  });
});

describe('stateCaption', () => {
  const now = Date.parse('2026-11-19T11:00:00.000Z');

  it('names the setting and the problem, never a value', () => {
    expect(
      stateCaption({ kind: 'misconfigured', problem: 'unset', setting: 'MIMIR_URL' }, chrome, now)
        .text,
    ).toBe("Notifications can't start: MIMIR_URL is unset. Fix it on the host and restart it.");
  });

  it('adds the macOS path for Chrome on a Mac, and the last delivery', () => {
    expect(stateCaption({ device: mine, kind: 'on' }, chrome, now).text).toBe(
      'Last one arrived 2h ago. Notifications arrive while Chrome is running. If a test shows nothing, check System Settings › Notifications › Google Chrome.',
    );
  });

  it('reports a newer failure over an older delivery, and no desktop hint on a phone', () => {
    const failed = device({
      ...mine,
      lastFailure: 'HTTP 410',
      lastFailureAt: '2026-11-19T10:30:00.000Z',
    });
    expect(
      stateCaption({ device: failed, kind: 'on' }, { ...iphone, installed: true }, now).text,
    ).toBe('Last attempt failed 30m ago: HTTP 410.');
  });

  it('gives the three Home Screen steps, with the platform named', () => {
    const caption = stateCaption({ kind: 'ios_needs_home_screen', platform: 'iPad' }, iphone, now);
    expect(caption.text).toContain('On iPad,');
    expect(caption.steps).toHaveLength(3);
  });

  it.each([
    [iphone, "iPhone's Settings › Notifications › Mimir"],
    [chrome, 'Site settings › Notifications › Allow'],
    [{ ...chrome, browser: 'Firefox' as const }, 'clear the Notifications block'],
    [{ ...chrome, browser: 'Safari' as const }, "browser's site settings"],
  ])('says how to undo a block', (identity, words) => {
    expect(stateCaption({ kind: 'denied' }, identity, now).text).toContain(words);
  });
});

describe('deviceMeta', () => {
  const now = Date.parse('2026-11-19T11:00:00.000Z');

  it('marks this device and the old key, and dates a failure', () => {
    expect(deviceMeta(mine, { now, thisDevice: true }).text).toBe('This device · delivered 2h ago');
    const old = device({
      currentKey: false,
      endpoint: 'x',
      lastFailure: 'HTTP 410',
      lastFailureAt: '2026-11-17T12:00:00.000Z',
    });
    expect(deviceMeta(old, { now, thisDevice: false })).toStrictEqual({
      oldKey: true,
      text: 'Old key · failed Nov 17: HTTP 410',
    });
  });
});

describe('decideHeal', () => {
  const OLD = 'https://push.example/old';
  const base: HealInput = {
    devices: { devices: [mine], state: 'listed' },
    permission: 'granted',
    pushSupported: true,
    record: { endpoint: SUBSCRIPTION.endpoint, state: 'on' },
    status: READY,
    subscription: SUBSCRIPTION,
  };

  it.each<[string, Partial<HealInput>, ReturnType<typeof decideHeal>]>([
    ['everything agrees', {}, { kind: 'none' }],
    [
      'case 1: the served key changed',
      { subscription: { ...SUBSCRIPTION, applicationServerKey: 'BOld' } },
      { kind: 'resubscribe', reason: 'key_changed' },
    ],
    [
      'case 2a: the browser dropped it',
      { subscription: null },
      { kind: 'resubscribe', reason: 'dropped' },
    ],
    [
      'case 2b: the browser replaced it',
      { record: { endpoint: OLD, state: 'on' } },
      { kind: 'adopt', staleEndpoint: OLD },
    ],
    [
      'case 3: the host no longer lists it',
      { devices: { devices: [], state: 'listed' } },
      { kind: 'mark_removed' },
    ],
    [
      'an unknown subscription key on a current-key row',
      { subscription: { ...SUBSCRIPTION, applicationServerKey: null } },
      { kind: 'none' },
    ],
    [
      'an unknown subscription key on an old-key row',
      {
        devices: { devices: [{ ...mine, currentKey: false }], state: 'listed' },
        subscription: { ...SUBSCRIPTION, applicationServerKey: null },
      },
      { kind: 'resubscribe', reason: 'key_changed' },
    ],
    [
      'an unknown subscription key with no row',
      {
        devices: { devices: [], state: 'listed' },
        subscription: { ...SUBSCRIPTION, applicationServerKey: null },
      },
      { kind: 'mark_removed' },
    ],
    [
      'an endpoint spelled differently from the host’s and the record’s',
      {
        record: { endpoint: 'https://Push.Example/this', state: 'on' },
        subscription: { ...SUBSCRIPTION, endpoint: 'https://PUSH.example/this' },
      },
      { kind: 'none' },
    ],
    ['no record', { record: null }, { kind: 'none' }],
    ['a removed record', { record: { state: 'removed' } }, { kind: 'none' }],
    ['permission not granted', { permission: 'default' }, { kind: 'none' }],
    ['status not ready', { status: { state: 'key_unusable' } }, { kind: 'none' }],
    ['push not supported', { pushSupported: false }, { kind: 'none' }],
  ])('%s', (_name, overrides, action) => {
    expect(decideHeal({ ...base, ...overrides })).toStrictEqual(action);
  });
});

import { describe, expect, test } from 'bun:test';

import { normalizePushEndpoint, serializePushEndpoint } from './push-endpoint';

describe('normalizePushEndpoint', () => {
  test('accepts each push service host and answers the parser serialization', () => {
    for (const endpoint of [
      'https://web.push.apple.com/QGuQyavXutnMH4Hp2s',
      'https://api.push.apple.com/3/device/abc',
      'https://fcm.googleapis.com/fcm/send/dKz:APA91b',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ]) {
      expect(normalizePushEndpoint(endpoint)).toBe(endpoint);
    }
  });

  test('lowercases the host and drops an explicit default port', () => {
    expect(normalizePushEndpoint('https://WEB.Push.Apple.COM/abc')).toBe(
      'https://web.push.apple.com/abc',
    );
    expect(normalizePushEndpoint('https://web.push.apple.com:443/abc')).toBe(
      'https://web.push.apple.com/abc',
    );
  });

  test('refuses a scheme other than https', () => {
    expect(normalizePushEndpoint('http://web.push.apple.com/abc')).toBeUndefined();
    expect(normalizePushEndpoint('wss://web.push.apple.com/abc')).toBeUndefined();
  });

  test('refuses a port other than the default', () => {
    expect(normalizePushEndpoint('https://web.push.apple.com:8443/abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://web.push.apple.com:80/abc')).toBeUndefined();
  });

  test('refuses a user or password', () => {
    expect(normalizePushEndpoint('https://user@web.push.apple.com/abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://user:pw@web.push.apple.com/abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://:pw@web.push.apple.com/abc')).toBeUndefined();
  });

  test('refuses a fragment, even an empty one', () => {
    expect(normalizePushEndpoint('https://web.push.apple.com/abc#x')).toBeUndefined();
    expect(normalizePushEndpoint('https://web.push.apple.com/abc#')).toBeUndefined();
  });

  test('refuses look-alike and suffixed hosts', () => {
    for (const endpoint of [
      'https://evilpush.apple.com/abc',
      'https://push.apple.com/abc',
      'https://push.apple.com.evil.net/abc',
      'https://web.push.apple.com.evil.net/abc',
      'https://fcm.googleapis.com.evil.net/abc',
      'https://evil.fcm.googleapis.com/abc',
      'https://evilpush.services.mozilla.com/abc',
      'https://push.services.mozilla.com/abc',
      'https://evilnotify.windows.com/abc',
      'https://notify.windows.com/abc',
      'https://.push.apple.com/abc',
      'https://a..push.apple.com/abc',
    ]) {
      expect(normalizePushEndpoint(endpoint)).toBeUndefined();
    }
  });

  test('refuses a host with a trailing dot', () => {
    expect(normalizePushEndpoint('https://web.push.apple.com./abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://fcm.googleapis.com./abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://a.notify.windows.com./abc')).toBeUndefined();
  });

  test('refuses IP literals', () => {
    for (const endpoint of [
      'https://17.188.143.0/abc',
      'https://[::1]/abc',
      'https://127.0.0.1/abc',
      'https://0x7f000001/abc',
    ]) {
      expect(normalizePushEndpoint(endpoint)).toBeUndefined();
    }
  });

  test('refuses what does not parse', () => {
    expect(normalizePushEndpoint('')).toBeUndefined();
    expect(normalizePushEndpoint('web.push.apple.com/abc')).toBeUndefined();
    expect(normalizePushEndpoint('https://')).toBeUndefined();
  });

  test('accepts 1024 serialized characters and refuses 1025', () => {
    const base = 'https://web.push.apple.com/';
    expect(normalizePushEndpoint(base + 'a'.repeat(1024 - base.length))).toHaveLength(1024);
    expect(normalizePushEndpoint(base + 'a'.repeat(1025 - base.length))).toBeUndefined();
  });

  test('measures the serialized length, not the input length', () => {
    const base = 'https://web.push.apple.com/';
    // Each space serializes as %20, so 340 of them grow past the limit.
    expect(normalizePushEndpoint(`${base}${' '.repeat(340)}x`)).toBeUndefined();
  });
});

describe('serializePushEndpoint', () => {
  test('answers the parser serialization without the allowlist, or undefined', () => {
    expect(serializePushEndpoint('https://WEB.push.apple.com:443/abc')).toBe(
      'https://web.push.apple.com/abc',
    );
    expect(serializePushEndpoint('https://push.example.net/abc')).toBe(
      'https://push.example.net/abc',
    );
    expect(serializePushEndpoint('not a url')).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';

import { parsePushEndpointInput, parsePushKindInput, parsePushSubscribeInput } from './push-input';

const SUBSCRIBE = {
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  endpoint: 'https://web.push.apple.com/abc',
  label: 'Phone',
  p256dh: 'BCVxsr7N',
  serverKey: 'BP4z9KsN',
};

describe('the push server functions validate their input structure', () => {
  test('subscribe takes the subscription, the key it used, and a label', () => {
    expect(parsePushSubscribeInput(SUBSCRIBE)).toEqual(SUBSCRIBE);
    // A label the channel will normalize, and keys it will judge, are well-formed here.
    expect(parsePushSubscribeInput({ ...SUBSCRIBE, label: '', p256dh: 'x' })).toMatchObject({
      label: '',
    });
    for (const input of [
      {},
      { ...SUBSCRIBE, endpoint: 7 },
      { ...SUBSCRIBE, extra: true },
      Object.fromEntries(Object.entries(SUBSCRIBE).filter(([name]) => name !== 'serverKey')),
    ]) {
      expect(() => parsePushSubscribeInput(input)).toThrow(
        expect.objectContaining({ code: 'validation' }),
      );
    }
  });

  test('subscribe bounds each field before the channel reads it', () => {
    const longest = {
      auth: 'a'.repeat(256),
      endpoint: 'e'.repeat(2048),
      label: 'l'.repeat(1000),
      p256dh: 'p'.repeat(256),
      serverKey: 's'.repeat(256),
    };
    expect(parsePushSubscribeInput(longest)).toEqual(longest);
    for (const [name, value] of Object.entries(longest)) {
      expect(() => parsePushSubscribeInput({ ...longest, [name]: `${value}x` })).toThrow(
        expect.objectContaining({ code: 'validation' }),
      );
    }
  });

  test('unsubscribe and send test take one endpoint', () => {
    expect(parsePushEndpointInput({ endpoint: 'https://web.push.apple.com/abc' })).toEqual({
      endpoint: 'https://web.push.apple.com/abc',
    });
    for (const input of [{}, { endpoint: null }, { endpoint: 'x', other: 1 }]) {
      expect(() => parsePushEndpointInput(input)).toThrow(
        expect.objectContaining({ code: 'validation' }),
      );
    }
  });

  test('subscribe takes muted as a bounded list of names, which the channel filters', () => {
    const muted = ['decisions', 'retired_kind'];
    expect(parsePushSubscribeInput({ ...SUBSCRIBE, muted })).toEqual({ ...SUBSCRIBE, muted });
    expect(
      parsePushSubscribeInput({ ...SUBSCRIBE, muted: Array(16).fill('k'.repeat(64)) }),
    ).toMatchObject({ muted: expect.any(Array) });
    for (const bad of ['decisions', [null], Array(17).fill('k'), ['k'.repeat(65)]]) {
      expect(() => parsePushSubscribeInput({ ...SUBSCRIBE, muted: bad })).toThrow(
        expect.objectContaining({ code: 'validation' }),
      );
    }
  });

  test('set kind takes one endpoint, one known kind, and whether it is muted', () => {
    const input = {
      endpoint: 'https://web.push.apple.com/abc',
      kind: 'decisions' as const,
      muted: true,
    };
    expect(parsePushKindInput(input)).toEqual(input);
    for (const bad of [
      { ...input, kind: 'retired_kind' },
      { ...input, muted: 'yes' },
      { endpoint: input.endpoint, kind: 'decisions' },
      { ...input, more: 1 },
    ]) {
      expect(() => parsePushKindInput(bad)).toThrow(
        expect.objectContaining({ code: 'validation' }),
      );
    }
  });
});

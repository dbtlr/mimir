import { describe, expect, it } from 'vitest';

import { clickTarget, mapPush } from '../lib/push-notification';

const ORIGIN = 'https://mimir.example.test';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app_badge: 3,
    notification: {
      body: 'MMR-12 needs a decision.',
      dir: 'ltr',
      lang: 'en',
      navigate: `${ORIGIN}/p/MMR/tasks/12`,
      tag: 'decision:MMR-12',
      title: 'Decision needed',
    },
    web_push: 8030,
    ...overrides,
  });
}

describe('mapPush', () => {
  it('maps a pushed notification and its badge', () => {
    const mapped = mapPush(payload(), ORIGIN);
    expect(mapped.title).toBe('Decision needed');
    expect(mapped.appBadge).toBe(3);
    expect(mapped.options).toEqual({
      badge: '/icons/mimir.svg',
      body: 'MMR-12 needs a decision.',
      data: { navigate: `${ORIGIN}/p/MMR/tasks/12` },
      dir: 'ltr',
      icon: '/icons/mimir.svg',
      lang: 'en',
      renotify: true,
      tag: 'decision:MMR-12',
    });
  });

  it('maps a test push, which carries no badge', () => {
    const mapped = mapPush(
      JSON.stringify({
        notification: {
          body: 'Notifications reach this device.',
          dir: 'ltr',
          lang: 'en',
          navigate: `${ORIGIN}/`,
          tag: 'test',
          title: 'Mimir test notification',
        },
        web_push: 8030,
      }),
      ORIGIN,
    );
    expect(mapped.options.tag).toBe('test');
    expect(mapped.appBadge).toBeUndefined();
  });

  it.each([
    ['missing data', undefined],
    ['empty data', ''],
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '42'],
    ['JSON without a notification', '{"web_push":8030}'],
    ['a notification with no title', '{"notification":{"body":"x"}}'],
  ])('shows a generic notification for %s', (_label, data) => {
    const mapped = mapPush(data, ORIGIN);
    expect(mapped.title).toBe('Mimir');
    expect(mapped.options.body).toBe('Something needs you.');
    expect(mapped.options.data).toEqual({ navigate: `${ORIGIN}/` });
    // Chrome throws on renotify without a tag.
    expect(mapped.options.tag).toBe('mimir');
    expect(mapped.options.renotify).toBe(true);
    expect(mapped.appBadge).toBeUndefined();
  });

  it.each([
    [0, 0],
    [7, 7],
    [-1, undefined],
    [1.5, undefined],
    ['4', undefined],
    [null, undefined],
  ])('honors app_badge %j as %j', (given, expected) => {
    expect(mapPush(payload({ app_badge: given }), ORIGIN).appBadge).toBe(expected);
  });

  it('ignores a badge nested inside the notification', () => {
    const mapped = mapPush(
      JSON.stringify({
        notification: { app_badge: 9, tag: 't', title: 'T' },
      }),
      ORIGIN,
    );
    expect(mapped.appBadge).toBeUndefined();
  });

  it('keeps a pushed notification but falls back for a cross-origin navigate', () => {
    const mapped = mapPush(
      payload({
        notification: { navigate: 'https://evil.example/x', tag: 'a:b', title: 'Hello' },
      }),
      ORIGIN,
    );
    expect(mapped.title).toBe('Hello');
    expect(mapped.options.data).toEqual({ navigate: `${ORIGIN}/` });
  });
});

describe('clickTarget', () => {
  it('accepts a same-origin navigate', () => {
    expect(clickTarget({ navigate: `${ORIGIN}/p/MMR/tasks` }, ORIGIN)).toBe(
      `${ORIGIN}/p/MMR/tasks`,
    );
  });

  it.each([
    ['another origin', { navigate: 'https://evil.example/' }],
    ['a different port', { navigate: 'https://mimir.example.test:8443/' }],
    ['a script URL', { navigate: ['java', 'script:alert(1)'].join('') }],
    ['not a URL', { navigate: 'nope' }],
    ['a non-string', { navigate: 5 }],
    ['no navigate', {}],
    ['no data', undefined],
    ['null data', null],
  ])('falls back to the origin root for %s', (_label, data) => {
    expect(clickTarget(data, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

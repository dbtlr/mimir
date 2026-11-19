import { describe, expect, test } from 'bun:test';

import { mapPush } from '../lib/push-notification';
import type { NotificationEvent } from './notification-events';
import { eventPayload, testPayload } from './push-payload';
import type { PushPayload } from './push-payload';

/*
 * The payload the host pushes, read by the service worker's mapping (MMR-710).
 * The worker reads each field by hand, so this binds the two sides: a renamed
 * or moved field fails here. Only the test imports the server; the worker
 * bundle never does.
 */

const CONSOLE = 'https://mimir.example';

const event: NotificationEvent = {
  body: 'Which store backs the cache?',
  ids: ['MMR-d1'],
  kind: 'decisions',
  needs_you: 4,
  project: 'MMR',
  target: '/p/MMR/d1?mode=decisions',
  title: 'Decision on Cache rework',
};

/** The bytes the push channel sends, as the worker's `event.data.text()` reads them. */
const pushed = (payload: PushPayload) => JSON.stringify(payload);

describe('the worker reads the host’s push payload', () => {
  test('an event push shows its title, body, and tag, opens its record, and sets the badge', () => {
    const mapped = mapPush(pushed(eventPayload(event, CONSOLE)), CONSOLE);
    expect(mapped.title).toBe('Decision on Cache rework');
    expect(mapped.options).toMatchObject({
      body: 'Which store backs the cache?',
      data: { navigate: 'https://mimir.example/p/MMR/d1?mode=decisions' },
      tag: 'decisions:/p/MMR/d1?mode=decisions',
    });
    expect(mapped.appBadge).toBe(4);
  });

  test('the worker reads the language and direction from the fields the host writes', () => {
    // The host writes en/ltr, the worker's own defaults, so equal values prove
    // nothing. The host must write both fields, and the worker must read other
    // values from them rather than fall back to its defaults.
    const payload = eventPayload(event, CONSOLE);
    expect(payload.notification).toMatchObject({ dir: 'ltr', lang: 'en' });
    const other = { ...payload, notification: { ...payload.notification, dir: 'rtl', lang: 'he' } };
    expect(mapPush(JSON.stringify(other), CONSOLE).options).toMatchObject({
      dir: 'rtl',
      lang: 'he',
    });
  });

  test('an event push with nothing left needing you clears the badge', () => {
    const mapped = mapPush(pushed(eventPayload({ ...event, needs_you: 0 }, CONSOLE)), CONSOLE);
    expect(mapped.appBadge).toBe(0);
  });

  test('a test push shows its notification, opens the console, and leaves the badge alone', () => {
    const mapped = mapPush(pushed(testPayload(CONSOLE)), CONSOLE);
    expect(mapped.title).toBe('Mimir test notification');
    expect(mapped.options).toMatchObject({
      body: 'Notifications reach this device.',
      data: { navigate: 'https://mimir.example/' },
      tag: 'test',
    });
    expect(mapped.appBadge).toBeUndefined();
  });
});

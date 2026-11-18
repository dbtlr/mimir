import { describe, expect, test } from 'bun:test';

import { BODY_LIMIT, TITLE_LIMIT } from './notification-events';
import type { NotificationEvent } from './notification-events';
import { eventPayload, testPayload } from './push-payload';
import { PUSH_PLAINTEXT_LIMIT } from './push-protocol';

const CONSOLE = 'https://mimir.example';

const event = (change: Partial<NotificationEvent> = {}): NotificationEvent => ({
  body: 'Which store backs the cache?',
  ids: ['MMR-d1'],
  kind: 'decisions',
  needs_you: 4,
  project: 'MMR',
  target: '/p/MMR/d1?mode=decisions',
  title: 'Decision on Cache rework',
  ...change,
});

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('eventPayload', () => {
  test('is a declarative push that opens the record, with the badge at the top level', () => {
    expect(eventPayload(event(), CONSOLE)).toEqual({
      app_badge: 4,
      notification: {
        body: 'Which store backs the cache?',
        dir: 'ltr',
        lang: 'en',
        navigate: 'https://mimir.example/p/MMR/d1?mode=decisions',
        tag: 'decisions:/p/MMR/d1?mode=decisions',
        title: 'Decision on Cache rework',
      },
      web_push: 8030,
    });
  });

  test('joins the target to a loopback development origin with a port', () => {
    const payload = eventPayload(
      event({ kind: 'task_blocked', target: '/p/MMR/708' }),
      'http://127.0.0.1:64647',
    );
    expect(payload.notification).toMatchObject({
      navigate: 'http://127.0.0.1:64647/p/MMR/708',
      tag: 'task_blocked:/p/MMR/708',
    });
  });

  test('carries a zero needs-you count as a zero badge', () => {
    expect(eventPayload(event({ needs_you: 0 }), CONSOLE).app_badge).toBe(0);
  });

  test('stays far below the one-record limit at the longest title and body', () => {
    // A control character is the costliest: JSON writes it as six bytes.
    const worst = event({
      body: '\u0001'.repeat(BODY_LIMIT),
      target: '/p/MMRX/d123456789?mode=decisions',
      title: '\u0001'.repeat(TITLE_LIMIT),
    });
    expect(byteLength(eventPayload(worst, CONSOLE))).toBeLessThan(PUSH_PLAINTEXT_LIMIT / 1.5);
    const wide = event({ body: '語'.repeat(BODY_LIMIT), title: '😀'.repeat(TITLE_LIMIT / 2) });
    expect(byteLength(eventPayload(wide, CONSOLE))).toBeLessThan(PUSH_PLAINTEXT_LIMIT / 2);
  });
});

describe('testPayload', () => {
  test('opens the console root, tagged test, with no badge', () => {
    expect(testPayload(CONSOLE)).toEqual({
      notification: {
        body: 'Notifications reach this device.',
        dir: 'ltr',
        lang: 'en',
        navigate: 'https://mimir.example/',
        tag: 'test',
        title: 'Mimir test notification',
      },
      web_push: 8030,
    });
  });
});

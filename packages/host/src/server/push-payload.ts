import type { NotificationEvent } from './notification-events';

/*
 * The Web Push payload (ADR 0045, the MMR-709 refinement): a Declarative Web
 * Push message, which iOS shows and opens without the service worker, and
 * which the service worker's `push` handler parses for other browsers.
 */

/** The notification a push shows. `navigate` is absolute, as the format requires. */
export type PushNotification = {
  title: string;
  body: string;
  navigate: string;
  tag: string;
  lang: 'en';
  dir: 'ltr';
};

/** One push's JSON. `app_badge` is the needs-you count; a test push has none. */
export type PushPayload = {
  web_push: 8030;
  notification: PushNotification;
  app_badge?: number;
};

/** The magic number that marks a push as declarative. */
const DECLARATIVE = 8030;

function notification(
  fields: Pick<PushNotification, 'body' | 'tag' | 'title'>,
  path: string,
  consoleUrl: string,
): PushNotification {
  return { ...fields, dir: 'ltr', lang: 'en', navigate: new URL(path, consoleUrl).href };
}

/** The payload of a notification event: it opens the event's target on the console. */
export function eventPayload(event: NotificationEvent, consoleUrl: string): PushPayload {
  return {
    app_badge: event.needs_you,
    notification: notification(
      { body: event.body, tag: `${event.kind}:${event.target}`, title: event.title },
      event.target,
      consoleUrl,
    ),
    web_push: DECLARATIVE,
  };
}

/** The payload of a test push: it opens the console, and sets no badge. */
export function testPayload(consoleUrl: string): PushPayload {
  return {
    notification: notification(
      { body: 'Notifications reach this device.', tag: 'test', title: 'Mimir test notification' },
      '/',
      consoleUrl,
    ),
    web_push: DECLARATIVE,
  };
}
